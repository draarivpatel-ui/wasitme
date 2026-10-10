/**
 * Between-session label changes, derived from Exchange labels (METHOD.md §9: changes found in the logs, retroactively).
 *
 * Both readers emit only the changes they see INSIDE one session (Claude's ChangeTracker is per source; the Codex
 * reader says so in its events.ts header). A version bump usually lands between sessions, and so does a Desktop
 * picker or CLI-flag model/effort switch. Without these events the version-boundary test would have no boundaries,
 * and a between-session picker switch could not block `agent` by elimination (a false-`agent` path).
 *
 * Rule, per dimension (version, model, effort), over the agent's deduplicated INTERACTIVE exchanges on complete
 * past days:
 *  - each day's label is the majority label by exchange count ("unknown" / empty labels ignored; ties keep the
 *    previous day's label when it is among the tied, else the smallest label);
 *  - a change is emitted on the first day whose majority differs from the previous active day's majority;
 *  - its `t` is the earliest `t` of that day's exchanges with the new label (display only; days decide).
 * Days, not timestamps, order everything, so a clock that went backward can never reorder the changes.
 *
 * Sides (METHOD.md §9): version → agent · routine · log_field. Model / effort → unknown · weak · log_field ("moved in the
 * logs with no command record and no settings diff", D33), unless a RECORDED event explains it: the latest recorded
 * event of the same kind dated on or before the change's day has the same `to` and has not already been used to
 * explain (or been superseded by) an earlier derived change. A `/model` switch inside a session is therefore not
 * followed by a spurious `unknown` when the next session opens on the new model. A derived version change is dropped
 * when a recorded version event with the same `to` is dated on or before it.
 *
 * Mode and entrypoint are not derived: METHOD.md §9's `unknown` row names model/effort moves; mode/entrypoint mixes are
 * strata and "also flagged" mix moves (METHOD.md §8).
 *
 * Re-picks (D65, `dropRepicks`): a `/model` or `/effort` typed as a session's first prompt, or after a resume, reaches
 * attribution as you · strong · command from "unknown". When it re-selects the value already in effect (the earlier
 * exchanges of its session, else the previous day's majority) it is not a change and is dropped before the
 * derivation runs, so it can neither decide (row 7) nor explain a day-majority move.
 *
 * Weights: by default every exchange counts once. A caller whose inputs are aggregates (the calibration harness feeds
 * session-day rows, each standing for several exchanges with identical labels) passes `weight`, the number of
 * exchanges a row stands for; the day majorities are then exactly the exchange-count majorities. A row must never
 * mix labels — Codex sessions keep their start version, so on a bump day an old session's many exchanges can
 * outvote a new session's few (a per-row count would get that wrong).
 */
import type { ChangeKind } from "../../types.js";
import type { MetricExchange } from "../metrics/defs.js";
import { dayIndex } from "../stats/ratio.js";
import { hashHex } from "../stats/rng.js";
import { eventDay } from "./events.js";
import type { AttributionEvent } from "./types.js";

export const DERIVED_KINDS = Object.freeze(["version", "model", "effort"] as const);
export type DerivedKind = (typeof DERIVED_KINDS)[number];

const IGNORED_LABELS = new Set(["", "unknown"]);

interface DayLabels {
  day: string;
  idx: number;
  /** label → { exchanges, earliest t } */
  labels: Map<string, { n: number; t: string }>;
}

function labelOf(x: MetricExchange, kind: DerivedKind): string {
  const v = (x as unknown as Record<string, unknown>)[kind];
  return typeof v === "string" ? v : "";
}

function majority(labels: Map<string, { n: number; t: string }>, previous: string | null): string | null {
  let best = -1;
  const tied: string[] = [];
  for (const [label, { n }] of labels) {
    if (n > best) {
      best = n;
      tied.length = 0;
      tied.push(label);
    } else if (n === best) tied.push(label);
  }
  if (tied.length === 0) return null;
  if (previous !== null && tied.includes(previous)) return previous;
  return tied.sort()[0]!;
}

