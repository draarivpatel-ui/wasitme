/**
 * The Node permission flag (D49 / S-NODEPERM §3.1): Node 22.12 knows only `--experimental-permission` and dies with
 * exit 9 on `--permission`; later releases take `--permission`. So the flag is FEATURE-TESTED, never inferred from a
 * version or from `--allow-net` in `node --help`: run `<node> --permission -e 0`, else
 * `<node> --experimental-permission -e 0`, and record the working spelling (or null) in `~/.wasitme/engine.json`
 * together with the node version it was tested on, so the LaunchAgent and the hook scripts read it with `sed` and a
 * node upgrade triggers a re-test.
 *
 * The probe only runs outside the sandbox (a sandboxed process may not start children — and being sandboxed already
 * proves the flag works), never in `--read-only`, and only when engine.json lacks a result for this node version.
 */
// wasitme:allow-child_process -- fixed argv (`<this node> <flag> -e 0`), empty env, no log-derived input, 5 s timeout
import { spawnSync } from "node:child_process";
import { readOwnFile, writeAtomic } from "./atomic.js";

export type PermissionFlag = "--permission" | "--experimental-permission";

/** True when this process runs under the Node permission model. */
export function sandboxed(): boolean {
  const p = (process as unknown as { permission?: unknown }).permission;
  return typeof p === "object" && p !== null;
}

/** Feature-test the permission flag on `execPath` (default: this node). */
export function probePermissionFlag(execPath: string = process.execPath): PermissionFlag | null {
  for (const flag of ["--permission", "--experimental-permission"] as const) {
    try {
      const r = spawnSync(execPath, [flag, "-e", "0"], { stdio: "ignore", timeout: 5000, env: {} });
      if (r.status === 0) return flag;
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

export interface EngineJsonResult {
  flag: PermissionFlag | null;
  /** probed: tested now and written; recorded: engine.json already had a result for this node; skipped: not tested. */
  how: "probed" | "recorded" | "skipped";
}

/**
 * Make sure engine.json records the feature test for this node. Keeps every other key (the installer owns them) and
 * the one-key-per-line layout the hook scripts read with sed. A file that is not ours or not JSON is left alone.
 */
export function recordPermissionFlag(path: string, opts: { probe?: () => PermissionFlag | null; nodeVersion?: string } = {}): EngineJsonResult {
  const node = opts.nodeVersion ?? process.version;
  const r = readOwnFile(path, 1 << 20);
  let doc: Record<string, unknown> = {};
  if (r.buf) {
    try {
      const v = JSON.parse(r.buf.toString("utf8")) as unknown;
      if (typeof v !== "object" || v === null || Array.isArray(v)) return { flag: null, how: "skipped" };
      doc = v as Record<string, unknown>;
    } catch {
      return { flag: null, how: "skipped" };
    }
  } else if (r.why !== "missing") {
    return { flag: null, how: "skipped" };
  }
  const known = doc.permissionFlag;
  if (doc.permissionNode === node && (known === null || known === "--permission" || known === "--experimental-permission")) {
    return { flag: known as PermissionFlag | null, how: "recorded" };
  }
  if (sandboxed()) return { flag: null, how: "skipped" };
  const flag = (opts.probe ?? probePermissionFlag)();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (k !== "permissionFlag" && k !== "permissionNode") out[k] = v;
  out.permissionFlag = flag;
  out.permissionNode = node;
  writeAtomic(path, `${JSON.stringify(out, null, 2)}\n`);
  return { flag, how: "probed" };
}
