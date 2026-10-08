/**
 * File-system emulation for portability tests: makes this Mac behave like the file systems the engine meets elsewhere.
 * Loaded with `node --import dist/test/support/fs-emulate.js` and configured by WASITME_TEST_FS, a `;`-separated list:
 *
 *   birth=real          birth times as the file system reports them (default)
 *   birth=linux         as Linux records them: when the file was written, and never moved afterwards. A file written
 *                       or copied and then given an old mtime keeps the later birth time (APFS moves it back to the
 *                       mtime), and a later append moves the mtime past it again
 *   birth=copy          a copied or restored tree in the worst case: every birth time lies between the old mtime the
 *                       copy kept and the copy itself, in an order unrelated to when the files were created
 *   birth=none          no birth time recorded (0), as on file systems without one
 *   dirs=real           directory listings as Node returns them
 *   dirs=reverse        every listing reversed
 *   dirs=shuffle:<n>    every listing shuffled by a seeded generator, each call in a different order: nothing may
 *                       depend on the order a listing comes in
 *   ino=real            inode numbers as the file system reports them (APFS never reuses one)
 *   ino=reuse           as ext4 does: a deleted file's inode number goes to the next new file, lowest first
 *
 * An emulated birth time is fixed the first time this process sees the file, as a real one is, and forgotten when the
 * file is deleted (rmSync, unlinkSync, rmdirSync and their promise forms). A file is told apart by device, inode and
 * real birth time, never by inode alone.
 * Covers the listing and stat calls the engine makes (readdir and stat, sync, callback and promise forms);
 * fs-portability.test.ts checks that the engine uses no other listing call and reads birth times in one place only.
 * Test-only: nothing under src/ imports it.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve, sep } from "node:path";

export interface FsEmulation {
  birth: "real" | "linux" | "copy" | "none";
  dirs: "real" | "reverse" | `shuffle:${number}`;
  ino: "real" | "reuse";
}

export function parseEmulation(spec: string | undefined): FsEmulation {
  const out: FsEmulation = { birth: "real", dirs: "real", ino: "real" };
  for (const part of (spec ?? "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split("=", 2) as [string, string | undefined];
    if (k === "birth" && (v === "real" || v === "linux" || v === "copy" || v === "none")) out.birth = v;
    else if (k === "dirs" && (v === "real" || v === "reverse" || /^shuffle:\d+$/.test(v ?? ""))) out.dirs = v as FsEmulation["dirs"];
    else if (k === "ino" && (v === "real" || v === "reuse")) out.ino = v;
    else throw new Error(`WASITME_TEST_FS: unknown setting "${part}"`);
  }
  return out;
}

/** 32-bit FNV-1a. */
function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