/** Deterministic, content-free id for a derived event. */
export function derivedId(agent: string, kind: ChangeKind, from: string, to: string, day: string): string {
  return `d-${hashHex(`${agent}\u001f${kind}\u001f${from}\u001f${to}\u001f${day}`).slice(0, 16)}`;
}

function validT(t: unknown, day: string): string {
  return typeof t === "string" && Number.isFinite(Date.parse(t)) ? t : `${day}T00:00:00.000Z`;
}

/** Exchanges an input stands for in the majority count (see the file header); 1 by default. */
export type ExchangeWeight = (x: MetricExchange) => number;

const ONE: ExchangeWeight = () => 1;

/**
 * Each active day's majority label of one dimension, oldest first (days whose labels are all ignored are left out;
 * ties keep the previous day's majority when it is among the tied, else the smallest label). `t` is the earliest `t`
 * of that day's exchanges with the majority label.
 */
export function dayMajorities(used: readonly MetricExchange[], kind: DerivedKind, weight: ExchangeWeight = ONE): { day: string; idx: number; label: string; t: string }[] {
  const byDay = new Map<number, DayLabels>();
  for (const x of used) {
    const idx = dayIndex(x.day);
    if (idx === undefined) continue;
    const label = labelOf(x, kind);
    if (IGNORED_LABELS.has(label)) continue;
    let d = byDay.get(idx);
    if (!d) byDay.set(idx, (d = { day: x.day, idx, labels: new Map() }));
    const w = weight(x);
    if (!(w > 0) || !Number.isFinite(w)) throw new RangeError(`exchange weight must be a positive finite number (got ${String(w)})`);
    const t = validT(x.t, x.day);
    const cur = d.labels.get(label);
    if (cur) {
      cur.n += w;
      if (t < cur.t) cur.t = t;
    } else d.labels.set(label, { n: w, t });
  }
  const days = [...byDay.values()].sort((a, b) => a.idx - b.idx);
  const out: { day: string; idx: number; label: string; t: string }[] = [];
  let prev: string | null = null;
  for (const d of days) {
    const m = majority(d.labels, prev);
    if (m === null) continue;
    out.push({ day: d.day, idx: d.idx, label: m, t: d.labels.get(m)!.t });
    prev = m;
  }
  return out;
}

/** Raw day-majority changes of one dimension (before the recorded-event suppression). */
export function majorityChanges(used: readonly MetricExchange[], kind: DerivedKind, weight: ExchangeWeight = ONE): { day: string; from: string; to: string; t: string }[] {
  const out: { day: string; from: string; to: string; t: string }[] = [];
  let prev: string | null = null;
  for (const d of dayMajorities(used, kind, weight)) {
    if (prev !== null && d.label !== prev) out.push({ day: d.day, from: prev, to: d.label, t: d.t });
    prev = d.label;
  }
  return out;
}

/**
 * Derived between-session events for one agent (see the file header). `used` must be the agent's deduplicated
 * interactive exchanges on complete past days; `recorded` the reader/snapshot events (any agent; filtered here);
 * `weight` the exchanges each input stands for (default 1).
 */
