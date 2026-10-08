#!/usr/bin/env node
/**
 * wasitme CLI. Zero runtime dependencies.
 *
 *   wasitme [--lead timeline|finding] [--agent ID] [--no-scan] [--read-only] [--until T] [--tz ZONE]   the findings
 *   wasitme status                              one line: the state, like the status line
 *   wasitme report [--md|--html|--format json] [--agent ID]   the shareable evidence report (json: local only)
 *   wasitme demo [--case NAME]                  engine output over the design system's demo data (DEMO marker)
 *   wasitme doctor [--redacted] [--toolchain] [--repair]
 *   wasitme exclude add|list|remove ...         keep days, projects or entry points out of the analysis
 *   wasitme history clear [--yes]               delete the saved history and results (keeps settings and the install)
 *   wasitme statusline [install|uninstall|show] the Claude Code status line
 *   wasitme scan [--until T] [--read-only] [--no-project-files] [--tz ZONE] [--json]
 *   wasitme hook session-start [--cwd ABS_PATH] [--session ID]
 *
 * Every command accepts a trailing `--json` (the Mac app's engine runner always adds it). Output never contains paths,
 * prompts or log text: terminal text is cleaned of control characters before it is laid out and checked once more
 * before it is printed (output/guard.ts); errors are printed as a kind. `hook session-start` prints nothing and always
 * exits 0 (a SessionStart hook's stdout becomes model context).
 *
 * `compare` is not in this build: the analysis layer has no comparison API yet, so the command is
 * absent rather than faked.
 */

// Only what every command needs is imported here; each command's own module graph (the scan, the readers, the analysis,
// the renderers) is loaded when that command runs, so `wasitme status` (the status line) and `--version` stay fast.
import { basename } from "node:path";
import { errorKind } from "../store/errors.js";
import { ENGINE_VERSION } from "../version.js";
import { has, parseArgs, str, UsageError } from "./args.js";
import { realContext, type CliContext } from "./context.js";
import { CommandFailure } from "./failure.js";

const USAGE = `usage:
  wasitme [--lead timeline|finding] [--agent claude-code|codex] [--no-scan] [--read-only] [--until T] [--tz ZONE] [--ascii] [--json]
      what changed, and whether it was your setup or the agent (scans first when the results are missing or old)
  wasitme status
      one line: the current state, as the status line shows it
  wasitme report [--md | --html | --format json] [--agent claude-code|codex] [--no-scan] [--read-only]
      the evidence report to share (Markdown by default; numbers only, no prompts, code or paths)
      --format json (like --json) is the full snapshot for your own tools: it has exact times and local ids,
      so keep it local; unlike --md and --html it is not safe to share
  wasitme demo [--case insufficient|none|unclear|you|agent|codex] [--md | --html | --json]
      the report over built-in demo data (not your logs)
  wasitme doctor [--redacted] [--toolchain] [--repair]
      what state wasitme is in and what would fix it; --repair fixes what it can
  wasitme exclude add|list|remove <project folder> | --dates FROM..TO | --entrypoint NAME
      keep a project, a date range or an entry point out of the analysis
  wasitme history clear [--yes]
      delete the saved history and results; settings, exclusions and the install stay (asks first)
  wasitme statusline [install [--wrap] | uninstall | show] [--script ABS_PATH] [--claude-dir ABS_PATH]
      the Claude Code status line (install never replaces yours unless you pass --wrap)
  wasitme scan [--until <RFC3339>] [--read-only] [--no-project-files] [--tz <zone>] [--json]
      read the logs and update the results now
  wasitme hook session-start [--cwd <absolute path>] [--session <id>]
      used by the Claude Code plugin; prints nothing
  wasitme update
      how to update (wasitme downloads nothing itself: the newer release's installer does it)
  wasitme --version
`;

