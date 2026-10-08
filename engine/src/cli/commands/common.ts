/** Helpers the report-style commands share: output with the safety checks, option reading, agent selection. */
import type { Lead } from "../../contract/vocab.js";
import type { ReportDoc } from "../../output/doc.js";
import { agentMissingReason, emptyReason, rootLabels } from "../../output/empty.js";
import { copyProblems, safeTerminalText } from "../../output/guard.js";
import { parseUntil, resolveTimeZone } from "../../store/time.js";
import { has, str, UsageError, type Parsed } from "../args.js";
import { asciiOnly, colorMode, type CliContext } from "../context.js";
import type { TerminalOptions } from "../../output/terminal.js";

import { CommandFailure } from "../failure.js";

export { CommandFailure };

export function timeZoneOf(ctx: CliContext, p: Parsed): string {
  try {
    return resolveTimeZone(str(p, "tz"), ctx.env);
  } catch {
    throw new UsageError("--tz is not a valid IANA time zone");
  }
}

export function untilOf(p: Parsed, tz: string): Date | undefined {
  const raw = str(p, "until");
  if (raw === undefined) return undefined;
  try {
    return parseUntil(raw, tz);
  } catch (e) {
    throw new UsageError(e instanceof RangeError ? e.message : "--until is not valid");
  }
}

/**
 * `--lead timeline|finding`: which comes first, the timeline or the finding. `finding` is the contract's "verdict"
 * lead (D28; the contract keeps that value); `--lead verdict` is still accepted as a hidden alias, so scripts written
 * against earlier builds keep working, but help and errors only name `finding`.
 */
export function leadOf(p: Parsed): Lead | undefined {
  const v = str(p, "lead");
  if (v === undefined) return undefined;
  if (v === "timeline") return "timeline";
  if (v === "finding" || v === "verdict") return "verdict";
  throw new UsageError("--lead must be timeline or finding");
}

export function terminalOptions(ctx: CliContext, p: Parsed, timeZone: string): TerminalOptions {
  const lead = leadOf(p);
  return {
    mode: colorMode(ctx),
    ascii: asciiOnly(ctx) || has(p, "ascii"),
    columns: ctx.columns ?? 100,
    timeZone,
    platform: ctx.platform,
    roots: rootLabels(ctx.env),
    ...(lead !== undefined ? { lead } : {}),
  };
}

/**
 * Only this agent (an id in the document). With no agents at all, the failure says why there are none (no results file,
 * no logs found …), the same sentence the report would show; a known agent missing from results that hold another says
 * where wasitme looks for its logs; an id wasitme does not know is a usage error.
 */
export function selectAgent(doc: ReportDoc, raw: unknown, agent: string | undefined, ctx?: CliContext): { doc: ReportDoc; raw: unknown } {
  if (agent === undefined) return { doc, raw };
  if (!doc.agents.some((a) => a.agent === agent)) {
    const roots = ctx !== undefined ? rootLabels(ctx.env) : undefined;
    if (doc.agents.length === 0) throw new CommandFailure(`no results to select an agent from. ${emptyReason(doc, roots).text}`, 1);
    // A known agent that is not in the results is a state, not a typo: one plain line (the Codex skill's command,
    // `report --md --agent codex`, shows it to the person), never a usage error followed by the whole help text.
    const missing = agentMissingReason(doc, agent, roots);
    if (missing !== undefined) throw new CommandFailure(missing, 1);
    // Otherwise name the ids that are there (claude-code, codex), so the user can retry without guessing. They come
    // from the results file, so only plain lowercase words are echoed.
    const ids = doc.agents.map((a) => a.agent).filter((id) => /^[a-z0-9-]{1,24}$/.test(id));
    throw new UsageError(`--agent is not one of the agents in the results${ids.length > 0 ? ` (${ids.join(", ")})` : ""}`);
  }
  const kept = { ...doc, agents: doc.agents.filter((a) => a.agent === agent) };
  const r = raw as { agents?: unknown } | null;
  const filtered = r !== null && typeof r === "object" && Array.isArray(r.agents)
    ? { ...r, agents: r.agents.filter((a) => (a as { agent?: unknown } | null)?.agent === agent) }
    : raw;
  return { doc: kept, raw: filtered };
}

/** Refuse documents whose text fails the copy checks (names the fields only). */
export function requireCleanCopy(doc: ReportDoc): void {
  const problems = copyProblems(doc);
  if (problems.length > 0) {
    throw new CommandFailure(`the results hold text that fails wasitme's copy checks (${problems.length}: ${problems.slice(0, 3).map((p) => p.split(":")[0]).join(", ")}); nothing was shown`);
  }
}

/** Print terminal text, after checking that it holds only newlines and the design system's colour codes. */
export function emit(ctx: CliContext, text: string): void {
  if (!safeTerminalText(text)) throw new CommandFailure("internal: output held a control character; nothing was printed");
  ctx.stdout.write(text);
}

/** Print JSON (strings are escaped, so control characters can't reach the terminal). */
export function emitJson(ctx: CliContext, value: unknown): void {
  ctx.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