export function labelChangeEvents(agent: string, used: readonly MetricExchange[], recorded: readonly AttributionEvent[], weight: ExchangeWeight = ONE): AttributionEvent[] {
  const out: AttributionEvent[] = [];
  for (const kind of DERIVED_KINDS) {
    const rec = recorded
      .filter((e) => e && String(e.agent) === agent && e.kind === kind && e.derived !== true && dayIndex(e.day) !== undefined)
      .slice()
      .sort((a, b) => (a.day !== b.day ? (a.day < b.day ? -1 : 1) : String(a.t) < String(b.t) ? -1 : String(a.t) > String(b.t) ? 1 : String(a.id) < String(b.id) ? -1 : 1));
    const used2 = new Set<number>();
    for (const ch of majorityChanges(used, kind, weight)) {
      if (kind === "version") {
        if (rec.some((r) => r.to === ch.to && r.day <= ch.day)) continue;
      } else {
        // Latest recorded event of this kind dated on or before the change.
        let latest = -1;
        for (let i = 0; i < rec.length; i++) if (rec[i]!.day <= ch.day) latest = i;
        if (latest >= 0 && !used2.has(latest)) {
          used2.add(latest);
          if (rec[latest]!.to === ch.to) continue;
        }
      }
      const unknown = kind !== "version";
      out.push({
        id: derivedId(agent, kind, ch.from, ch.to, ch.day),
        t: ch.t,
        day: ch.day,
        agent: agent as AttributionEvent["agent"],
        kind,
        side: unknown ? "unknown" : "agent",
        from: ch.from,
        to: ch.to,
        evidence: "log",
        strength: unknown ? "weak" : "routine",
        provenance: "log_field",
        derived: true,
      });
    }
  }
  return out;
}

// ───────────────────────────── one event per new version ─────────────────────────────

/**
 * One agent-side version event per new version (`to`). The same update reaches the merge more than once: every
 * resumed session that crossed it records its own in-session bump (a different id each, so the id dedupe keeps them
 * all), and a session that started on an older version records the bump days after the agent's day majority moved.
 * Kept: per `to`, the earliest by day, then by id — exactly the event the version-boundary test would pick
 * (evidence.ts `versionBoundaryTest`), so a boundary is never moved; later repeats are dropped. A kept event's `from`
 * becomes the previous kept version's `to` (what the agent was on; a resumed session's own `from` can be days stale);
 * ids are never changed. Versions that go back (a parallel older install) are kept: they are new `to`s, and dropping
 * them could merge two boundaries into one. Undated version events and every other kind pass through. Pure.
 *
 * Calibration (D69): on 476 null and attribution sequences of every profile, no version `to` repeated after the merge
 * (synth sessions record each bump once), so this changes no calibrated decision; it removes repeats from real logs.
 */
export function collapseVersionRepeats(agent: string, events: readonly AttributionEvent[], timeZone: string): AttributionEvent[] {
  const isVersion = (e: AttributionEvent): boolean => e.kind === "version" && e.side === "agent" && String(e.agent) === agent;
  const first = new Map<string, { e: AttributionEvent; day: string }>();
  for (const e of events) {
    if (!isVersion(e)) continue;
    const day = eventDay(e, timeZone);
    if (day === null) continue;
    const to = String(e.to);
    const cur = first.get(to);
    if (!cur || day < cur.day || (day === cur.day && String(e.id) < String(cur.e.id))) first.set(to, { e, day });
  }
  const kept = new Set([...first.values()].map((x) => x.e));
  const out: AttributionEvent[] = [];
  let prevTo: string | null = null;
  for (const e of events) {
    if (!isVersion(e) || eventDay(e, timeZone) === null) {
      out.push(e);
      continue;
    }
    if (!kept.has(e)) continue;
    out.push(prevTo !== null && e.from !== prevTo ? { ...e, from: prevTo } : e);
    prevTo = String(e.to);
  }
  return out;
}

// ───────────────────────────── re-picks (D65) ─────────────────────────────

/** A label that names a value (a re-pick's `from` is "unknown": the reader did not see the value before it). */
function knownLabel(v: unknown): v is string {
  return typeof v === "string" && !IGNORED_LABELS.has(v) && v !== "other";
}