async function scan(ctx: CliContext, argv: readonly string[]): Promise<number> {
  const a = parseArgs(argv, { bool: ["read-only", "no-project-files"], value: ["until", "tz"] });
  const [{ runScan }, { parseUntil, resolveTimeZone }] = await Promise.all([import("../store/scan.js"), import("../store/time.js")]);
  let tz: string;
  try {
    tz = resolveTimeZone(str(a, "tz"), ctx.env);
  } catch {
    throw new UsageError("--tz is not a valid IANA time zone");
  }
  let until: Date | undefined;
  const rawUntil = str(a, "until");
  if (rawUntil !== undefined) {
    try {
      until = parseUntil(rawUntil, tz);
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : "--until is not valid");
    }
  }
  const readOnly = has(a, "read-only");
  const r = await runScan({ timeZone: tz, ...(until !== undefined ? { until } : {}), readOnly, noProjectFiles: true });
  if (r.busy) {
    ctx.stdout.write("wasitme: another scan is running; skipped.\n");
    return 0;
  }
  if (r.excludeError) ctx.stderr.write(`wasitme: the exclude list is ${r.excludeError}; nothing was excluded.\n`);
  if (readOnly || has(a, "json")) {
    ctx.stdout.write(`${JSON.stringify(r.snapshot, null, 2)}\n`);
    return 0;
  }
  const parts = [
    `${r.sources} sources`,
    `${r.parsed} parsed`,
    r.rederivedPartial + r.rederivedFull > 0 ? `${r.rederivedPartial + r.rederivedFull} re-derived` : "",
    `${r.unchanged} unchanged`,
    r.historyOnly > 0 ? `${r.historyOnly} kept as history` : "",
    r.failed > 0 ? `${r.failed} unreadable` : "",
    r.lostShards > 0 ? `${r.lostShards} stored histories damaged and left out` : "",
  ].filter(Boolean);
  ctx.stdout.write(`wasitme: scanned ${parts.join(", ")}${r.reused ? " (results unchanged)" : ""} in ${Math.round(r.ms)} ms.\n`);
  return 0;
}

/**
 * `wasitme update`: how to update. Every surface that finds parts of wasitme out of sync ("Update needed") points
 * here, so the command must exist; but the engine has no network code, so it downloads nothing — the newer release's
 * installer is the updater (README "Update"). It prints the installed version and that one step.
 */
function update(ctx: CliContext, argv: readonly string[]): number {
  const a = parseArgs(argv, {});
  if (has(a, "json")) {
    ctx.stdout.write(`${JSON.stringify({ schema: "wasitme.update/1", version: ENGINE_VERSION, downloads: false })}\n`);
    return 0;
  }
  ctx.stdout.write([
    `wasitme ${ENGINE_VERSION} is installed.`,
    "wasitme has no network code, so it never downloads an update itself. To update, run the installer of the newer",
    "release: it installs the new version beside this one and switches over (engine, app and plugins together), keeps",
    "your results, history and settings, and keeps this version for a rollback. Then run: wasitme scan",
    "",
  ].join("\n"));
  return 0;
}

async function hook(argv: readonly string[]): Promise<number> {
  if (argv[0] !== "session-start") throw new UsageError("unknown hook");
  const { parseHookPayload, sessionStartHook } = await import("../hook/session-start.js");
  let cwd: string | undefined, session: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const f = argv[i]!;
    if (f === "--cwd") cwd = argv[++i];
    else if (f === "--session") session = argv[++i];
    else return 0; // a hook never fails the session over arguments
  }
  if (cwd === undefined) {
    const p = parseHookPayload(await readStdin(256 * 1024 + 1, 2000));
    cwd = p.cwd;
    session ??= p.session;
  }
  try { sessionStartHook({ cwd, session }); } catch { /* never fail the session */ }
  return 0;
}

/**
 * The hook payload from stdin: at most `max` bytes, and never more than `timeoutMs` of waiting — a launcher that
 * leaves stdin open (or a terminal) must not hang a SessionStart hook. Anything incomplete parses as "no payload".
 */
