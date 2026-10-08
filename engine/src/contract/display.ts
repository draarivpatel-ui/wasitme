/**
 * The consumer display rules (docs/CONTRACT.md#display-rules), as a reference implementation. The engine's own
 * surfaces (CLI, status-line files) use it; the Swift app and the Claude Code mod implement the same rules and are
 * held to them by contract/fixtures/manifest.json.
 *
 * Order, first match wins:
 *   1. not a JSON object, or `schema` is not the expected id      → "mismatch" ("Update needed")
 *   2. `privacy.containsText` is not the boolean false             → "refused" (nothing is drawn)
 *   3. generatedAt unparseable, older than staleAfterSec, or more
 *      than FUTURE_TOLERANCE_SEC in the future                     → "stale" (every agent shows stale; the last
 *                                                                    known state may be shown dimmed beside it)
 *   4. no agents                                                    → "empty"
 *   5. otherwise                                                    → "ok"; each agent shows its decoded state
 * `scanOk: false` is orthogonal: a notice beside whatever the rules above decided.
 */

import type { ChangeSide } from "../types.js";
import {
  DEFAULT_STALE_AFTER_SEC, FUTURE_TOLERANCE_SEC, decodeLead, decodeReason, decodeSide, decodeState,
} from "./vocab.js";
import type { DisplayState, Lead, VerdictReason, VerdictState } from "./vocab.js";

export type DocumentDisplay = "ok" | "stale" | "empty" | "mismatch" | "refused";

export interface DecodedAgent {
  agent: string;
  state: VerdictState;
  reason: VerdictReason | null;
  pending: boolean;
  calibrated: boolean;
  display: DisplayState;
  eventSides: ChangeSide[];
}

export interface Decoded {
  display: DocumentDisplay;
  scanFailed: boolean;
  lead: Lead;
  demo: boolean;
  agents: DecodedAgent[];
}

type Obj = { [key: string]: unknown };
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

/** Epoch ms of an RFC 3339 date-time with an explicit offset, else null (never guesses a local time). */
export function parseGeneratedAt(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = RFC3339.exec(raw);
  if (m === null) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] === "60" ? "59" : m[6]}.${(m[7] ?? "").slice(0, 3).padEnd(3, "0")}${m[8] === "z" ? "Z" : m[8]}`;
  const ms = Date.parse(iso);
  // Date.parse rolls "Feb 30" into March; re-check the calendar fields in UTC after removing the offset.
  if (!Number.isFinite(ms)) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  const year = Number(m[1]);
  const dim = month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > dim || Number(m[4]) > 23 || Number(m[5]) > 59) return null;
  return ms;
}

/** True when a document with this generatedAt/staleAfterSec must be shown as stale at `nowMs`. */
export function isStale(generatedAt: unknown, staleAfterSec: unknown, nowMs: number): boolean {
  const at = parseGeneratedAt(generatedAt);
  if (at === null) return true;
  const limit = typeof staleAfterSec === "number" && Number.isFinite(staleAfterSec) && staleAfterSec > 0 ? staleAfterSec : DEFAULT_STALE_AFTER_SEC;
  const age = nowMs - at;
  if (age < -FUTURE_TOLERANCE_SEC * 1000) return true;
  return age > limit * 1000;
}

/** Decodes a parsed glance or snapshot the way every surface must (tolerant; never throws). */
export function decodeDocument(raw: unknown, expectedSchema: string, nowMs: number): Decoded {
  const none = (display: DocumentDisplay): Decoded => ({ display, scanFailed: false, lead: "timeline", demo: false, agents: [] });
  // A mismatched or refused document is not decoded at all: nothing from it is shown.
  if (!isObj(raw) || raw.schema !== expectedSchema) return none("mismatch");
  if (!isObj(raw.privacy) || raw.privacy.containsText !== false) return none("refused");

  const stale = isStale(raw.generatedAt, raw.staleAfterSec, nowMs);
  const list = Array.isArray(raw.agents) ? raw.agents : [];
  const agents: DecodedAgent[] = list.flatMap((a): DecodedAgent[] => {
    if (!isObj(a) || typeof a.agent !== "string" || a.agent === "") return [];
    const state = decodeState(a.state);
    return [{
      agent: a.agent,
      state,
      reason: decodeReason(a.reason),
      pending: a.pending === true,
      calibrated: a.calibrated === true,
      display: stale ? "stale" : state,
      eventSides: (Array.isArray(a.events) ? a.events : []).map((e) => decodeSide(isObj(e) ? e.side : undefined)),
    }];
  });
  const display: DocumentDisplay = stale ? "stale" : agents.length === 0 ? "empty" : "ok";
  return { display, scanFailed: raw.scanOk !== true, lead: decodeLead(raw.lead), demo: raw.demo === true, agents };
}

/** One unit of an unlock item's gate counts (`progress.unlock[].have` / `.need`). */
export type GateUnit = "sessions" | "sessionDays" | "events";

/** The pair a "Next to unlock" counter shows: one unit, its count and its target. */
export interface BindingGate { unit: GateUnit; have: number; need: number }

/** Units in the gate's own order (sessions, session-days, events): a tie goes to the earlier one. */
export const GATE_UNITS: readonly GateUnit[] = ["sessions", "sessionDays", "events"];

/**
 * The unlock counter's display rule (docs/CONTRACT.md#display-rules): of the units still short of their target (a count
 * ≥ 0 below a target > 0, both finite numbers; a missing or invalid field is never read as 0), the one furthest from it
 * by `have ÷ need`; a tie goes to the earlier unit. Every surface shows this one pair, in its own unit ("7 of 10
 * session-days"), and draws the progress bar from it, so a count is never paired with the target of another quantity.
 * Null when no unit is short (only the largest-session share fails): then no count and no bar are shown.
 */
export function bindingGate(u: { have?: unknown; need?: unknown } | null | undefined): BindingGate | null {
  if (!isObj(u) || !isObj(u.have) || !isObj(u.need)) return null;
  const have = u.have, need = u.need;
  let best: BindingGate | null = null;
  for (const unit of GATE_UNITS) {
    const h = have[unit], n = need[unit];
    if (typeof h !== "number" || typeof n !== "number" || !Number.isFinite(h) || !Number.isFinite(n)) continue;
    if (!(h >= 0) || !(n > 0) || !(h < n)) continue;
    if (best === null || h / n < best.have / best.need) best = { unit, have: h, need: n };
  }
  return best;
}