/**
 * The model / effort in effect immediately before a recorded you·strong event (D65):
 *  1. the event's own `from`, when it names a value (an in-session switch: the reader saw the value it left);
 *  2. else the latest earlier exchange of the event's session with a known label. The event's session is the one
 *     of the exchange it happened in: the latest exchange on the event's local day with the event's `to` and a
 *     `t` at or before the event's, in the event's own session when it names one (`session`, D81: the Claude reader
 *     stamps it), else in any session (older stored events, configsnap);
 *  3. else the previous active day's majority label (the between-session derivation's rule, same weights);
 *  4. else null (nothing before it: it cannot be a re-pick).
 * `days` are the dimension's day majorities (`dayMajorities`). Pure.
 */
export function valueInEffect(e: AttributionEvent, kind: "model" | "effort", used: readonly MetricExchange[], days: readonly { day: string; label: string }[], timeZone: string): string | null {
  if (knownLabel(e.from)) return e.from;
  const day = eventDay(e, timeZone);
  if (day === null) return null;
  const at = typeof e.t === "string" ? Date.parse(e.t) : NaN;
  if (Number.isFinite(at)) {
    let host: MetricExchange | undefined;
    let hostT = -Infinity;
    // An event that names its session (ChangeEvent.session, D81) is hosted there only: a parallel session's prompt
    // can land between the command and its first response.
    const ownSession = typeof e.session === "string" && e.session !== "" ? e.session : null;
    for (const x of used) {
      if (x.day !== day || labelOf(x, kind) !== e.to) continue;
      if (ownSession !== null && x.session !== ownSession) continue;
      const t = Date.parse(String(x.t));
      if (!Number.isFinite(t) || t > at) continue;
      if (t > hostT || (t === hostT && host !== undefined && (x.seq > host.seq || (x.seq === host.seq && String(x.id) > String(host.id))))) {
        host = x;
        hostT = t;
      }
    }
    if (host !== undefined) {
      // Earlier = earlier in file order (seq); a timestamp only breaks a seq tie (clocks can run backward).
      let prev: MetricExchange | undefined;
      for (const x of used) {
        if (x === host || x.session !== host.session || !knownLabel(labelOf(x, kind))) continue;
        const before = x.seq < host.seq || (x.seq === host.seq && Date.parse(String(x.t)) < hostT);
        if (!before) continue;
        if (prev === undefined || x.seq > prev.seq || (x.seq === prev.seq && String(x.t) > String(prev.t))) prev = x;
      }
      if (prev !== undefined) return labelOf(prev, kind);
    }
  }
  let last: string | null = null;
  for (const d of days) {
    if (d.day >= day) break;
    last = d.label;
  }
  return last;
}

/**
 * D65 re-pick rule: a `/model` or `/effort` that re-selects the value already in effect (typed as a session's first
 * prompt, or after a resume) is not a change. Drops every recorded you·strong model / effort event whose `to` equals
 * the value in effect immediately before it (`valueInEffect`). Run BEFORE the between-session derivation, so a
 * dropped re-pick can never explain a day-majority move. Returns the kept events (input order) and the dropped ids.
 * Pure; the input is never mutated.
 */
export function dropRepicks(agent: string, used: readonly MetricExchange[], recorded: readonly AttributionEvent[], timeZone: string, weight: ExchangeWeight = ONE): { kept: AttributionEvent[]; dropped: string[] } {
  const days: Partial<Record<"model" | "effort", { day: string; label: string }[]>> = {};
  const kept: AttributionEvent[] = [];
  const dropped: string[] = [];
  for (const e of recorded) {
    const kind = e?.kind;
    const decisive = e !== null && typeof e === "object" && String(e.agent) === agent && (kind === "model" || kind === "effort")
      && e.side === "you" && e.strength === "strong" && e.derived !== true;
    if (!decisive) {
      kept.push(e);
      continue;
    }
    const k = kind as "model" | "effort";
    const before = valueInEffect(e, k, used, (days[k] ??= dayMajorities(used, k, weight)), timeZone);
    if (before !== null && before === e.to) dropped.push(String(e.id));
    else kept.push(e);
  }
  return { kept, dropped };
}
