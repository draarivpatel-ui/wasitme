/**
 * The dated calibration artifact, as the scan reads it (WP-23 writes it: docs/calibration/<date>.json; D23, D29, D58).
 *
 * The scan never re-judges a gate: it reads the artifact's own flags. An agent is calibrated only when ALL hold:
 *  - the document is a complete `wasitme-calibration` artifact (formatVersion 1, synthetic, dated YYYY-MM-DD);
 *  - it chose an estimator (`selection.chosen`) that this engine can run (a D29 candidate, gates/d23.ts);
 *  - `calibrated[agent].calibrated === true` AND `calibrated[agent].byConstruct[errorsVote] === true` — the voting
 *    tool-error construct the scan uses (settings.ts) is one the artifact passed under.
 * Anything else — no artifact, a malformed one, a failed one, another construct — is `calibrated: false`, which is
 * decision-table row 1 (`insufficient (calibration_pending)`, "Timeline only").
 *
 * The snapshot's `calibration` block: the artifact's date even when nothing passed (there is a dated record; no agent
 * passed it); `methodId` the chosen estimator or null; per agent the null sequences measured for the chosen estimator
 * under the voting construct (summed over the agent's profiles) and the pooled false "changed" / false "agent" rates —
 * 0 / null / null when nothing was chosen (no method, so no rate to report).
 *
 * What ships: SHIPPED_CALIBRATION, a trimmed copy of the newest committed artifact (the fields this reader uses, values
 * unchanged). engine/test/store/calibration.test.ts holds it equal to the newest docs/calibration/*.json, so a new
 * artifact cannot be committed without the engine shipping it. The analysis/calibration harness is not part of the
 * npm package, so nothing here imports it. Tests inject their own artifact through `ScanOptions.calibration`; there is
 * no environment variable or file a user could use to switch calibration on.
 */
import { D29_CANDIDATES, type AnalysisMethod } from "../analysis/gates/d23.js";
import type { ToolErrorVariant } from "../analysis/metrics/defs.js";
import type { Calibration, CalibrationAgent } from "../contract/snapshot.js";

export interface CalibrationAgentSummary {
  calibrated: boolean;
  sequences: number;
  falseChanged: number | null;
  falseAgent: number | null;
}

export interface CalibrationSummary {
  /** The artifact's date, null when there is no usable artifact. */
  artifactDate: string | null;
  /** The chosen estimator when this engine can run it, else null. */
  methodId: string | null;
  /** That estimator's method (the evaluation runs it when an agent is calibrated), else null. */
  method: AnalysisMethod | null;
  /** The voting construct the flags were read for. */
  errorsVote: ToolErrorVariant;
  agents: Record<string, CalibrationAgentSummary>;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const AGENT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

const UNCALIBRATED: Readonly<CalibrationAgentSummary> = Object.freeze({ calibrated: false, sequences: 0, falseChanged: null, falseAgent: null });

/** The production method of a chosen candidate id (the bootstrap, D29), or null when this engine does not know it. */
export function methodOf(id: unknown): AnalysisMethod | null {
  if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(D29_CANDIDATES, id)) return null;
  return { ...D29_CANDIDATES[id]! };
}

