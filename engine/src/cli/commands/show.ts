/**
 * `wasitme` (no command) and `wasitme report`: the findings for each agent.
 *
 *   wasitme [--lead timeline|finding] [--agent ID] [--no-scan] [--read-only] [--until T] [--tz ZONE] [--ascii] [--json]
 *   wasitme report [--format md|html|json | --md | --html] [--agent ID] [--no-scan] [--read-only] [--until T] [--tz ZONE]
 *
 * `report` prints the shareable evidence report: Markdown by default (what `/wasitme:report` and "Copy evidence
 * report" use), `--html` for one self-contained file, `--format json` for the results file as it is (the local
 * snapshot: it has exact times and local ids, so unlike md and html it is NOT share-safe).
 *
 * `--json` has one meaning everywhere: machine-readable output. For `report --md` it wraps the Markdown in an envelope
 * — {"schema":"wasitme.report/1","format":"md","markdown":"…"} — which is what the Mac app's engine runner (it
 * always appends --json) reads; on its own (`report --json`, `wasitme --json`) it is the snapshot document.
 */
import type { ReportDoc } from "../../output/doc.js";
import { emptyReason, rootLabels } from "../../output/empty.js";
import { renderHtml, renderMarkdown } from "../../output/report.js";
import { renderTerminal } from "../../output/terminal.js";
import { has, parseArgs, str, UsageError } from "../args.js";
import type { CliContext } from "../context.js";
import { acquire, type Acquired } from "../source.js";
import { CommandFailure, emit, emitJson, requireCleanCopy, selectAgent, terminalOptions, timeZoneOf, untilOf } from "./common.js";

const SOURCE_FLAGS = { bool: ["no-scan", "read-only", "ascii"], value: ["agent", "until", "tz"] } as const;

async function load(ctx: CliContext, flags: ReturnType<typeof parseArgs>): Promise<Acquired> {
  const tz = timeZoneOf(ctx, flags);
  const until = untilOf(flags, tz);
  return acquire(ctx, { noScan: has(flags, "no-scan"), readOnly: has(flags, "read-only"), ...(until !== undefined ? { until } : {}), timeZone: tz, waitMs: 20_000 });
}

function notes(ctx: CliContext, acq: Acquired): void {
  if (acq.scanFailed !== null) ctx.stderr.write(`wasitme: the scan failed (${acq.scanFailed}); showing the last good result.\n`);
  if (acq.stillBusy) ctx.stderr.write("wasitme: another scan is still running; showing the results as they are.\n");
}

/**
 * `--json` passthrough of the results file. With no file to pass through (none yet, or a damaged one) there is no
 * document to print: say why on stderr and exit 1, rather than printing `null` as if it were a result.
 */
function emitRaw(ctx: CliContext, doc: ReportDoc, raw: unknown): number {
  if (raw === null || raw === undefined) throw new CommandFailure(emptyReason(doc, rootLabels(ctx.env)).text, 1);
  emitJson(ctx, raw);
  return 0;
}

export async function show(ctx: CliContext, argv: readonly string[]): Promise<number> {
  const p = parseArgs(argv, { ...SOURCE_FLAGS, value: [...SOURCE_FLAGS.value, "lead"] });
  const acq = await load(ctx, p);
  const { doc, raw } = selectAgent(acq.doc, acq.raw, str(p, "agent"), ctx);
  notes(ctx, acq);
  if (has(p, "json")) return emitRaw(ctx, doc, raw);
  requireCleanCopy(doc);
  if (doc.agents.length === 0 && acq.stillBusy) {
    ctx.stdout.write("wasitme: another scan is running and there are no results yet. Try again in a moment.\n");
    return 0;
  }
  emit(ctx, renderTerminal(doc, terminalOptions(ctx, p, timeZoneOf(ctx, p))));
  return 0;
}

export async function report(ctx: CliContext, argv: readonly string[]): Promise<number> {
  const p = parseArgs(argv, { bool: [...SOURCE_FLAGS.bool, "md", "html"], value: [...SOURCE_FLAGS.value, "format"] });
  const explicit = [has(p, "md") ? "md" : null, has(p, "html") ? "html" : null, str(p, "format") ?? null].filter((x): x is string => x !== null);
  if (explicit.length > 1 && new Set(explicit).size > 1) throw new UsageError("choose one of --md, --html or --format");
  const format = explicit[0] ?? (has(p, "json") ? "json" : "md");
  if (format !== "md" && format !== "html" && format !== "json") throw new UsageError("--format must be md, html or json");
  const acq = await load(ctx, p);
  const agent = str(p, "agent");
  const { doc, raw } = selectAgent(acq.doc, acq.raw, agent, ctx);
  notes(ctx, acq);
  if (format === "json") return emitRaw(ctx, doc, raw);
  if (doc.agents.length === 0) {
    throw new CommandFailure(acq.stillBusy ? "another scan is running and there are no results yet; try again in a moment" : `there is nothing to report. ${emptyReason(doc, rootLabels(ctx.env)).text}`, 1);
  }
  requireCleanCopy(doc);
  const text = format === "md" ? renderMarkdown(doc, agent !== undefined ? { agent } : {}) : renderHtml(doc, agent !== undefined ? { agent } : {});
  if (has(p, "json")) {
    emitJson(ctx, { schema: "wasitme.report/1", format, ...(format === "md" ? { markdown: text } : { html: text }) });
    return 0;
  }
  emit(ctx, text);
  return 0;
}
