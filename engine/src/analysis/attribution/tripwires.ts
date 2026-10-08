/**
 * Tripwire detectors (METHOD.md §9 agent · strong; the S11 + S-TRIP stability checks). Every detector here only
 * PRODUCES marked events; whether one may decide is the decision layer's call, and it is OFF by default
 * (`TRIPWIRES_OFF`): until S-TRIP shows a signal is stable on real logs, an event carrying it is context only.
 *
 *  - served_model (detector over exchanges): the served model differs from the requested model, where the
 *    requested model comes from the log (`Exchange.model`) and the served one from `Exchange.servedModel`.
 *    Excluded: non-model labels (`<synthetic>` error stubs, "unknown", "other", empty) and known mode routing
 *    (requested `opusplan`; more via `routed`). Advisor, subagent, title and side requests never reach an Exchange
 *    (main thread only). The mismatch must hold on ≥ 5 consecutive main-thread requests (Σ `steps` over a run of
 *    consecutive mismatched exchanges of one session, in `seq` order — never `t` order) in ≥ 2 sessions, for the
 *    same requested → served pair. One event per pair, dated at the earliest qualifying run's first exchange.
 *    Today's readers set `servedModel = model`, so this never fires on real logs yet.
 *  - vendor_template / cache_miss (signals): no reader records a normalised vendor-template hash or
 *    cache_miss_reason yet. A future source passes `TripwireSignal`s; one becomes an event only when it is
 *    stable (≥ 2 sessions and ≥ 5 requests). A cache_miss signal on a day with a recorded change of the user's own
 *    tools or instructions (mcp, skills, plugins, hooks, instructions, config on the `you` side) is explained by
 *    it and dropped.
 */
import type { MetricExchange } from "../metrics/defs.js";
import { dayIndex } from "../stats/ratio.js";
import { hashHex } from "../stats/rng.js";
import type { AttributionEvent, Tripwire } from "./types.js";

/** Labels that are not a model. */
export const NOT_A_MODEL: readonly string[] = Object.freeze(["<synthetic>", "unknown", "other", ""]);
/** Requested labels whose served model legitimately differs (mode routing). */
export const ROUTED_MODELS: readonly string[] = Object.freeze(["opusplan"]);
/** METHOD.md §9: ≥ 5 consecutive main-thread requests … */
export const TRIPWIRE_MIN_REQUESTS = 5;
/** … in ≥ 2 sessions. */
export const TRIPWIRE_MIN_SESSIONS = 2;

export interface ServedModelOptions {
  minRequests?: number;
  minSessions?: number;
  /** Requested labels to ignore (default ROUTED_MODELS). */
  routed?: readonly string[];
}

function tripwireId(agent: string, tripwire: Tripwire, from: string, to: string, day: string): string {
  return `t-${hashHex(`${agent}\u001f${tripwire}\u001f${from}\u001f${to}\u001f${day}`).slice(0, 16)}`;
}

function finiteSteps(x: MetricExchange): number {
  return typeof x.steps === "number" && Number.isFinite(x.steps) && x.steps > 0 ? x.steps : 0;
}

