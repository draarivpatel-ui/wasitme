import type { Exchange, InteractiveClass } from "../../types.js";
import { localDay, median, Tally } from "../../util.js";
import type { ErrorSide, ToolUse } from "./records.js";
import { SpanClock } from "./span.js";
import type { TokenSink } from "./steps.js";

/** How many preceding tool calls (across exchange boundaries) count as "recently read" for blind edits. */
export const BLIND_WINDOW = 10;

interface RecentTool { path: string | undefined; knows: boolean }

/** Session-level ring of the last BLIND_WINDOW main-thread tool calls (paths in memory only). */
export class RecentTools {
  private ring: RecentTool[] = [];
  knows(path: string): boolean {
    return this.ring.some((r) => r.knows && r.path === path);
  }
  push(t: ToolUse): void {
    this.ring.push({ path: t.path, knows: t.knows });
    if (this.ring.length > BLIND_WINDOW) this.ring.shift();
  }
}

export interface ExchangeIds { id: string; session: string; project: string }

/** Mutable accumulator for one exchange while its records stream past. */
export class ExchangeAcc implements TokenSink {
  t: string | undefined;
  /** uuid of the record that opened the exchange (feeds the stable exchange id). */
  readonly firstId: string | undefined;
  readonly humanPrompt: 0 | 1;
  readonly afterCompaction: boolean;
  promptChars = 0;
  interrupted: 0 | 1 = 0;
  pushback: 0 | 1 = 0;
  queuedMidTurn = 0;
  steps = 0;
  toolCalls = 0;
  toolErrors = 0;
  /** The split of toolErrors (METHOD.md §3): edit/apply and other non-command failures vs command failures. */
  toolErrorsEdit = 0;
  toolErrorsCmd = 0;
  /** Command tool calls that ran (rejected / blocked ones are taken back when their result says so). */
  cmdCalls = 0;
  /** Opening prompt judged English (language.ts); undefined = unknown or no prompt. Text never kept. */
  promptEnglish: 0 | 1 | undefined;
  rejections = 0;
  blocked = 0;
  reads = 0;
  edits = 0;
  blindEdits = 0;
  outTok = 0;
  inTok = 0;
  cacheRead = 0;
  cacheWrite = 0;
  apiErrors = 0;
  apiRetries = 0;
  compactions = 0;
  thinkBlocks = 0;
  thinkRedacted = 0;
  subToolCalls = 0;
  subTokens = 0;
  /** Research work of attributed subagents and sidechain records (D62a; blind rule in types.ts `subBlindEdits`). */
  subReads = 0;
  subEdits = 0;
  subBlindEdits = 0;
  /** Token usage of sidechain responses logged in the main transcript (added to subTokens). */
  readonly sideTokens: TokenSink = { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0 };
  readonly labels = { version: new Tally(), model: new Tally(), effort: new Tally(), mode: new Tally(), entrypoint: new Tally() };

  private readonly clock = new SpanClock();
  private sigLens: number[] = [];
  /** Files whose content became known in this exchange (paths in memory only). */
  private known = new Set<string>();
  private editsPerFile = new Map<string, number>();
  /** Sidechain records' own view: files they saw, and modifying edits to files they had not seen (paths in memory only). */
  private sideKnown = new Set<string>();
  private sideUnseen: string[] = [];

  /** Permission mode in effect when the exchange opened (label fallback when no response was logged). */
  private readonly openMode: string | undefined;

  constructor(opts: { t: string | undefined; firstId: string | undefined; human: boolean; afterCompaction: boolean; mode?: string | undefined }) {
    this.t = opts.t;
    this.firstId = opts.firstId;
    this.humanPrompt = opts.human ? 1 : 0;
    this.afterCompaction = opts.afterCompaction;
    this.openMode = opts.mode;
  }

  /** A main-thread user/assistant record stamped `iso` belongs to this exchange. */
  tick(iso: string): void {
    if (!this.t) this.t = iso;
    this.clock.add(Date.parse(iso));
  }

  /** A failed tool call (not a rejection, block or interrupt), on its side of the split. */
  toolError(side: ErrorSide): void {
    this.toolErrors++;
    if (side === "cmd") this.toolErrorsCmd++;
    else this.toolErrorsEdit++;
  }

  thinking(signature: string | undefined, redacted: boolean): void {
    this.thinkBlocks++;
    if (redacted) this.thinkRedacted++;
    if (signature) this.sigLens.push(signature.length);
  }

  /** A command call whose result says it never ran (user rejection, permission / auto-mode block). */
  commandNotRun(): void {
    if (this.cmdCalls > 0) this.cmdCalls--;
  }

