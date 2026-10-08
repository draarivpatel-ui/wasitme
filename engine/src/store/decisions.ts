/**
 * Persisted decisions (METHOD.md §12 "Persistence", D56): each agent's last `Decision`, so the next scan can hold a
 * shown state until a different outcome is confirmed by a second evaluation.
 *
 *   state/decisions.json  { schema, errorsVote, methodId, version, agents: { <agent>: PersistedDecision } }   0600
 *
 * Kept: exactly what `decide` reads from `previous` — the shown verdict (state, reason, row, trace, onset, candidates,
 * blind spot, observation, single indicator), `pending`, and `persistence.{fingerprint, candidate}`. Dropped: `raw`
 * (this evaluation's own outcome, never read back) and `persistence.rule` (why the outcome is shown; it moves from
 * "first" to "same" on an unchanged recompute, which would make an idempotent scan rewrite the file).
 *
 * Contents are derived numbers, enum words, "YYYY-MM-DD" days, ISO times, metric ids and event ids. Event ids are
 * the salted HMAC ids of the readers and configsnap ("c-…", 12 hex) and the attribution layer's derived/tripwire ids
 * ("d-…"/"t-…": unsalted hashes of allow-listed labels such as a version or model name and a day — the same ids
 * snapshot.json's timeline already carries). Every string is checked against a short id charset on load.
 *
 * Reset (D56): a file written under another voting construct (`errorsVote`), another calibrated method (`methodId`)
 * or another attribution version gives `previous = null` for every agent. A file that is missing, not ours, too large,
 * malformed or fails the shape check gives null too (persistence starts fresh; nothing fails).
 *
 * Progress history (D64, analysis/gates/eta.ts), alongside the decisions in the same file and under the same key:
 *
 *   progress: { schema: "wasitme.progress/1", agents: { <agent>: EtaRecord[] } }      (≤ ETA_HISTORY_KEEP per agent)
 *
 * Each record is one daily evaluation: { day "YYYY-MM-DD", ready, tier 1–3 | null, eta "YYYY-MM-DD" | null, notAtPace }
 * — days, booleans and a tier number; no ids at all. The section has its own version: another `schema` (or a bad
 * record) drops that agent's history (no date until it is stable again), never the decisions.
 */
import { PERSISTENCE_DEFAULTS } from "../analysis/attribution/decide.js";
import type { Decision, Fingerprint, PendingCandidate, Verdict } from "../analysis/attribution/types.js";
import { ETA_HISTORY_KEEP, priorRecords, type EtaRecord } from "../analysis/gates/eta.js";
import { REASONS_BY_STATE, VERDICT_STATES, type VerdictReason, type VerdictState } from "../contract/vocab.js";
import { readOwnJson, writeIfChanged } from "./atomic.js";

export const DECISIONS_SCHEMA = "wasitme.decisions/1";
const MAX_BYTES = 4 << 20;

export interface DecisionKey {
  errorsVote: string;
  methodId: string | null;
  version: number;
}

export type PersistedDecision = Verdict & {
  pending: boolean;
  persistence: { fingerprint: Fingerprint; candidate: PendingCandidate | null };
};

export interface DecisionsFile extends DecisionKey {
  schema: typeof DECISIONS_SCHEMA;
  agents: Record<string, PersistedDecision>;
  /** D64 progress history (absent in files written before it). */
  progress?: { schema: typeof PROGRESS_SCHEMA; agents: Record<string, EtaRecord[]> };
}

export const PROGRESS_SCHEMA = "wasitme.progress/1";

const ID_RE = /^[A-Za-z0-9_.:+@-]{1,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const AGENT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every leaf is null, a boolean, a finite number or an id-shaped / ISO-time string; bounded depth and size. */
function safeJson(v: unknown, depth: number, budget: { n: number }): boolean {
  if (--budget.n < 0 || depth > 8) return false;
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return ID_RE.test(v) || ISO_RE.test(v);
  if (Array.isArray(v)) return v.length <= 2000 && v.every((x) => safeJson(x, depth + 1, budget));
  if (isObj(v)) return Object.keys(v).length <= 64 && Object.entries(v).every(([k, x]) => /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k) && safeJson(x, depth + 1, budget));
  return false;
}

