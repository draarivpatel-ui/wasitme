/**
 * `wasitme exclude add|list|remove`: keep days, projects or entry points out of the analysis (METHOD.md §2, Exclusions).
 *
 *   wasitme exclude list
 *   wasitme exclude add    <project folder> | --dates FROM..TO | --entrypoint NAME[*]
 *   wasitme exclude remove <project folder> | --dates FROM..TO | --entrypoint NAME[*] | --all
 *
 * The list lives in `state/exclude.json` (mode 0600, local only). A project is matched by its salted id, so the folder's
 * name is never stored and never printed; it is hashed here with the local salt, in every encoding the agents use
 * (store/exclude.ts `projectKeysForCwd`). Dates are inclusive local days (`2026-09-01..2026-09-03`, or one day).
 * Exclusions apply when results are next computed (the next scan), never to what is already stored.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { readOwnJson, writeAtomic } from "../../store/atomic.js";
import { loadExclude, noExclusions, projectKeysForCwd, type ExcludeList } from "../../store/exclude.js";
import { ensureHome, HomeError, homePaths, wasitmeHome } from "../../store/home.js";
import { loadSalt } from "../../store/salt.js";
import { makeHash } from "../../util.js";
import { has, parseArgs, str, UsageError } from "../args.js";
import type { CliContext } from "../context.js";
import { CommandFailure, emit, emitJson } from "./common.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY = /^[A-Za-z0-9._:-]{1,40}\*?$/;

interface Doc {
  dates: { from: string; to: string }[];
  projects: string[];
  entrypoints: string[];
  /**
   * The ids of each excluded folder, one group per `exclude add <folder>` (a folder is stored as 2–6 ids: one per way
   * the agents spell its path). Only for counting folders in `list`; matching uses `projects`. store/exclude.ts ignores
   * the key, so an older engine reads the file unchanged.
   */
  folders: string[][];
}

const PROJECT_ID = /^p-[0-9a-f]{12}$/;

/** The folder groups stored beside the list (absent in an older file: then every id is "ungrouped"). */
function foldersOf(path: string, projects: ReadonlySet<string>): string[][] {
  const raw = readOwnJson(path, 1 << 20) as { folders?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.folders)) return [];
  return raw.folders.flatMap((g) => (Array.isArray(g) && g.length > 0 && g.every((k) => typeof k === "string" && PROJECT_ID.test(k) && projects.has(k)) ? [[...g as string[]]] : []));
}

function docOf(ex: ExcludeList, folders: string[][] = []): Doc {
  return { dates: ex.dates.map((d) => ({ ...d })), projects: [...ex.projects].sort(), entrypoints: [...ex.entrypoints], folders };
}

function parseDates(v: string): { from: string; to: string } {
  const [a, b, ...more] = v.split("..");
  const from = a ?? "", to = b ?? a ?? "";
  if (more.length > 0 || !DAY.test(from) || !DAY.test(to) || !Number.isFinite(Date.parse(`${from}T00:00:00Z`)) || !Number.isFinite(Date.parse(`${to}T00:00:00Z`)) || new Date(`${from}T00:00:00Z`).toISOString().slice(0, 10) !== from || new Date(`${to}T00:00:00Z`).toISOString().slice(0, 10) !== to) {
    throw new UsageError("--dates must be one day or a range of days, such as 2026-09-01 or 2026-09-01..2026-09-03");
  }
  return from <= to ? { from, to } : { from: to, to: from };
}

function projectKeys(ctx: CliContext, folder: string): string[] {
  const p = homePaths(wasitmeHome(ctx.env));
  let salt: string;
  try {
    salt = loadSalt(p.salt, { create: false });
  } catch (e) {
    if (e instanceof HomeError) throw new CommandFailure("wasitme has no local id key yet, so it cannot match a project folder. Run wasitme scan first, then try again.");
    throw e;
  }
  const hash = makeHash(salt);
  const abs = resolve(process.cwd(), folder);
  const forms = new Set<string>([abs]);
  try { forms.add(realpathSync(abs)); } catch { /* the folder may be gone; its recorded id is still matched */ }
  return [...new Set([...forms].flatMap((f) => projectKeysForCwd(hash, f)))];
}

function save(ctx: CliContext, d: Doc): void {
  const p = homePaths(wasitmeHome(ctx.env));
  ensureHome(p);
  const dates = [...d.dates].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1));
  const projects = new Set(d.projects);
  const folders = d.folders.filter((g) => g.every((k) => projects.has(k))).map((g) => [...g].sort());
  writeAtomic(p.exclude, `${JSON.stringify({ dates, projects: [...projects].sort(), entrypoints: [...new Set(d.entrypoints)].sort(), folders }, null, 2)}\n`);
}

