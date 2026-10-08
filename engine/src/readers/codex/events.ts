/**
 * Change events visible inside one rollout (main threads only — subagent/exec threads run with their own
 * settings and would be noise). Labels are allow-listed; config fingerprints are salted short hashes.
 *
 * Side, strength and provenance follow METHOD.md §9 (and CONTRACT freeze decision 9: `unknown` events are `weak`):
 *  - model / effort / approval mode applied by an explicit `thread_settings_applied` record → you · strong ·
 *    command; moved with no such record (a picker, a CLI flag, a profile, another surface) → unknown · weak ·
 *    log_field (D33), never `you` by inference and never `agent`;
 *  - `cli_version` → agent · routine (background only);
 *  - base_instructions hash: at a version bump → agent · routine; otherwise you · weak (context only). It is never a
 *    deciding event: not `strong`, and never `unknown` either, because an `unknown` candidate inside the onset
 *    interval decides `unclear` (METHOD.md §11 row 5);
 *  - dynamic tools: at a version bump → agent · routine; otherwise unknown · weak;
 *  - `model_provider` switch (salted short hash, never the name) → you · strong (a gateway / proxy / provider the
 *    user configured; METHOD.md §9, D51).
 * Every log-derived event has provenance `log_field` unless a command record explains it.
 *
 * A rollout normally has a single own session_meta, so version / instructions / dynamic-tools / provider events
 * only fire here when a session re-emits its meta (e.g. resumed under a newer CLI). Version, model and effort
 * changes *between* sessions are visible downstream through each Exchange's labels; a provider switch between
 * sessions has no Exchange label, so the reader emits it from the thread index (codex.ts, `providerEvent`).
 */
import type { ChangeEvent, ChangeKind, ChangeProvenance, ChangeSide, ChangeStrength, HashFn } from "../../types.js";
import { localDay } from "../../util.js";
import type { CtxObservation, ThreadParse } from "./model.js";

export interface EventContext { hash: HashFn; timeZone?: string }

/** Fixed notes (engine-owned, never log text). */
export const NOTE = {
  provider: "model_provider changed",
  tools: "dynamic tools changed",
  instructions: "base instructions changed (context only)",
} as const;

interface Who { side: ChangeSide; strength: ChangeStrength; provenance: ChangeProvenance }

const YOU_COMMAND: Who = { side: "you", strength: "strong", provenance: "command" };
const YOU_STRONG_LOG: Who = { side: "you", strength: "strong", provenance: "log_field" };
const YOU_CONTEXT: Who = { side: "you", strength: "weak", provenance: "log_field" };
const UNKNOWN: Who = { side: "unknown", strength: "weak", provenance: "log_field" };
const ROUTINE: Who = { side: "agent", strength: "routine", provenance: "log_field" };

function event(ctx: EventContext, kind: ChangeKind, from: string, to: string, ts: number, who: Who, extra: Partial<ChangeEvent> = {}): ChangeEvent {
  const t = new Date(ts).toISOString();
  return {
    id: ctx.hash(`codex|${kind}|${from}|${to}|${t}`, "e-"),
    t, day: localDay(t, ctx.timeZone), agent: "codex", kind, side: who.side, from, to, evidence: "log",
    strength: who.strength, provenance: who.provenance, ...extra,
  };
}

/** A `model_provider` switch (from / to are salted short hashes). */
export function providerEvent(ctx: EventContext, from: string, to: string, ts: number): ChangeEvent {
  return event(ctx, "config", from, to, ts, YOU_STRONG_LOG, { note: NOTE.provider });
}

const SETTINGS: { key: "model" | "effort" | "mode"; kind: ChangeKind }[] = [
  { key: "model", kind: "model" }, { key: "effort", kind: "effort" }, { key: "mode", kind: "mode" },
];

/** model / effort / approval changes between turn_contexts. */
function settingEvents(obs: CtxObservation[], ctx: EventContext): ChangeEvent[] {
  const out: ChangeEvent[] = [];
  for (const { key, kind } of SETTINGS) {
    let prev: string | undefined;
    const explicit: string[] = []; // values the user applied via thread settings since `prev`
    for (const o of obs) {
      for (const s of o.settings) { const v = s[key]; if (v) explicit.push(v); }
      const value = o[key];
      if (!value) continue;
      if (prev !== undefined && value !== prev && o.ts !== undefined) {
        // Only an explicit settings record is a command; anything else moved with no record (D33).
        const userInitiated = explicit.includes(value);
        out.push(event(ctx, kind, prev, value, o.ts, userInitiated ? YOU_COMMAND : UNKNOWN, { userInitiated }));
      }
      prev = value;
      explicit.length = 0;
    }
  }
  return out;
}

/** Version / base-instructions / dynamic-tools / provider changes between the thread's own session_meta records. */
function metaEvents(thread: ThreadParse, ctx: EventContext): ChangeEvent[] {
  const out: ChangeEvent[] = [];
  for (let i = 1; i < thread.metas.length; i++) {
    const a = thread.metas[i - 1]!, b = thread.metas[i]!;
    if (b.ts === undefined) continue;
    const versionChanged = a.version !== b.version;
    if (versionChanged) out.push(event(ctx, "version", a.version, b.version, b.ts, ROUTINE));
    if (a.instructions && b.instructions && a.instructions !== b.instructions) {
      out.push(event(ctx, "system-prompt", a.instructions, b.instructions, b.ts, versionChanged ? ROUTINE : YOU_CONTEXT,
        versionChanged ? {} : { note: NOTE.instructions }));
    }
    if (a.tools && b.tools && a.tools !== b.tools) {
      out.push(event(ctx, "config", a.tools, b.tools, b.ts, versionChanged ? ROUTINE : UNKNOWN, { note: NOTE.tools }));
    }
    if (a.provider && b.provider && a.provider !== b.provider) out.push(providerEvent(ctx, a.provider, b.provider, b.ts));
  }
  return out;
}

/** Threads whose settings are a person's: not driven by another agent, not a `codex exec` run. */
export const emitsEvents = (thread: Pick<ThreadParse, "automated" | "scripted">): boolean => !thread.automated && !thread.scripted;

export function changeEvents(thread: ThreadParse, ctx: EventContext): ChangeEvent[] {
  if (!emitsEvents(thread)) return [];
  return [...metaEvents(thread, ctx), ...settingEvents(thread.observations, ctx)];
}