function readStdin(max: number, timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (text: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.destroy();
      resolve(text);
    };
    const timer = setTimeout(() => finish(""), timeoutMs);
    process.stdin.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) return finish("");
      chunks.push(c);
    });
    process.stdin.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => finish(""));
  });
}

/**
 * `--help` or `-h` anywhere among a command's options (`wasitme report --help`, `wasitme exclude add -h`): the first thing
 * a new user tries, so it prints the usage and exits 0 instead of failing as an unknown option. A `--` ends the options
 * (what follows is an argument, such as a folder named `--help`). `hook` is excluded: it prints nothing, ever.
 */
function asksForHelp(argv: readonly string[]): boolean {
  if (argv[0] === "hook") return false;
  for (const a of argv) {
    if (a === "--") return false;
    if (a === "--help" || a === "-h") return true;
  }
  return false;
}

/** A command word is echoed back only when it is a plain word: an argument can be a path, and errors never print paths. */
function unknownCommand(cmd: string): string {
  return /^[A-Za-z0-9._-]{1,24}$/.test(cmd) ? `unknown command "${cmd}"` : "unknown command";
}

export async function main(argv: readonly string[], ctx: CliContext = realContext()): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "help" || asksForHelp(argv)) {
      ctx.stdout.write(USAGE);
      return 0;
    }
    // The installer's self-check reads this line (scripts/lib/engine.sh engine_self_check): keep it `wasitme <version>`.
    if (cmd === "--version" || cmd === "-V" || cmd === "-v" || cmd === "version") {
      if (rest.length > 0 && !(rest.length === 1 && rest[0] === "--json")) throw new UsageError("--version takes no arguments");
      if (rest[0] === "--json") ctx.stdout.write(`${JSON.stringify({ schema: "wasitme.version/1", version: ENGINE_VERSION })}\n`);
      else ctx.stdout.write(`wasitme ${ENGINE_VERSION}\n`);
      return 0;
    }
    if (cmd === undefined || (cmd.startsWith("--") && cmd !== "--")) return await (await import("./commands/show.js")).show(ctx, argv);
    if (cmd === "scan") return await scan(ctx, rest);
    if (cmd === "hook") return await hook(rest);
    if (cmd === "status") return (await import("./commands/status.js")).status(ctx, rest);
    if (cmd === "statusline") return (await import("./commands/statusline.js")).statusline(ctx, rest);
    if (cmd === "report") return await (await import("./commands/show.js")).report(ctx, rest);
    if (cmd === "demo") return (await import("./commands/demo.js")).demo(ctx, rest);
    if (cmd === "doctor") return await (await import("./commands/doctor.js")).doctor(ctx, rest);
    if (cmd === "exclude") return (await import("./commands/exclude.js")).exclude(ctx, rest);
    if (cmd === "history") return await (await import("./commands/history.js")).history(ctx, rest);
    if (cmd === "update") return update(ctx, rest);
    throw new UsageError(unknownCommand(cmd));
  } catch (e) {
    if (cmd === "hook") return 0;
    if (e instanceof UsageError) {
      // The message, then the usage once (a message that already starts with "usage:" is not repeated by the block).
      ctx.stderr.write(e.message.startsWith("usage:") ? `wasitme: ${e.message}\nRun 'wasitme help' for every command.\n` : `wasitme: ${e.message}\n${USAGE}`);
      return 2;
    }
    if (e instanceof CommandFailure) {
      ctx.stderr.write(`wasitme: ${e.message}\n`);
      return e.code;
    }
    ctx.stderr.write(`wasitme: ${cmd === undefined || cmd.startsWith("--") ? "report" : cmd} failed (${errorKind(e)}).\n`);
    return 1;
  }
}

// Run when executed as the CLI (directly, or through the npm bin link named `wasitme`), not when imported by tests.
const invoked = basename(process.argv[1] ?? "");
if (invoked === "main.js" || invoked === "wasitme" || invoked === "wasitme.mjs") {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