const stateOk = (state: unknown, reason: unknown): boolean =>
  (VERDICT_STATES as readonly unknown[]).includes(state) && (REASONS_BY_STATE[state as VerdictState] as readonly unknown[]).includes(reason);
const rowOk = (row: unknown): boolean => typeof row === "number" && Number.isInteger(row) && row >= 1 && row <= 14;

function fingerprintOk(f: unknown): f is Fingerprint {
  return isObj(f) && typeof f.now === "string" && ISO_RE.test(f.now) && typeof f.today === "string" && isObj(f.recent)
    && typeof f.recent.from === "string" && typeof f.recent.to === "string" && isObj(f.den);
}

/** The shape `decide` relies on (plus the leaf check above). */
function decisionOk(d: unknown): d is PersistedDecision {
  if (!isObj(d) || !safeJson(d, 0, { n: 50_000 })) return false;
  if (!stateOk(d.state, d.reason) || !rowOk(d.row) || typeof d.pending !== "boolean" || typeof d.blindSpot !== "boolean") return false;
  if (!Array.isArray(d.trace) || !Array.isArray(d.candidates) || !isObj(d.observation)) return false;
  if (!d.trace.every((t) => isObj(t) && rowOk(t.row) && typeof t.matched === "boolean" && Array.isArray(t.conditions))) return false;
  if (!d.candidates.every((c) => isObj(c) && typeof c.event === "string" && typeof c.class === "string" && typeof c.status === "string")) return false;
  if (d.onset !== null && !(isObj(d.onset) && typeof d.onset.from === "string" && typeof d.onset.to === "string")) return false;
  if (!isObj(d.persistence) || !fingerprintOk(d.persistence.fingerprint)) return false;
  const c = d.persistence.candidate;
  if (c !== null && !(isObj(c) && stateOk(c.state, c.reason) && rowOk(c.row) && fingerprintOk(c.since))) return false;
  return true;
}

const keyOf = (k: DecisionKey): string => JSON.stringify([k.errorsVote, k.methodId, k.version]);

/** The file's document when it is ours and written under the key in force; else null. */
function ownDoc(path: string, key: DecisionKey): Record<string, unknown> | null {
  const doc = readOwnJson(path, MAX_BYTES);
  if (!isObj(doc) || doc.schema !== DECISIONS_SCHEMA || !isObj(doc.agents)) return null;
  if (keyOf({ errorsVote: String(doc.errorsVote), methodId: doc.methodId === null ? null : String(doc.methodId), version: Number(doc.version) }) !== keyOf(key)) return null;
  return doc;
}