type AnyFn = (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Install the emulation in this process; returns a function that undoes it. */
export function installFsEmulation(e: FsEmulation): () => void {
  const saved: [Mutable, string, unknown][] = [];
  const patch = (obj: Mutable, name: string, make: (orig: AnyFn) => AnyFn): void => {
    const orig = obj[name] as AnyFn | undefined;
    if (typeof orig !== "function") return;
    saved.push([obj, name, orig]);
    obj[name] = make(orig);
  };
  const fsm = fs as unknown as Mutable;
  const promises = fs.promises as unknown as Mutable;

  if (e.dirs !== "real") {
    let state = e.dirs === "reverse" ? 1 : Number(e.dirs.slice("shuffle:".length)) >>> 0 || 1;
    const rnd = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const reorder = <T>(list: T): T => {
      if (!Array.isArray(list)) return list;
      const a = [...list];
      if (e.dirs === "reverse") return a.reverse() as T;
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a as T;
    };
    patch(fsm, "readdirSync", (orig) => function (this: unknown, ...args) { return reorder(orig.apply(this, args)); });
    patch(fsm, "readdir", (orig) => function (this: unknown, ...args) {
      const cb = args.pop() as AnyFn;
      return orig.call(this, ...args, (err: unknown, list: unknown) => cb(err, err ? list : reorder(list)));
    });
    patch(promises, "readdir", (orig) => async function (this: unknown, ...args) { return reorder(await orig.apply(this, args)); });
  }

  if (e.birth !== "real" || e.ino === "reuse") {
    const define = (s: Mutable, k: string, v: unknown): void => { Object.defineProperty(s, k, { value: v, configurable: true, enumerable: true, writable: true }); };
    const realLstat = fs.lstatSync;
    /**
     * Which file a stat is about: device, inode and real birth time. The inode alone is not enough: ext4 hands a deleted
     * file's inode number to the next file it creates, and an emulated birth time kept under the number alone was
     * then served for a newer file (a GitHub Ubuntu run failed the D63 sweep under birth=copy that way, macOS never).
     */
    const identity = (s: Mutable): string => `${s.dev}:${s.ino}:${Math.floor(Number(s.birthtimeMs))}`;

    /** Emulated birth time per file, fixed the first time the file is seen (as a real one is). */
    const born = new Map<string, number>();
    /** ino=reuse: emulated inode number per file; the numbers of deleted files, lowest first, go to new files first. */
    const fakeOf = new Map<string, number>();
    const free: number[] = [];
    let next = 1;
    /** Where each file was last seen, to tell when it is deleted. */
    const pathOf = new Map<string, string>();
    // A deleted file's emulated values go with it (its inode number back to the pool); one still on disk stays.
    const release = (target: unknown): void => {
      if (typeof target !== "string") return;
      const root = resolve(target);
      for (const [id, p] of pathOf) {
        if (p !== root && !p.startsWith(root + sep)) continue;
        let still = false;
        try { still = identity(realLstat(p, { bigint: true }) as unknown as Mutable) === id; } catch { /* gone */ }
        if (still) continue;
        pathOf.delete(id);
        born.delete(id);
        const n = fakeOf.get(id);
        fakeOf.delete(id);
        if (n === undefined) continue;
        const at = free.findIndex((x) => x > n);
        free.splice(at < 0 ? free.length : at, 0, n);
      }
    };
    for (const name of ["rmSync", "unlinkSync", "rmdirSync"]) {
      patch(fsm, name, (orig) => function (this: unknown, ...args) { try { return orig.apply(this, args); } finally { release(args[0]); } });
    }
    for (const name of ["rm", "unlink", "rmdir"]) {
      patch(promises, name, (orig) => async function (this: unknown, ...args) { try { return await orig.apply(this, args); } finally { release(args[0]); } });
    }

    const fix = <T>(st: T, path?: unknown): T => {
      if (!st || typeof st !== "object") return st;
      const s = st as Mutable;
      const big = typeof s.mtimeMs === "bigint";
      const id = identity(s);
      if (typeof path === "string") pathOf.set(id, resolve(path));
      if (e.ino === "reuse") {
        let n = fakeOf.get(id);
        if (n === undefined) {
          n = free.shift() ?? next++;
          fakeOf.set(id, n);
        }
        define(s, "ino", big ? BigInt(n) : n);
      }
      if (e.birth === "real") return st;
      let ms = 0;
      if (e.birth !== "none") {
        let b = born.get(id);
        if (b === undefined) {
          const changed = Number(s.ctimeMs);
          const modified = Number(s.mtimeMs);
          // linux: when the file was written, i.e. its last inode change (an old mtime set right after creation, as a
          // copy does, moves the ctime to then). copy: anywhere between the old mtime and that change, in an order
          // unrelated to the files (a copy is born before it sets the old mtime, which changes the inode).
          b = e.birth === "linux" || !(changed - modified > 1) ? changed : modified + 1 + (fnv(id) % Math.floor(changed - modified));
          born.set(id, b);
        }
        ms = big ? Math.floor(b) : b;
      }
      define(s, "birthtimeMs", big ? BigInt(ms) : ms);
      if (big) define(s, "birthtimeNs", BigInt(ms) * 1_000_000n);
      define(s, "birthtime", new Date(ms));
      return st;
    };
    for (const name of ["statSync", "lstatSync", "fstatSync"]) {
      patch(fsm, name, (orig) => function (this: unknown, ...args) { return fix(orig.apply(this, args), args[0]); });
    }
    for (const name of ["stat", "lstat", "fstat"]) {
      patch(fsm, name, (orig) => function (this: unknown, ...args) {
        const cb = args.pop() as AnyFn;
        return orig.call(this, ...args, (err: unknown, st: unknown) => cb(err, err ? st : fix(st, args[0])));
      });
      patch(promises, name, (orig) => async function (this: unknown, ...args) { return fix(await orig.apply(this, args), args[0]); });
    }
  }

  syncBuiltinESMExports();
  return () => {
    for (const [obj, name, orig] of saved.reverse()) obj[name] = orig;
    syncBuiltinESMExports();
  };
}

// Preload use: `node --import dist/test/support/fs-emulate.js` installs what WASITME_TEST_FS asks for.
if (process.env.WASITME_TEST_FS !== undefined) installFsEmulation(parseEmulation(process.env.WASITME_TEST_FS));
