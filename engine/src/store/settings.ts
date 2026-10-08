/**
 * The scan's analysis settings, each in exactly one place so a ruling changes it in one line.
 *
 *  - SCAN_ERRORS_VOTE: which tool-error construct votes (D47d). G0 kept the pre-registered fallback
 *    `toolErrorsNonCmd` (G0_FALLBACK_ERRORS_VOTE, D61). Changing it resets every agent's persisted decision (D56) and
 *    un-calibrates any agent whose calibration artifact did not pass under the new construct (calflags.ts).
 *  - DEFAULT_LEAD: the glance/snapshot layout (D28). Timeline-led (D61 applied D28); the installer may record
 *    `"lead": "verdict"` (or "timeline") in engine.json, which this module reads. Anything else is the default.
 *  - ATTRIBUTION_VERSION: bump when the attribution method (decision table, persistence rule, onset, evidence) changes
 *    in a way that makes a persisted decision meaningless: persistence then starts fresh (D56).
 */
import { G0_FALLBACK_ERRORS_VOTE } from "../analysis/gates/evaluate.js";
import type { ToolErrorVariant } from "../analysis/metrics/defs.js";
import { LEADS, type Lead } from "../contract/vocab.js";
import { readOwnJson } from "./atomic.js";

/** D47d: the voting tool-error construct. A ruling changes this line (and nothing else); D61 kept the fallback. */
export const SCAN_ERRORS_VOTE: ToolErrorVariant = G0_FALLBACK_ERRORS_VOTE;

/** D28, applied by D61: timeline-led. */
export const DEFAULT_LEAD: Lead = "timeline";

/** Version of the attribution method a persisted decision was made under (WP-21 as merged = 1). */
export const ATTRIBUTION_VERSION = 1;

/** The lead variant from engine.json's `lead` key; a missing, foreign or malformed file means the default. */
export function readLead(engineJson: string): Lead {
  const doc = readOwnJson(engineJson, 1 << 20);
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return DEFAULT_LEAD;
  const v = (doc as Record<string, unknown>).lead;
  return (LEADS as readonly unknown[]).includes(v) ? (v as Lead) : DEFAULT_LEAD;
}