function describe(d: Doc): string[] {
  const lines: string[] = [];
  if (d.dates.length > 0) lines.push(`dates        ${d.dates.map((x) => (x.from === x.to ? x.from : `${x.from} to ${x.to}`)).join(", ")}`);
  if (d.projects.length > 0) {
    const grouped = new Set(d.folders.flat());
    const loose = d.projects.filter((k) => !grouped.has(k)).length;
    const parts = [d.folders.length > 0 ? `${d.folders.length} folder${d.folders.length === 1 ? "" : "s"}` : "", loose > 0 ? `${loose} id${loose === 1 ? "" : "s"} from an older list` : ""].filter(Boolean);
    lines.push(`projects     ${parts.join(", ")} (ids only; folder names are never stored)`);
  }
  if (d.entrypoints.length > 0) lines.push(`entrypoints  ${d.entrypoints.join(", ")}`);
  return lines;
}

const NOTE = "Takes effect at the next scan (wasitme scan).";

export function exclude(ctx: CliContext, argv: readonly string[]): number {
  const [sub, ...rest] = argv;
  if (sub !== "add" && sub !== "list" && sub !== "remove") throw new UsageError("usage: wasitme exclude add|list|remove");
  const p = parseArgs(rest, { bool: sub === "remove" ? ["all"] : [], value: ["dates", "entrypoint"], positionals: 1 });
  const home = homePaths(wasitmeHome(ctx.env));
  const current = loadExclude(home.exclude);
  if (sub === "list") {
    if (p.pos.length > 0 || has(p, "dates") || has(p, "entrypoint")) throw new UsageError("usage: wasitme exclude list");
    if (current.error !== null) throw new CommandFailure(`the exclude list is ${current.error}; nothing is excluded until it is fixed or removed (wasitme doctor shows the file's state)`);
    const d = docOf(current, foldersOf(home.exclude, current.projects));
    if (has(p, "json")) {
      emitJson(ctx, { schema: "wasitme.exclude/1", dates: d.dates, projects: d.projects.length, folders: d.folders.length, entrypoints: d.entrypoints });
      return 0;
    }
    const lines = describe(d);
    emit(ctx, lines.length === 0 ? "Nothing is excluded.\n" : `Excluded from the analysis:\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
    return 0;
  }
  if (current.error !== null) {
    throw new CommandFailure(`the exclude list is ${current.error}; wasitme will not change it. Fix or delete state/exclude.json in the wasitme folder first.`);
  }
  const d = docOf(current.error === null ? current : noExclusions(), foldersOf(home.exclude, current.projects));
  const dates = str(p, "dates"), entry = str(p, "entrypoint"), folder = p.pos[0];
  const given = [dates !== undefined, entry !== undefined, folder !== undefined, has(p, "all")].filter(Boolean).length;
  if (given !== 1) throw new UsageError(sub === "add" ? "give exactly one of: a project folder, --dates, --entrypoint" : "give exactly one of: a project folder, --dates, --entrypoint, --all");
  const before = JSON.stringify(d);
  if (has(p, "all")) {
    d.dates = []; d.projects = []; d.entrypoints = []; d.folders = [];
  } else if (dates !== undefined) {
    const r = parseDates(dates);
    if (sub === "add") { if (!d.dates.some((x) => x.from === r.from && x.to === r.to)) d.dates.push(r); }
    else d.dates = d.dates.filter((x) => !(x.from === r.from && x.to === r.to));
  } else if (entry !== undefined) {
    if (!ENTRY.test(entry)) throw new UsageError("--entrypoint must be a short name such as sdk-cli or sdk-*");
    if (sub === "add") { if (!d.entrypoints.includes(entry)) d.entrypoints.push(entry); }
    else d.entrypoints = d.entrypoints.filter((x) => x !== entry);
  } else if (folder !== undefined) {
    const keys = projectKeys(ctx, folder);
    if (sub === "add") {
      d.projects = [...new Set([...d.projects, ...keys])];
      if (!d.folders.some((g) => g.length === keys.length && g.every((k) => keys.includes(k)))) d.folders.push(keys);
      // A folder that is not there may be a project since deleted (its recorded sessions still match), or a typo.
      if (!existsSync(resolve(process.cwd(), folder))) ctx.stderr.write("wasitme: there is no folder at that path now. If it was a project folder you have since removed, its recorded sessions are excluded; otherwise check the path (it is matched as given, relative to this folder).\n");
    } else {
      d.projects = d.projects.filter((x) => !keys.includes(x));
      d.folders = d.folders.filter((g) => !g.some((k) => keys.includes(k)));
    }
  }
  const changed = JSON.stringify(d) !== before;
  if (changed) save(ctx, d);
  const word = sub === "add" ? (changed ? "Added" : "Already excluded") : (changed ? "Removed" : "Nothing to remove");
  if (has(p, "json")) {
    emitJson(ctx, { schema: "wasitme.exclude/1", changed, dates: d.dates, projects: d.projects.length, folders: d.folders.length, entrypoints: d.entrypoints });
    return 0;
  }
  emit(ctx, `${word}. ${changed ? NOTE : ""}`.trimEnd() + "\n");
  return 0;
}
