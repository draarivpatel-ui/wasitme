/**
 * `wasitme status` (alias `wasitme statusline`): the one-line state, the same text the status line shows.
 *
 *   wasitme status [--json]
 *
 * Reads `glance.json` (or, failing that, `snapshot.json`); never scans. Prints `wasitme: <state>[ +n]` for the first
 * agent — "out of date" when the file is older than its own `staleAfterSec` (docs/CONTRACT.md display rules). Exit 0
 * with that line when there is a state. When there is none, the line is a short app state — "no results yet", "no logs
 * found", "logs not readable", "results damaged", "update needed", "results refused" — because this command is also
 * what an installed status line runs (short words only, D59); at a terminal, the sentence that says what to do follows
 * on stderr. The exit is 1 so a script can tell. With `--json` the exit is always 0: `statusLine` is null when there is nothing,
 * `display` and `why` say why, and `scanOk`/`scanError` say whether the last scan failed.
 * The line is the engine's `statusLine` when it has the glance shape, else rebuilt from the state label.
 */
import { homePaths, wasitmeHome } from "../../store/home.js";
import { readOwnFile } from "../../store/atomic.js";
import { coerceDoc, emptyDoc, type ReportDoc } from "../../output/doc.js";
import { emptyReason, rootLabels } from "../../output/empty.js";
import { lintStatusLine } from "../../words/lint.js";
import { CALIBRATION_PENDING_WORDS, STATE_WORDS } from "../../words/tokens.js";
import { parseArgs, has } from "../args.js";
import type { CliContext } from "../context.js";
import { emit, emitJson } from "./common.js";

/**
 * The glance document, else the snapshot, as a safe document. An empty glance (no agents) borrows the snapshot's
 * source rows, so "no logs found" and "logs not readable" can be told apart. With neither file readable, the empty
 * document says whether they are missing or damaged.
 */
export function readGlance(ctx: CliContext): ReportDoc {
  const p = homePaths(wasitmeHome(ctx.env));
  let damaged = false;
  const read = (file: string): ReportDoc | null => {
    const r = readOwnFile(file, 8 << 20);
    if (!r.buf) {
      if (r.why !== "missing") damaged = true;
      return null;
    }
    try {
      return coerceDoc(JSON.parse(r.buf.toString("utf8")) as unknown, ctx.now().getTime());
    } catch {
      damaged = true;
      return null;
    }
  };
  const glance = read(p.glance);
  if (glance !== null && glance.display !== "empty") return glance;
  const snapshot = read(p.snapshot);
  if (glance !== null) return snapshot !== null && snapshot.display === "empty" ? { ...glance, sources: snapshot.sources } : glance;
  if (snapshot !== null) return snapshot;
  return emptyDoc("empty", damaged ? "damaged" : "missing");
}

export function statusText(doc: ReportDoc): string | null {
  if (doc.display === "stale") return `wasitme: ${STATE_WORDS.stale.label.toLowerCase()}`;
  const a = doc.agents[0];
  if (doc.display !== "ok" || a === undefined) return null;
  if (lintStatusLine(a.statusLine).length === 0) return a.statusLine;
  const label = a.reason === "calibration_pending" ? CALIBRATION_PENDING_WORDS.label : STATE_WORDS[a.state].label;
  return `wasitme: ${label.toLowerCase()}`;
}

/** The short status-line words for a document with no state to show (see the file header). */
const NO_STATE: Readonly<Record<ReturnType<typeof emptyReason>["kind"], string>> = {
  no_results: "no results yet",
  no_logs: "no logs found",
  unreadable_logs: "logs not readable",
  damaged: "results damaged",
  mismatch: "update needed",
  refused: "results refused",
};

export function status(ctx: CliContext, argv: readonly string[]): number {
  const p = parseArgs(argv, {});
  const doc = readGlance(ctx);
  const text = statusText(doc);
  const why = text === null ? emptyReason(doc, rootLabels(ctx.env)) : null;
  if (has(p, "json")) {
    emitJson(ctx, {
      schema: "wasitme.status/1", display: doc.display, statusLine: text, state: doc.agents[0]?.state ?? null, agents: doc.agents.length,
      why: why?.kind ?? null, scanOk: doc.scanOk, scanError: doc.scanOk ? null : doc.scanError,
    });
    return 0; // a machine reader (the Mac app's runner treats non-zero as a failure and drops stdout) reads `display`
  }
  if (text !== null) {
    emit(ctx, `${text}\n`);
    return 0;
  }
  emit(ctx, `wasitme: ${NO_STATE[why!.kind]}\n`);
  // What to do, for a person at a terminal only: as the installed status line this command's output is piped, and a
  // status line shows short words (D59), never a sentence on any stream.
  if (ctx.stdoutIsTTY) ctx.stderr.write(`wasitme: ${why!.text}\n`);
  return 1;
}