  tool(t: ToolUse, recent: RecentTools): void {
    this.toolCalls++;
    if (t.isCommand) this.cmdCalls++;
    if (t.isRead) this.reads++;
    if (t.isEdit) this.edits++;
    // Without a path (e.g. unparsed tool input) blindness can't be judged, so it is never guessed.
    if (t.path) {
      if (t.modifies && !this.known.has(t.path) && !recent.knows(t.path)) this.blindEdits++;
      if (t.isEdit) this.editsPerFile.set(t.path, (this.editsPerFile.get(t.path) ?? 0) + 1);
      if (t.knows) this.known.add(t.path);
    }
    recent.push(t);
  }

  /**
   * A tool call of a sidechain record inside the main transcript (an aside, or a legacy in-file subagent): context
   * (subToolCalls) and delegated research work (D62a), never a main-thread call.
   */
  sideTool(t: ToolUse): void {
    this.subToolCalls++;
    if (t.isRead) this.subReads++;
    if (t.isEdit) this.subEdits++;
    if (!t.path) return;
    if (t.modifies && !this.sideKnown.has(t.path)) this.sideUnseen.push(t.path);
    if (t.knows) this.sideKnown.add(t.path);
  }

  /**
   * Research work delegated to an attributed subagent: its reads and edits, and its modifying edits to files it had not
   * seen — blind unless this exchange's main thread made the file known (a forked subagent shares that context).
   */
  delegated(reads: number, edits: number, unseen: readonly string[]): void {
    this.subReads += reads;
    this.subEdits += edits;
    for (const p of unseen) if (!this.known.has(p)) this.subBlindEdits++;
  }

  /**
   * True if this exchange carries anything worth reporting. An agent-initiated stretch that holds
   * only an interrupt, a queued prompt or a tool outcome still counts (e.g. right after the
   * replayed history at the start of a resumed file).
   */
  get meaningful(): boolean {
    return this.humanPrompt === 1 || this.steps > 0 || this.toolCalls > 0 || this.apiErrors > 0 || this.apiRetries > 0
      || this.interrupted === 1 || this.queuedMidTurn > 0 || this.rejections > 0 || this.blocked > 0 || this.toolErrors > 0;
  }

  finish(ids: ExchangeIds, seq: number, timeZone: string | undefined, interactiveClass: InteractiveClass): Exchange | undefined {
    if (!this.t) return undefined;
    const model = this.labels.model.top() ?? "unknown";
    let churned: 0 | 1 = 0;
    for (const n of this.editsPerFile.values()) if (n >= 3) churned = 1;
    this.delegated(0, 0, this.sideUnseen);
    this.sideUnseen = [];
    const ex: Exchange = {
      v: 1,
      agent: "claude-code",
      id: ids.id,
      session: ids.session,
      project: ids.project,
      t: this.t,
      day: localDay(this.t, timeZone),
      version: this.labels.version.top() ?? "unknown",
      model,
      servedModel: model,
      effort: this.labels.effort.top() ?? "unknown",
      mode: this.labels.mode.top() ?? this.openMode ?? "unknown",
      entrypoint: this.labels.entrypoint.top() ?? "unknown",
      interactiveClass,
      seq,
      afterCompaction: this.afterCompaction,
      promptChars: this.promptChars,
      humanPrompt: this.humanPrompt,
      promptEnglish: this.promptEnglish,
      interrupted: this.interrupted,
      pushback: this.pushback,
      queuedMidTurn: this.queuedMidTurn,
      steps: this.steps,
      toolCalls: this.toolCalls,
      toolErrors: this.toolErrors,
      toolErrorsEdit: this.toolErrorsEdit,
      toolErrorsCmd: this.toolErrorsCmd,
      cmdCalls: this.cmdCalls,
      rejections: this.rejections,
      blocked: this.blocked,
      reads: this.reads,
      edits: this.edits,
      blindEdits: this.blindEdits,
      churned,
      outTok: this.outTok,
      inTok: this.inTok,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      apiErrors: this.apiErrors,
      apiRetries: this.apiRetries,
      compactions: this.compactions,
      thinkBlocks: this.thinkBlocks,
      thinkRedacted: this.thinkRedacted,
      thinkSigMedian: median(this.sigLens),
      subToolCalls: this.subToolCalls,
      subTokens: this.subTokens + this.sideTokens.inTok + this.sideTokens.outTok + this.sideTokens.cacheRead + this.sideTokens.cacheWrite,
      subReads: this.subReads,
      subEdits: this.subEdits,
      subBlindEdits: this.subBlindEdits,
      durationMs: this.clock.ms,
    };
    this.known.clear();
    this.sideKnown.clear();
    this.editsPerFile.clear();
    this.sigLens = [];
    return ex;
  }
}
