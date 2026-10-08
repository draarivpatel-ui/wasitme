/**
 * `wasitme doctor`: what state is wasitme in, and what would fix it.
 *
 *   wasitme doctor [--redacted] [--toolchain] [--repair] [--json]
 *
 * The report is numbers, versions, names from fixed lists and enums. It never prints a path (the wasitme home is shown
 * as "~/.wasitme" or "WASITME_HOME"), a prompt, a project name, a record-type name or any text from the results file:
 * log-derived keys (such as unknown record types) are reported as COUNTS only. `--redacted` is the same report plus a
 * header saying it is safe to paste into an issue; the template never asks for raw logs
 * (.github/ISSUE_TEMPLATE/bug_report.yml).
 *
 *   --toolchain   whether the macOS app can be built here (README "Install"). Runs `xcode-select -p` first, checks that
 *                 the folder it names exists, and only then asks Swift for its version, so it never triggers the
 *                 "install developer tools" dialog.
 *   --repair      fixes what the engine owns: folder and file permissions, leftover temporary files, a dead or blocking
 *                 scan lock, and a damaged index (a fresh scan rebuilds it from the stored histories). LaunchAgent
 *                 plists, the command shims and the installed versions (`versions/`, `current`, read-only on purpose,
 *                 D46) belong to the installer and are not touched here.
 *
 * Exit status: 0 when no problem was found, 1 when the report lists problems (the installer shows "attention" then), so a
 * script can tell. With `--json` it is always 0 once the report is produced: `problems` carries them, and the Mac app's
 * engine runner treats any non-zero exit as a failure.
 */
// wasitme:allow-child_process -- `doctor --toolchain` only: fixed argv (`xcode-select -p`, `swift --version`), minimal PATH, no log-derived input, 10 s timeout
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";
import { arch } from "node:os";
import { decodeState, SCAN_ERRORS } from "../../contract/vocab.js";
import { coerceDoc } from "../../output/doc.js";
import { rootLabels } from "../../output/empty.js";
import { readOwnFile, readOwnJson } from "../../store/atomic.js";
import { loadExclude } from "../../store/exclude.js";
import { ensureHome, historyExists, homePaths, wasitmeHome, type HomePaths } from "../../store/home.js";
import { acquireLock } from "../../store/lock.js";
import { errorKind, runScan } from "../../store/scan.js";
import { ENGINE_VERSION } from "../../version.js";
import { agentName } from "../../words/names.js";
import { CALIBRATION_PENDING_WORDS, STATE_WORDS } from "../../words/tokens.js";
import { has, parseArgs } from "../args.js";
import type { CliContext } from "../context.js";
import { emit, emitJson } from "./common.js";

interface Line { key: string; text: string }
interface Report {
  lines: Line[];
  problems: string[];
  repaired: string[];
}

const AGENT_ID = /^[a-z][a-z0-9-]{0,30}$/;
const SOURCE_ERRORS = ["not_found", "permission_denied", "protected_folder", "unreadable"];
const PAUSE_WHY = ["unknown_records_in_family", "unknown_records_over_2pct", "parser_changed"];
const READ_PROBLEM: Readonly<Record<string, string>> = { permission_denied: "permission denied", protected_folder: "macOS privacy protection", unreadable: "unreadable" };
/** A word from the results file, only if it is on the list; else "other" (the file is local, but the report may be pasted). */
const listed = (v: unknown, list: readonly string[]): string => (typeof v === "string" && list.includes(v) ? v : "other");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const plural = (c: number, one: string, many = `${one}s`): string => `${c} ${c === 1 ? one : many}`;

function modeOf(path: string): { exists: boolean; mode: number; symlink: boolean; owned: boolean } {
  try {
    const st = lstatSync(path);
    const me = typeof process.getuid === "function" ? process.getuid() : st.uid;
    return { exists: true, mode: st.mode & 0o777, symlink: st.isSymbolicLink(), owned: st.uid === me };
  } catch {
    return { exists: false, mode: 0, symlink: false, owned: true };
  }
}

