/**
 * Session class for voting (METHOD.md §2: only interactive sessions vote). One class per session file, stamped on
 * every exchange of that file.
 *
 * Evidence comes only from the file's own main-thread records: replayed history (another session's records),
 * sidechain asides and subagent transcripts never count.
 *  - `entrypoint` (on user and assistant records) decides: a human-driven surface (cli, claude-desktop,
 *    claude-vscode) or a programmatic one (sdk-*, mcp, the GitHub Action).
 *  - `origin.kind` / the legacy prompt filter: an interactive surface needs at least one human prompt (typed or
 *    queued mid-turn). Work driven only by task notifications or peer messages is not shown to be interactive.
 *  - `promptSource` cannot tell surfaces apart on its own: Desktop and the IDE deliver typed prompts through the
 *    SDK ("sdk"), and the CLI marks them "typed". It is used only as evidence of a keyboard: "typed" on a
 *    programmatic surface is a contradiction, and with no entrypoint at all it is enough for `interactive`.
 *
 * `unknown` means the fields were missing, unrecognised or contradictory (types.ts). It never votes.
 */
import type { InteractiveClass } from "../../types.js";
import { entrypointClass } from "./labels.js";

export class SessionClassifier {
  private interactiveSurface = false;
  private scriptedSurface = false;
  private unrecognisedSurface = false;
  private humanPrompts = 0;
  private typed = false;

  /** An own main-thread record's raw entrypoint (in memory only). */
  entrypoint(raw: unknown): void {
    if (typeof raw !== "string" || !raw.trim()) return;
    const c = entrypointClass(raw.trim());
    if (c === "interactive") this.interactiveSurface = true;
    else if (c === "scripted") this.scriptedSurface = true;
    else this.unrecognisedSurface = true;
  }

  /** A real human prompt (opening or queued mid-turn) with its raw `promptSource`, if any. */
  humanPrompt(promptSource: unknown): void {
    this.humanPrompts++;
    if (promptSource === "typed") this.typed = true;
  }

  get value(): InteractiveClass {
    if (this.unrecognisedSurface) return "unknown";
    if (this.interactiveSurface && this.scriptedSurface) return "unknown";
    if (this.scriptedSurface) return this.typed ? "unknown" : "scripted";
    if (this.interactiveSurface) return this.humanPrompts > 0 ? "interactive" : "unknown";
    return this.typed ? "interactive" : "unknown";
  }
}