/** Served ≠ requested detector (see the file header). `used`: deduplicated interactive exchanges of one agent. */
export function servedModelTripwire(agent: string, used: readonly MetricExchange[], opts: ServedModelOptions = {}): AttributionEvent[] {
  const minRequests = opts.minRequests ?? TRIPWIRE_MIN_REQUESTS;
  const minSessions = opts.minSessions ?? TRIPWIRE_MIN_SESSIONS;
  const routed = new Set(opts.routed ?? ROUTED_MODELS);
  const bySession = new Map<string, MetricExchange[]>();
  for (const x of used) {
    if (String(x.agent) !== agent || dayIndex(x.day) === undefined) continue;
    const s = String(x.session);
    const g = bySession.get(s);
    if (g) g.push(x);
    else bySession.set(s, [x]);
  }
  const mismatch = (x: MetricExchange): string | null => {
    const req = String(x.model ?? ""), served = String(x.servedModel ?? "");
    if (NOT_A_MODEL.includes(req) || NOT_A_MODEL.includes(served) || routed.has(req) || req === served) return null;
    return `${req}\u001f${served}`;
  };
  // pair → sessions that qualify, and the earliest qualifying run start (day, t, id).
  const pairs = new Map<string, { sessions: Set<string>; first: MetricExchange }>();
  const earlier = (a: MetricExchange, b: MetricExchange) =>
    a.day !== b.day ? a.day < b.day : String(a.t) !== String(b.t) ? String(a.t) < String(b.t) : String(a.id) < String(b.id);
  for (const [session, xs] of [...bySession.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    xs.sort((a, b) => (Number(a.seq) - Number(b.seq)) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    let runKey: string | null = null, runSteps = 0, runStart: MetricExchange | null = null;
    const close = () => {
      if (runKey !== null && runStart !== null && runSteps >= minRequests) {
        const p = pairs.get(runKey) ?? { sessions: new Set<string>(), first: runStart };
        p.sessions.add(session);
        if (earlier(runStart, p.first)) p.first = runStart;
        pairs.set(runKey, p);
      }
    };
    for (const x of xs) {
      const key = mismatch(x);
      if (key !== null && key === runKey) {
        runSteps += finiteSteps(x);
        continue;
      }
      close();
      runKey = key;
      runSteps = key === null ? 0 : finiteSteps(x);
      runStart = key === null ? null : x;
    }
    close();
  }
  const out: AttributionEvent[] = [];
  for (const [key, p] of [...pairs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (p.sessions.size < minSessions) continue;
    const [from, to] = key.split("\u001f") as [string, string];
    const day = p.first.day;
    out.push({
      id: tripwireId(agent, "served_model", from, to, day),
      t: Number.isFinite(Date.parse(String(p.first.t))) ? String(p.first.t) : `${day}T00:00:00.000Z`,
      day,
      agent: agent as AttributionEvent["agent"],
      kind: "served-model",
      side: "agent",
      from,
      to,
      evidence: "log",
      strength: "strong",
      provenance: "log_field",
      tripwire: "served_model",
      derived: true,
    });
  }
  return out;
}

/** A vendor-side signal from a future source (S11 normalised hash, S-TRIP cache_miss_reason). Counts only. */
export interface TripwireSignal {
  tripwire: "vendor_template" | "cache_miss";
  day: string;
  t: string;
  /** Sessions in which the signal was seen. */
  sessions: number;
  /** Main-thread requests that carried it. */
  requests: number;
  /** Short hashes or allow-listed labels only. */
  from: string;
  to: string;
}

const OWN_TOOLS_KINDS = new Set(["mcp", "skills", "plugins", "hooks", "instructions", "config"]);

/** Stable signals → marked events (see the file header). */
export function signalEvents(agent: string, signals: readonly TripwireSignal[], recorded: readonly AttributionEvent[]): AttributionEvent[] {
  const out: AttributionEvent[] = [];
  for (const s of signals) {
    if (!s || (s.tripwire !== "vendor_template" && s.tripwire !== "cache_miss") || dayIndex(s.day) === undefined) continue;
    if (!(s.sessions >= TRIPWIRE_MIN_SESSIONS && s.requests >= TRIPWIRE_MIN_REQUESTS)) continue;
    if (s.tripwire === "cache_miss" && recorded.some((e) => String(e.agent) === agent && e.side === "you" && e.day === s.day && OWN_TOOLS_KINDS.has(e.kind))) continue;
    const from = String(s.from), to = String(s.to);
    out.push({
      id: tripwireId(agent, s.tripwire, from, to, s.day),
      t: Number.isFinite(Date.parse(String(s.t))) ? String(s.t) : `${s.day}T00:00:00.000Z`,
      day: s.day,
      agent: agent as AttributionEvent["agent"],
      kind: "system-prompt",
      side: "agent",
      from,
      to,
      evidence: "log",
      strength: "strong",
      provenance: "log_field",
      tripwire: s.tripwire,
      derived: true,
    });
  }
  return out;
}