function ageText(ms: number): string {
  if (ms < 0) return "dated in the future";
  const min = Math.round(ms / 60_000);
  if (min < 90) return `${min} min old`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h old` : `${Math.round(h / 24)} days old`;
}

function stateWord(state: string, reason: string | null): string {
  const s = decodeState(state);
  return (reason === "calibration_pending" ? CALIBRATION_PENDING_WORDS.label : STATE_WORDS[s].label).toLowerCase();
}

/**
 * A scan lock that no scan can ever take over (store/lock.ts only steals a lock it can read: a regular file it owns,
 * at most 4 KB, holding a pid): a folder, a symlink, someone else's file, an oversized file, or one it cannot read.
 * Such a lock makes every scan report "another scan is running". Null when the lock is absent or usable.
 */
export function lockProblem(path: string): string | null {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return "a symlink";
  if (st.isDirectory()) return "a folder";
  if (!st.isFile()) return "not a regular file";
  const me = typeof process.getuid === "function" ? process.getuid() : st.uid;
  if (st.uid !== me) return "owned by another user";
  if (st.size > 4096) return "too large to be a lock";
  const r = readOwnFile(path, 4096);
  if (!r.buf) return r.why === "missing" ? null : "not readable";
  return null;
}

/**
 * Move a blocking scan lock out of the way: an empty folder is removed; anything else is renamed aside (rename needs no
 * read access to the file, and nothing is deleted that wasitme did not write) and then removed if it is a plain file.
 */
function clearLock(path: string): boolean {
  try {
    if (lstatSync(path).isDirectory()) {
      try { rmdirSync(path); return true; } catch { /* not empty: rename it aside below */ }
    }
    const aside = `${path}.blocked.${process.pid}.${Date.now()}`;
    renameSync(path, aside);
    try { if (lstatSync(aside).isFile()) unlinkSync(aside); } catch { /* left aside; it no longer blocks scans */ }
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────────── the report ─────────────────────────────

function gather(ctx: CliContext, p: HomePaths, redacted: boolean): Report {
  const lines: Line[] = [];
  const problems: string[] = [];
  const add = (key: string, text: string): void => { lines.push({ key, text }); };

  const major = Number(process.versions.node.split(".")[0]);
  add("engine", `${ENGINE_VERSION}, node v${process.versions.node}, ${ctx.platform} ${arch()}`);
  if (!(major >= 22)) problems.push("Node 22 or newer is required (D24).");

  // the folder and its files
  const home = modeOf(p.home);
  if (!home.exists) {
    add("home", "not created yet (no scan has run)");
    problems.push("No results yet. Run: wasitme scan");
  } else {
    const where = redacted ? "" : ` (${ctx.env.WASITME_HOME !== undefined ? "WASITME_HOME" : "~/.wasitme"})`;
    const modeText = home.symlink ? "is a symlink" : `mode ${home.mode.toString(8)}`;
    add("home", `present${where}, ${modeText}${home.owned ? "" : ", owned by another user"}`);
    if (home.symlink || !home.owned) problems.push("The wasitme folder is a symlink or not yours; wasitme refuses to use it.");
    else if ((home.mode & 0o077) !== 0) problems.push("The wasitme folder is readable by others. Run: wasitme doctor --repair");
  }
  const salt = readOwnFile(p.salt, 256);
  const saltOk = salt.buf !== undefined && /^[0-9a-f]{64}\n?$/.test(salt.buf.toString("latin1"));
  add("salt", salt.buf ? `present${saltOk ? "" : " but not a valid salt"}, mode ${(salt.mode ?? 0).toString(8)}` : `${salt.why === "missing" ? "missing" : `not usable (${salt.why ?? "unknown"})`}`);
  if (salt.buf && ((salt.mode ?? 0) & 0o077) !== 0) problems.push("The salt file is readable by others. Run: wasitme doctor --repair");
  // Every stored id was made with the salt, so a scan refuses to make a new one while history exists (store/salt.ts):
  // every scan fails until the salt is back or the history is set aside. Say so, with both ways out.
  if (!saltOk && home.exists && historyExists(p)) {
    problems.push("The salt file is missing or damaged, but stored history needs it, so every scan fails. Restore the salt file in the wasitme folder from a backup; or, to start over, move the wasitme folder's history folder aside (the next scan makes a new salt and reads your logs again).");
  }

  // results
  const snap = readOwnFile(p.snapshot, 8 << 20);
  let raw: unknown;
  if (snap.buf) {
    try { raw = JSON.parse(snap.buf.toString("utf8")) as unknown; } catch { raw = undefined; }
  }
  // The glance carries the last scan's failure flag too (scan.ts writeFailureGlance; an older engine flagged only it).
  const glanceRaw = readOwnJson(p.glance, 1 << 20);
  const glanceFailed = isObj(glanceRaw) && glanceRaw.scanOk === false ? listed(glanceRaw.scanError, SCAN_ERRORS) : null;
  const scanHint = saltOk || !historyExists(p) ? "Run: wasitme scan (wasitme doctor --repair fixes what it can)." : "The salt problem above is why.";
  if (raw === undefined) {
    add("results", snap.buf ? "snapshot.json is not valid JSON" : `no snapshot yet (${snap.why ?? "missing"})`);
    problems.push(snap.buf ? "The results file is damaged. Run: wasitme scan" : "No results yet. Run: wasitme scan");
    if (glanceFailed !== null) problems.push(`The last scan failed (${glanceFailed}). ${scanHint}`);
  } else {
    const doc = coerceDoc(raw, ctx.now().getTime());
    const age = doc.generatedAtMs !== null ? ageText(ctx.now().getTime() - doc.generatedAtMs) : "undated";
    const failed = !doc.scanOk ? (doc.scanError ?? "internal") : glanceFailed;
    add("results", `snapshot ${doc.display}, ${age}, last scan ${failed === null ? "ok" : `failed (${failed})`}, lead ${doc.lead}${doc.demo ? ", DEMO data" : ""}`);
    if (doc.display === "stale") problems.push("The results are out of date. Run: wasitme scan");
    if (doc.display === "mismatch" || doc.display === "refused") problems.push("The results file is from another version or was not accepted. Run: wasitme scan. If this comes back, parts of wasitme are out of sync: update it so every part is the same version (wasitme update shows how).");
    if (failed !== null) problems.push(`The last scan failed (${failed}). ${scanHint}`);
    if (doc.agents.length > 0) {
      add("agents", doc.agents.map((a) => `${AGENT_ID.test(a.agent) ? a.agent : "agent"}: ${stateWord(a.state, a.reason)}${a.calibrated ? "" : " (not calibrated)"}${a.pending ? ", confirming" : ""}`).join(" · "));
    }
    const health = isObj(raw) && isObj(raw.health) ? raw.health : null;
    if (health !== null) {
      const sources = Array.isArray(health.sources) ? health.sources.filter(isObj) : [];
      // Where each agent's logs were looked for, named as the user configures it ("~/.claude" or the variable that
      // moved it), never as a path.
      const roots = rootLabels(ctx.env);
      const whereOf = (agent: string): string => (agent === "claude-code" ? roots.claude : agent === "codex" ? roots.codex : "its folder");
      for (const s of sources) {
        const types = isObj(s.unknownTypes) ? Object.values(s.unknownTypes).map(n) : [];
        const agent = typeof s.agent === "string" && AGENT_ID.test(s.agent) ? s.agent : "agent";
        const found = s.found === true;
        const err = typeof s.error === "string" ? listed(s.error, SOURCE_ERRORS) : null;
        add(`source ${agent}`, found
          ? `found in ${whereOf(agent)}, ${plural(n(s.files), "file")}, ${plural(n(s.badLines), "unreadable line")}, ${plural(n(s.truncatedTail), "cut-off ending")}, ${plural(n(s.duplicates), "duplicate")}, ${plural(types.length, "unrecognised record type")} (${plural(types.reduce((a, b) => a + b, 0), "record")})${err !== null ? `, problem: ${err}` : ""}`
          : `${err === null || err === "not_found" ? "no logs found" : `not readable (${err})`} in ${whereOf(agent)}`);
        if (err !== null && err !== "not_found") problems.push(`${agentName(agent)} logs in ${whereOf(agent)} could not be read (${READ_PROBLEM[err] ?? err}).${err === "protected_folder" ? " Allow access in System Settings › Privacy & Security, or keep the logs outside a protected folder." : " Check that folder's permissions."}`);
      }
      // No logs anywhere is a problem (nothing can ever be analysed); one agent missing is normal (you use the other).
      const listedAgents = sources.filter((s) => typeof s.agent === "string" && AGENT_ID.test(s.agent));
      if (listedAgents.length > 0 && listedAgents.every((s) => s.found !== true && (s.error === "not_found" || s.error === null || s.error === undefined))) {
        problems.push(`No Claude Code or Codex logs were found in ${roots.claude} or ${roots.codex}. If your logs are somewhere else, set CLAUDE_CONFIG_DIR (Claude Code) or CODEX_HOME (Codex) to that folder, then run: wasitme scan`);
      }
      const pv = isObj(health.parserVersions) ? Object.entries(health.parserVersions).filter(([k, v]) => /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k) && typeof v === "number") : [];
      if (pv.length > 0) add("parsers", pv.map(([k, v]) => `${k} ${String(v)}`).join(", "));
      add("sandbox", health.sandbox === true ? "on (scans run under the Node permission model)" : "off");
      const paused = Array.isArray(health.paused) ? health.paused.filter(isObj) : [];
      if (paused.length > 0) {
        add("paused", `${plural(paused.length, "indicator")} paused because a log format changed: ${[...new Set(paused.map((x) => listed(x.why, PAUSE_WHY)))].join(", ")}`);
        problems.push("Some indicators are paused because an agent's log format changed. A newer wasitme may read the new format (wasitme update shows how to update).");
      }
    }
    const cal = isObj(raw) && isObj(raw.calibration) ? raw.calibration : null;
    if (cal !== null) {
      const agents = Array.isArray(cal.agents) ? cal.agents.filter(isObj) : [];
      add("calibration", `${typeof cal.artifactDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(cal.artifactDate) ? cal.artifactDate : "no artifact"}; ${agents.length === 0 ? "no agents" : agents.map((a) => `${typeof a.agent === "string" && AGENT_ID.test(a.agent) ? a.agent : "agent"} ${a.calibrated === true ? "calibrated" : "not calibrated"}`).join(", ")}`);
    }
  }

  // other files
  const ex = loadExclude(p.exclude);
  add("exclusions", ex.error !== null ? `the exclude list is ${ex.error}; nothing is excluded` : `${plural(ex.dates.length, "date range")}, ${plural(ex.projects.size, "project")}, ${plural(ex.entrypoints.length, "entry point")}`);
  if (ex.error !== null) problems.push(`The exclude list is ${ex.error}. Fix or delete state/exclude.json in the wasitme folder.`);
  const idx = readOwnJson(p.index, 64 << 20);
  if (isObj(idx) && isObj(idx.sources)) {
    const entries = Object.values(idx.sources).filter(isObj);
    add("history", `${plural(entries.length, "source")} recorded, ${entries.filter((e) => e.present === false).length} kept as history only`);
  } else {
    add("history", home.exists ? "no index yet (a scan builds it)" : "none");
  }
  const lockState = lockProblem(p.lock);
  if (lockState !== null) {
    add("scan lock", `blocked: ${lockState}`);
    problems.push(`The scan lock is ${lockState}, which no scan can take over, so every scan is skipped. Run: wasitme doctor --repair`);
  } else {
    const lock = readOwnFile(p.lock, 4096);
    if (lock.buf) {
      let alive = false;
      try {
        const pid = (JSON.parse(lock.buf.toString("utf8")) as { pid?: unknown }).pid;
        if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) { process.kill(pid, 0); alive = true; }
      } catch (e) {
        alive = (e as { code?: string }).code === "EPERM";
      }
      add("scan lock", alive ? "held by a running scan" : "left behind by a scan that is gone (the next scan takes it over)");
    } else {
      add("scan lock", "free");
    }
  }
  // logs: error kinds only
  const log = readOwnFile(join(p.logs, "scan.log"), 1 << 20);
  if (log.buf) {
    const kinds = new Map<string, number>();
    for (const l of log.buf.toString("utf8").split("\n").slice(-200)) {
      const m = /^\S+ scan_failed ([a-z_]{1,24})$/.exec(l);
      if (m) kinds.set(m[1]!, (kinds.get(m[1]!) ?? 0) + 1);
    }
    if (kinds.size > 0) add("recent errors", [...kinds].map(([k, c]) => `${k} x${c}`).join(", "));
  }
  const eng = isObj(readOwnJson(p.engineJson, 1 << 20)) ? (readOwnJson(p.engineJson, 1 << 20) as Record<string, unknown>) : null;
  if (eng !== null) {
    const flag = eng.permissionFlag;
    add("permission flag", flag === "--permission" || flag === "--experimental-permission" ? String(flag) : "none (the Node permission model is not available)");
  }
  return { lines, problems, repaired: [] };
}

// ───────────────────────────── toolchain ─────────────────────────────

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): { ok: boolean; out: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000, env, stdio: ["ignore", "pipe", "ignore"] });
    return { ok: r.status === 0, out: String(r.stdout ?? "").trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

export function toolchain(ctx: CliContext, redacted: boolean): Line[] {
  const lines: Line[] = [];
  if (ctx.platform !== "darwin") {
    return [{ key: "toolchain", text: "macOS only: the menu bar app is built on a Mac. The CLI works on this system." }];
  }
  const env = { PATH: "/usr/bin:/bin" };
  const sel = run("/usr/bin/xcode-select", ["-p"], env);
  const dir = sel.ok && sel.out.startsWith("/") && existsSync(sel.out) ? sel.out : null;
  if (dir === null) {
    lines.push({ key: "toolchain", text: "no developer tools" });
    lines.push({ key: "app", text: "App skipped: needs Command Line Tools (xcode-select --install, about 1.3 GB). The CLI and plugin still work. Then run the wasitme installer again with --app." });
    return lines;
  }
  const kind = dir.endsWith(".app/Contents/Developer") ? "Xcode" : "Command Line Tools";
  const sw = run("/usr/bin/swift", ["--version"], { ...env, DEVELOPER_DIR: dir });
  const m = /Swift version (\d+)\.(\d+)/.exec(sw.out);
  if (!sw.ok || m === null) {
    lines.push({ key: "toolchain", text: `${kind}${redacted ? "" : ` (${dir})`}; Swift did not report a version` });
    lines.push({ key: "app", text: "App skipped: Swift did not answer. The CLI and plugin still work." });
    return lines;
  }
  const version = `${m[1]}.${m[2]}`;
  lines.push({ key: "toolchain", text: `${kind}${redacted ? "" : ` (${dir})`}, Swift ${version}` });
  lines.push({ key: "app", text: Number(m[1]) < 6
    ? "App skipped: needs Swift 6 (Xcode 16 or Command Line Tools 16 or newer). The CLI and plugin still work. After updating, run the wasitme installer again with --app."
    : kind === "Xcode" ? "The app can be built here (about 10 s)." : "The app can be built here with Command Line Tools (about 45 s)." });
  return lines;
}

// ───────────────────────────── repair ─────────────────────────────

/** Visit every entry under `dir` to `depth` levels (never following symlinks), except the paths in `skip` and below them. */
function walk(dir: string, depth: number, visit: (path: string, st: Stats) => void, skip: ReadonlySet<string> = new Set()): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const path = join(dir, name);
    if (skip.has(path)) continue;
    let st: Stats;
    try { st = lstatSync(path); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    visit(path, st);
    if (st.isDirectory() && depth > 0) walk(path, depth - 1, visit, skip);
  }
}

async function repair(ctx: CliContext, p: HomePaths): Promise<string[]> {
  const done: string[] = [];
  const existed = existsSync(p.home);
  try {
    ensureHome(p);
    if (!existed) done.push("created the wasitme folder");
  } catch (e) {
    return [`could not prepare the wasitme folder (${errorKind(e)})`];
  }
  let modes = 0, temps = 0;
  const me = typeof process.getuid === "function" ? process.getuid() : undefined;
  const hourAgo = ctx.now().getTime() - 3_600_000;
  // The installed versions are read-only on purpose (D46: `versions/<v>` is chmod a-w after staging, and `current`
  // links to one of them); they belong to the installer. Only the engine's own state is tightened.
  const installerOwned = new Set([join(p.home, "versions"), join(p.home, "current")]);
  walk(p.home, 4, (path, st) => {
    if (me !== undefined && st.uid !== me) return;
    if (st.isDirectory() && (st.mode & 0o077) !== 0) { try { chmodSync(path, 0o700); modes++; } catch { /* reported by the next doctor run */ } }
    if (st.isFile()) {
      if (/\.tmp$/.test(path) && st.mtimeMs < hourAgo) { try { unlinkSync(path); temps++; } catch { /* ignore */ } return; }
      if ((st.mode & 0o077) !== 0) { try { chmodSync(path, 0o600); modes++; } catch { /* ignore */ } }
    }
  }, installerOwned);
  if (modes > 0) done.push(`tightened ${plural(modes, "permission")} to owner-only`);
  if (temps > 0) done.push(`removed ${plural(temps, "leftover temporary file")}`);
  // A lock no scan can take over (a folder, an oversized or unreadable file) is moved out of the way; a dead one is
  // taken over (and released) by acquiring it.
  const blocked = lockProblem(p.lock);
  if (blocked !== null) {
    done.push(clearLock(p.lock) ? `removed a scan lock that blocked every scan (it was ${blocked})` : `could not remove the scan lock (it is ${blocked}); remove state/scan.lock in the wasitme folder by hand`);
  }
  const lock = acquireLock(p.lock);
  if (lock !== undefined) lock.release();
  // a fresh scan rebuilds a damaged index from the stored histories and writes new results
  try {
    let ran = false;
    for (let i = 0; i < 40; i++) {
      const r = await runScan({ noProjectFiles: true, now: ctx.now() });
      if (!r.busy) { done.push("ran a scan (a damaged index is rebuilt from the stored histories)"); ran = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ran) done.push("no scan ran: another scan held the lock for 20 seconds (run wasitme doctor again when it is done)");
  } catch (e) {
    done.push(`the scan failed (${errorKind(e)})`);
  }
  // sanity: the folder is where the scan left it
  try { statSync(p.home); } catch { /* ignore */ }
  return done;
}

// ───────────────────────────── command ─────────────────────────────

export async function doctor(ctx: CliContext, argv: readonly string[]): Promise<number> {
  const a = parseArgs(argv, { bool: ["redacted", "toolchain", "repair"] });
  const redacted = has(a, "redacted");
  const p = homePaths(wasitmeHome(ctx.env));
  const repaired = has(a, "repair") ? await repair(ctx, p) : [];
  const report = gather(ctx, p, redacted);
  if (has(a, "toolchain")) report.lines.push(...toolchain(ctx, redacted));
  if (has(a, "json")) {
    emitJson(ctx, { schema: "wasitme.doctor/1", redacted, lines: report.lines, problems: report.problems, repaired });
    return 0;
  }
  const width = Math.max(...report.lines.map((l) => l.key.length));
  const out: string[] = [redacted ? "wasitme doctor (counts, versions and names only; safe to paste into an issue)" : "wasitme doctor"];
  for (const l of report.lines) out.push(`  ${l.key.padEnd(width)}  ${l.text}`);
  if (repaired.length > 0) {
    out.push("", "Repaired:");
    for (const r of repaired) out.push(`  ${r}`);
    out.push("  LaunchAgent plists and command shims are the installer's job and were not touched.");
  }
  out.push("", report.problems.length === 0 ? "No problems found." : "Problems:");
  for (const pr of report.problems) out.push(`  ${pr}`);
  emit(ctx, `${out.join("\n")}\n`);
  return report.problems.length === 0 ? 0 : 1;
}
