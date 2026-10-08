/**
 * Event classification for attribution (the side × strength table of METHOD.md §9). Pure, no I/O, no clock reads.
 *
 * Rules, first match wins:
 *  1. side `meta` → meta (skipped).
 *  2. A TRIPWIRE event (marked `tripwire`, or kind `served-model`, or an agent·strong `system-prompt`) → agent_strong
 *     only when its tripwire option is on and its side is `agent`; otherwise context. Tripwires are OFF by default
 *     (S11 / S-TRIP admissibility; METHOD.md §9, D56).
 *  3. kind `system-prompt` → agent_routine when it rode a version bump (agent · routine), else context: prompt
 *     hashes are context only (METHOD.md §9 "Prompt hashes are context only"). The Claude reader labels a non-bump prompt
 *     change unknown · weak; as an `unknown` candidate it would fire row 5 on nearly every shift.
 *  4. side `agent`: kind `version` → agent_routine whatever its strength; any other agent·strong event is
 *     context (METHOD.md §9 admits agent·strong only through a tripwire); agent·routine/weak → agent_routine.
 *  5. side `you`: strong → you_strong; weak / routine → you_weak; strength missing → unknown (cannot tell it is
 *     strong; an `unknown` candidate makes the verdict less specific, never more).
 *  6. side `unknown`, or any side this version does not know → unknown (CONTRACT: an unknown side is never `agent`).
 *
 * Days: an event belongs to the local day the reader gave it (`day`). A clock that went backward moves `t` but the
 * analysis never orders by `t`; `t` only breaks ties for display order. An event with no valid `day` falls back to
 * its `t` in the evaluation's time zone; with neither it is "undated" (see decide.ts: a decisive undated event
 * counts as an `unknown` candidate).
 */
import type { ChangeEvent } from "../../types.js";
import { localDay } from "../../util.js";
import { dayIndex } from "../stats/ratio.js";
import type { AttributionEvent, EventClass, Tripwire, TripwireOptions } from "./types.js";

/** The tripwire an event carries (explicit marker first), or null. */
export function tripwireOf(e: AttributionEvent): Tripwire | null {
  if (e.tripwire === "served_model" || e.tripwire === "vendor_template" || e.tripwire === "cache_miss") return e.tripwire;
  if (e.kind === "served-model") return "served_model";
  if (e.kind === "system-prompt" && e.side === "agent" && e.strength === "strong") return "vendor_template";
  return null;
}

export function tripwireAdmitted(t: Tripwire, opts: Readonly<TripwireOptions>): boolean {
  switch (t) {
    case "served_model": return opts.servedModel === true;
    case "vendor_template": return opts.vendorTemplate === true;
    case "cache_miss": return opts.cacheMiss === true;
  }
}

/** Classify one event (see the file header). Pure. */
export function classifyEvent(e: AttributionEvent, tripwires: Readonly<TripwireOptions>): EventClass {
  if (e.side === "meta") return { class: "meta", tripwire: null, admitted: false };
  const tw = tripwireOf(e);
  if (tw !== null) {
    const admitted = tripwireAdmitted(tw, tripwires);
    return { class: admitted && e.side === "agent" ? "agent_strong" : "context", tripwire: tw, admitted };
  }
  if (e.kind === "system-prompt") {
    return { class: e.side === "agent" && e.strength === "routine" ? "agent_routine" : "context", tripwire: null, admitted: false };
  }
  if (e.side === "agent") {
    if (e.kind === "version") return { class: "agent_routine", tripwire: null, admitted: false };
    return { class: e.strength === "strong" ? "context" : "agent_routine", tripwire: null, admitted: false };
  }
  if (e.side === "you") {
    if (e.strength === "strong") return { class: "you_strong", tripwire: null, admitted: false };
    if (e.strength === "weak" || e.strength === "routine") return { class: "you_weak", tripwire: null, admitted: false };
    return { class: "unknown", tripwire: null, admitted: false };
  }
  return { class: "unknown", tripwire: null, admitted: false };
}

/** The event's local day: `day` when valid, else `t` in `timeZone`, else null (undated). Never throws. */
export function eventDay(e: Pick<ChangeEvent, "day" | "t">, timeZone: string): string | null {
  if (typeof e.day === "string" && dayIndex(e.day) !== undefined) return e.day;
  if (typeof e.t === "string") {
    const ms = Date.parse(e.t);
    if (Number.isFinite(ms)) {
      try {
        const d = localDay(new Date(ms).toISOString(), timeZone);
        if (dayIndex(d) !== undefined) return d;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Canonical event order: by day (undated last), then `t` as a string, then id. Deterministic for any input order;
 * `t` only breaks ties inside a day, so a clock that went backward can reorder events within a day at most.
 */
export function compareEvents(a: AttributionEvent, b: AttributionEvent, timeZone: string): number {
  const da = eventDay(a, timeZone), db = eventDay(b, timeZone);
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da < db ? -1 : 1;
  }
  const ta = str(a.t), tb = str(b.t);
  if (ta !== tb) return ta < tb ? -1 : 1;
  const ia = str(a.id), ib = str(b.id);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/**
 * One agent's events from several sources: other agents' events dropped, duplicates by id dropped (the first in
 * canonical order kept), sorted canonically. Input is never mutated.
 */
export function mergeEvents(agent: string, timeZone: string, ...lists: readonly (readonly AttributionEvent[])[]): AttributionEvent[] {
  const all: AttributionEvent[] = [];
  for (const list of lists) for (const e of list) if (e && typeof e === "object" && String(e.agent) === agent) all.push(e);
  all.sort((a, b) => compareEvents(a, b, timeZone));
  const seen = new Set<string>();
  const out: AttributionEvent[] = [];
  for (const e of all) {
    const id = str(e.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(e);
  }
  return out;
}

/** True when `day` lies in [from, to] (inclusive "YYYY-MM-DD" strings). */
export function dayIn(day: string, r: { from: string; to: string }): boolean {
  return day >= r.from && day <= r.to;
}