/** Previous decisions by agent, for the key in force (see the header). */
export function loadDecisions(path: string, key: DecisionKey): Map<string, Decision> {
  const out = new Map<string, Decision>();
  const doc = ownDoc(path, key);
  if (doc === null) return out;
  for (const [agent, d] of Object.entries(doc.agents as Record<string, unknown>)) {
    if (!AGENT_RE.test(agent) || !decisionOk(d)) continue;
    out.set(agent, revive(d));
  }
  return out;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function recordOk(r: unknown): r is EtaRecord {
  if (!isObj(r) || Object.keys(r).length !== 5) return false;
  const tierOk = r.tier === null || r.tier === 1 || r.tier === 2 || r.tier === 3;
  const etaOk = r.eta === null || (typeof r.eta === "string" && DAY_RE.test(r.eta));
  return typeof r.day === "string" && DAY_RE.test(r.day) && typeof r.ready === "boolean" && typeof r.notAtPace === "boolean" && tierOk && etaOk
    && (r.tier === null) === (r.eta === null);
}

/**
 * Each agent's progress records (D64) for the key in force, oldest first, one per day, at most ETA_HISTORY_KEEP. An
 * agent whose list is not an array of valid records gets none (its dates wait until they are stable again).
 */
export function loadProgressHistory(path: string, key: DecisionKey): Map<string, EtaRecord[]> {
  const out = new Map<string, EtaRecord[]>();
  const doc = ownDoc(path, key);
  const p = doc?.progress;
  if (!isObj(p) || p.schema !== PROGRESS_SCHEMA || !isObj(p.agents)) return out;
  for (const [agent, list] of Object.entries(p.agents)) {
    if (!AGENT_RE.test(agent) || !Array.isArray(list) || list.length > ETA_HISTORY_KEEP || !list.every(recordOk)) continue;
    const records = list.map((r: EtaRecord): EtaRecord => ({ day: r.day, ready: r.ready, tier: r.tier, eta: r.eta, notAtPace: r.notAtPace }));
    out.set(agent, priorRecords(records, "9999-12-31").slice(-ETA_HISTORY_KEEP));
  }
  return out;
}

/** A persisted decision as `decide` takes it (`raw` and `rule` are never read; filled for the type). */
function revive(d: PersistedDecision): Decision {
  const verdict: Verdict = {
    state: d.state, reason: d.reason as VerdictReason | null, row: d.row, trace: d.trace, onset: d.onset, candidates: d.candidates,
    blindSpot: d.blindSpot, observation: d.observation, singleIndicator: d.singleIndicator ?? null,
  };
  return { ...verdict, pending: d.pending, raw: verdict, persistence: { fingerprint: d.persistence.fingerprint, candidate: d.persistence.candidate, rule: "same" } };
}

/** What is written for one decision (see the header). */
export function persisted(d: Decision): PersistedDecision {
  return {
    state: d.state, reason: d.reason, row: d.row, trace: d.trace, onset: d.onset, candidates: d.candidates,
    blindSpot: d.blindSpot, observation: d.observation, singleIndicator: d.singleIndicator, pending: d.pending,
    persistence: { fingerprint: d.persistence.fingerprint, candidate: d.persistence.candidate },
  };
}

export function serializeDecisions(key: DecisionKey, decisions: ReadonlyMap<string, Decision>, progress?: ReadonlyMap<string, readonly EtaRecord[]>): string {
  const agents: Record<string, PersistedDecision> = {};
  for (const agent of [...decisions.keys()].sort()) agents[agent] = persisted(decisions.get(agent)!);
  const doc: DecisionsFile = { schema: DECISIONS_SCHEMA, errorsVote: key.errorsVote, methodId: key.methodId, version: key.version, agents };
  if (progress !== undefined) {
    const history: Record<string, EtaRecord[]> = {};
    for (const agent of [...progress.keys()].sort()) {
      history[agent] = progress.get(agent)!.slice(-ETA_HISTORY_KEEP).map((r) => ({ day: r.day, ready: r.ready, tier: r.tier, eta: r.eta, notAtPace: r.notAtPace }));
    }
    doc.progress = { schema: PROGRESS_SCHEMA, agents: history };
  }
  return `${JSON.stringify(doc)}\n`;
}

export function saveDecisions(path: string, key: DecisionKey, decisions: ReadonlyMap<string, Decision>, progress?: ReadonlyMap<string, readonly EtaRecord[]>): void {
  writeIfChanged(path, serializeDecisions(key, decisions, progress), MAX_BYTES);
}

/**
 * Whether a pending decision could resolve differently now than at its last evaluation although no input of the
 * analysis moved (the scan's reuse shortcut must then recompute). A pending outcome is confirmed by data conditions
 * (new session-days and denominator: inputs of the digest) AND by ≥ `minHours` of data time since its anchor — the
 * one condition that moves with the clock alone. So: due when that wait ended between the last evaluation
 * (`persistence.fingerprint.now`) and `now`, or when the clock went backward since the last evaluation (persistence
 * re-anchors). Anything unreadable counts as due.
 */
export function persistenceDue(decisions: ReadonlyMap<string, Decision>, now: Date, minHours: number = PERSISTENCE_DEFAULTS.minHours): boolean {
  const cur = now.getTime();
  for (const d of decisions.values()) {
    const c = d.persistence.candidate;
    if (c === null) continue;
    const last = Date.parse(d.persistence.fingerprint.now), anchor = Date.parse(c.since.now);
    if (!Number.isFinite(last) || !Number.isFinite(anchor) || !Number.isFinite(cur)) return true;
    if (cur < last) return true;
    const due = anchor + minHours * 3_600_000;
    if (last < due && due <= cur) return true;
  }
  return false;
}
