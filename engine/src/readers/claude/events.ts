import type { ChangeEvent, ChangeKind, ChangeProvenance, ChangeSide, ChangeStrength, ParseContext } from "../../types.js";
import { localDay } from "../../util.js";

export type TrackedKind = Extract<ChangeKind, "version" | "model" | "effort" | "mode" | "mcp" | "skills" | "system-prompt">;

/** Short salted hash label ("h:1a2b3c4d") for content that must never leave memory. */
export function shortHash(ctx: ParseContext, value: string): string {
  return ctx.hash(value, "h:").slice(0, 10);
}

export interface ObserveOptions {
  /** Update state without emitting (replayed history, setup baselines). */
  silent?: boolean;
  /**
   * The value comes from an earlier session's history replayed into this (resumed) file. Model / effort: the
   * resumed session's first live value is then its own starting value — a between-session move that attribution
   * derives and explains with the recorded command, wherever it was typed (labels.ts) — not an in-session change,
   * unless a command typed in this file (or at the end of the replayed history) explains it (D63).
   */
  replayed?: boolean;
  note?: string;
  /** Where the value was read, when not the kind's default (e.g. a model identity attachment). */
  provenance?: ChangeProvenance;
  /** system-prompt only: the CLI version label on the record that carried the prompt, if it has one. */
  version?: string | undefined;
}

interface Attribution { side: ChangeSide; strength: ChangeStrength; provenance: ChangeProvenance }

/**
 * Side, strength and provenance of an in-log change (METHOD.md §9 table; CONTRACT freeze decision 9: `unknown` is
 * always weak, never `agent`).
 *  - version: a routine update (agent · routine), background only.
 *  - system-prompt: hashed context. At a version bump it rides with the update (agent · routine); otherwise the
 *    logs can't say who changed it (unknown · weak). Never a deciding `agent` event (METHOD.md §9).
 *  - model / effort: you · strong with a /model or /effort command record; without one (Desktop picker, CLI flag,
 *    env var, fallback) unknown · weak (D33).
 *  - mode: the session's permission mode only moves by the user's hand in-session (mode switch, plan approval),
 *    so you · strong, from the log field.
 *  - mcp: a server first announced mid-session (startup churn and reconnects excluded) — you · strong.
 *  - skills: installed by the user or newly announced by Claude Code/plugins; the logs can't tell (unknown · weak).
 */
function attribute(kind: TrackedKind, userInitiated: boolean, atBump: boolean, provenance: ChangeProvenance | undefined): Attribution {
  switch (kind) {
    case "version":
      return { side: "agent", strength: "routine", provenance: "log_field" };
    case "system-prompt":
      return atBump
        ? { side: "agent", strength: "routine", provenance: "attachment" }
        : { side: "unknown", strength: "weak", provenance: "attachment" };
    case "model":
    case "effort":
      return userInitiated
        ? { side: "you", strength: "strong", provenance: "command" }
        : { side: "unknown", strength: "weak", provenance: provenance ?? "log_field" };
    case "mode":
      return { side: "you", strength: "strong", provenance: "log_field" };
    case "mcp":
      return { side: "you", strength: "strong", provenance: "attachment" };
    case "skills":
      return { side: "unknown", strength: "weak", provenance: "attachment" };
  }
}

/**
 * Tracks setup values as records stream past and emits a ChangeEvent whenever a value differs from
 * the previous value seen in the same source. The first value is a baseline, not a change — except a model or
 * effort chosen by a /model or /effort typed before it (from "unknown": the value before is not in this source).
 * Observations from duplicate (replayed) records update state silently: that history belongs to
 * the session that first logged it.
 */
export class ChangeTracker {
  readonly events: ChangeEvent[] = [];
  private current = new Map<TrackedKind, string>();
  private pendingCommand = new Set<"model" | "effort">();
  /** Kinds whose current value only came from replayed history (see ObserveOptions.replayed). */
  private inherited = new Set<TrackedKind>();
  /** CLI version in effect at the last system-prompt observation. */
  private spVersion: string | undefined;

  /** `session`: the salted session id stamped on every event (`ChangeEvent.session`), when the caller knows it. */
  constructor(private readonly ctx: ParseContext, private readonly session?: string) {}

  value(kind: TrackedKind): string | undefined {
    return this.current.get(kind);
  }

  /** A `/model` or `/effort` command was run; the next change of that kind is user-initiated. */
  command(kind: "model" | "effort"): void {
    this.pendingCommand.add(kind);
  }

  /** A model response completed: an earlier command that changed nothing explains nothing later. */
  responded(): void {
    this.pendingCommand.clear();
  }

  observe(kind: TrackedKind, value: string | undefined, t: string | undefined, opts: ObserveOptions = {}): void {
    if (value === undefined) return;
    let atBump = false;
    if (kind === "system-prompt") {
      // "At the bump": the CLI version differs from the one in effect when the system prompt was last seen,
      // whatever order the prompt snapshot and the first new-version record were written in.
      const v = opts.version ?? this.current.get("version");
      atBump = this.spVersion !== undefined && v !== undefined && v !== this.spVersion;
      if (v !== undefined) this.spVersion = v;
    }
    const prev = this.current.get(kind);
    const inherited = this.inherited.has(kind);
    if (opts.replayed) this.inherited.add(kind);
    else if (!opts.silent) this.inherited.delete(kind);
    const command = (kind === "model" || kind === "effort") && this.pendingCommand.has(kind);
    // A resumed session whose command re-picks the replayed history's value: that history says nothing about what this
    // session opened on (the current default), so the command's choice is the user's change, from "unknown" (D63).
    const repick = inherited && command && prev === value && !opts.silent && t !== undefined;
    if (prev === value && !repick) return;
    this.current.set(kind, value);
    if (opts.silent || !t) return;
    // A resumed session opening on another model / effort than its replayed history, with no command to explain it:
    // its starting value, like a new session's (between sessions; see ObserveOptions.replayed).
    if (inherited && (kind === "model" || kind === "effort") && !command) return;
    // The first value is a baseline — unless a /model or /effort typed before it (the session's first prompt, before
    // any response; or the last command of a resumed session's history) chose it: that is the user's change, from a
    // value this session never showed (D63). Downstream, its `to` explains the between-session label move.
    if (prev === undefined && !command) return;

    const userInitiated = (kind === "model" || kind === "effort") && this.pendingCommand.delete(kind);
    const a = attribute(kind, userInitiated, atBump, opts.provenance);
    const from = repick || prev === undefined ? "unknown" : prev;
    const ev: ChangeEvent = {
      id: this.ctx.hash(`claude-code|${kind}|${from}|${value}|${t}`, "e-"),
      t,
      day: localDay(t, this.ctx.timeZone),
      agent: "claude-code",
      kind,
      side: a.side,
      from,
      to: value,
      evidence: "log",
      strength: a.strength,
      provenance: a.provenance,
    };
    if (userInitiated) ev.userInitiated = true;
    if (opts.note) ev.note = opts.note;
    if (this.session !== undefined) ev.session = this.session;
    this.events.push(ev);
  }
}