/** Read an artifact document (anything: a missing or foreign document reads as "no artifact"). */
export function readCalibration(doc: unknown, errorsVote: ToolErrorVariant): CalibrationSummary {
  const none: CalibrationSummary = { artifactDate: null, methodId: null, method: null, errorsVote, agents: {} };
  if (!isObj(doc) || doc.kind !== "wasitme-calibration" || doc.formatVersion !== 1 || doc.synthetic !== true) return none;
  if (typeof doc.date !== "string" || !DAY_RE.test(doc.date) || !Number.isFinite(Date.parse(`${doc.date}T00:00:00Z`))) return none;
  const out: CalibrationSummary = { ...none, artifactDate: doc.date };
  const complete = doc.status === "complete";
  const chosen = isObj(doc.selection) ? doc.selection.chosen : null;
  const method = complete ? methodOf(chosen) : null;
  if (method !== null) {
    out.methodId = method.id;
    out.method = method;
  }
  const flags = isObj(doc.calibrated) ? doc.calibrated : {};
  const rows = Array.isArray(doc.gNullSeq) ? doc.gNullSeq.filter(isObj) : [];
  for (const [agent, f] of Object.entries(flags)) {
    if (!AGENT_RE.test(agent) || !isObj(f)) continue;
    if (method === null) {
      out.agents[agent] = { ...UNCALIBRATED };
      continue;
    }
    const by = isObj(f.byConstruct) ? f.byConstruct : {};
    const calibrated = f.calibrated === true && by[errorsVote] === true;
    let sequences = 0, ck = 0, cn = 0, ak = 0, an = 0;
    for (const r of rows) {
      if (r.agent !== agent || r.candidate !== method.id || r.errorsVote !== errorsVote) continue;
      sequences += count(r.sequences);
      if (isObj(r.falseChanged)) { ck += count(r.falseChanged.k); cn += count(r.falseChanged.n); }
      if (isObj(r.falseAgent)) { ak += count(r.falseAgent.k); an += count(r.falseAgent.n); }
    }
    out.agents[agent] = {
      calibrated,
      sequences: Math.min(1e9, sequences),
      falseChanged: cn > 0 ? r4(Math.min(1, ck / cn)) : null,
      falseAgent: an > 0 ? r4(Math.min(1, ak / an)) : null,
    };
  }
  return out;
}

/** One agent's entry (an agent the artifact does not name is uncalibrated). */
export function calibrationOf(s: CalibrationSummary, agent: string): CalibrationAgentSummary {
  return Object.prototype.hasOwnProperty.call(s.agents, agent) ? s.agents[agent]! : { ...UNCALIBRATED };
}

/** The snapshot's `calibration` block for the agents the scan reports (in their order). */
export function contractCalibration(s: CalibrationSummary, agents: readonly string[]): Calibration {
  return {
    artifactDate: s.artifactDate,
    methodId: s.methodId,
    agents: agents.slice(0, 8).map((agent): CalibrationAgent => ({ agent, ...calibrationOf(s, agent) })),
  };
}

/** What the inputs digest needs to know about the calibration in force. */
export function calibrationKey(s: CalibrationSummary): string {
  const agents = Object.keys(s.agents).sort().map((a) => [a, s.agents[a]!.calibrated, s.agents[a]!.sequences, s.agents[a]!.falseChanged, s.agents[a]!.falseAgent]);
  return JSON.stringify([s.artifactDate, s.methodId, s.errorsVote, agents]);
}

/**
 * The newest committed artifact (docs/calibration/2026-10-05.json), trimmed to the fields `readCalibration` reads.
 * Full WP-21-decider null run (1,000 null sequences per profile, session-t95-cr2, toolErrorsNonCmd voting): 0 false
 * "changed" and 0 false "agent" in every profile, so both agents are calibrated (D23, D69).
 */
export const SHIPPED_CALIBRATION: unknown = Object.freeze({
  formatVersion: 1,
  kind: "wasitme-calibration",
  synthetic: true,
  status: "complete",
  date: "2026-10-05",
  selection: { chosen: "session-t95-cr2" },
  calibrated: {
    "claude-code": { calibrated: true, byConstruct: { toolErrorsNonCmd: true } },
    codex: { calibrated: true, byConstruct: { toolErrorsNonCmd: true } },
  },
  gNullSeq: [
    ...["few-long", "few-long-hd", "many-short", "single-project", "multi-project", "sparse-failures"].map((profile) => ({
      profile, agent: "claude-code", candidate: "session-t95-cr2", errorsVote: "toolErrorsNonCmd", sequences: 1000,
      falseChanged: { k: 0, n: 1000 }, falseAgent: { k: 0, n: 1000 },
    })),
    {
      profile: "codex", agent: "codex", candidate: "session-t95-cr2", errorsVote: "toolErrorsNonCmd", sequences: 1000,
      falseChanged: { k: 0, n: 1000 }, falseAgent: { k: 0, n: 1000 },
    },
  ],
});
