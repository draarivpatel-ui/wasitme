/**
 * `wasitme demo`: the engine's own output over the design system's ANALYTIC demo data (design/system/demo-data.v3.json,
 * embedded). It never reads or writes the wasitme home, the agents' logs or anything else on the machine, so demo output
 * can never mix with real results; every format carries a DEMO marker, and the documents say `demo: true` (D21: README
 * images and launch assets come from here).
 *
 *   wasitme demo [--case insufficient|none|unclear|you|agent|codex] [--lead timeline|finding]
 *                [--md | --html | --format md|html|json | --json]
 *
 * Default case: insufficient ("Too early to tell", the most common real outcome). `--json` prints the demo snapshot.
 */
import { DEMO_CASES, demoOutputs, type DemoCase } from "../../demo/facts.js";
import { coerceDoc } from "../../output/doc.js";
import { renderHtml, renderMarkdown } from "../../output/report.js";
import { renderTerminal } from "../../output/terminal.js";
import { ENGINE_VERSION } from "../../version.js";
import { has, parseArgs, str, UsageError } from "../args.js";
import type { CliContext } from "../context.js";
import { CommandFailure, emit, emitJson, leadOf, requireCleanCopy, terminalOptions } from "./common.js";

/** The demo's own clock: ten minutes after its documents were generated, so they are fresh whatever today is. */
const DEMO_NOW = Date.parse("2026-10-04T14:24:00Z");

export function demo(ctx: CliContext, argv: readonly string[]): number {
  const p = parseArgs(argv, { bool: ["md", "html", "ascii"], value: ["case", "lead", "format"] });
  const name = (str(p, "case") ?? "insufficient") as DemoCase;
  if (!(DEMO_CASES as readonly string[]).includes(name)) throw new UsageError(`--case must be one of ${DEMO_CASES.join(", ")}`);
  const explicit = [has(p, "md") ? "md" : null, has(p, "html") ? "html" : null, str(p, "format") ?? null].filter((x): x is string => x !== null);
  if (explicit.length > 1 && new Set(explicit).size > 1) throw new UsageError("choose one of --md, --html or --format");
  const format = explicit[0] ?? (has(p, "json") ? "json" : "terminal");
  if (!["terminal", "md", "html", "json"].includes(format)) throw new UsageError("--format must be terminal, md, html or json");
  const lead = leadOf(p);
  const built = demoOutputs(name, { engine: ENGINE_VERSION, ...(lead !== undefined ? { lead } : {}) });
  if (built.problems.length > 0) throw new CommandFailure(`internal: the demo failed the engine's own checks (${built.problems.length})`);
  if (format === "json") {
    emitJson(ctx, built.snapshot);
    return 0;
  }
  const doc = coerceDoc(built.snapshot, DEMO_NOW);
  requireCleanCopy(doc);
  if (format === "md") emit(ctx, renderMarkdown(doc));
  else if (format === "html") emit(ctx, renderHtml(doc));
  else emit(ctx, renderTerminal(doc, terminalOptions(ctx, p, "UTC")));
  return 0;
}
