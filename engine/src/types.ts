/**
 * Shared engine contracts (engine, app and plugin). They change only with the maintainer's agreement
 * (AGENTS.md, CONTRIBUTING.md): propose a change in an issue instead of editing this file in a pull request.
 *
 * Privacy invariant: nothing in these types may carry prompt/response text, tool input/output,
 * file paths, cwd, project names, git branches, or secrets. Labels pass `cleanLabel()`;
 * identifiers are salted HMACs (`HashFn`).
 */

export type AgentId = "claude-code" | "codex";

/** Session class for voting (METHOD.md §2). `unknown`: the classifier fields were missing or contradictory. */
export type InteractiveClass = "interactive" | "scripted" | "unknown";

/** Salted, non-reversible id. `prefix` makes ids self-describing ("s-", "p-", "x-"). */
export type HashFn = (value: string, prefix: string) => string;

/**
 * One real human prompt plus everything the agent did until the next real human prompt
 * in the same main thread. Subagent work is attributed to the exchange that spawned it but
 * never creates an exchange of its own.
 */
export interface Exchange {
  v: 1;
  agent: AgentId;
  /** HMAC of agent + source key + first record id — stable across rescans. */
  id: string;
  /** HMAC of the session/thread id. */
  session: string;
  /** HMAC of the project directory (Claude: encoded project folder; Codex: session_meta.cwd). */
  project: string;
  /** ISO-8601 UTC timestamp of the prompt (or first record if agent-initiated). */
  t: string;
  /** Local calendar day "YYYY-MM-DD" of `t` in the machine's timezone at scan time. */
  day: string;

  /** Allow-listed labels (cleanLabel) or "unknown"/"other". Majority value within the exchange. */
  version: string;
  model: string;          // requested model as logged on assistant records / turn_context
  servedModel: string;    // model reported as actually serving, if the log distinguishes it; else = model
  effort: string;
  mode: string;           // permission / approval mode
  entrypoint: string;     // e.g. claude-desktop, cli, claude-vscode, vscode, exec
  /**
   * Whether this exchange's session votes (METHOD.md §2: only interactive sessions vote). Added at the contract
   * freeze; optional until WP-10Δ/11Δ fill it from promptSource/entrypoint/origin (Claude) and
   * originator/source (Codex) (required from WP-12). Absent = not yet classified.
   */
  interactiveClass?: InteractiveClass;
  /**
   * Model provider as a salted HMAC label (Codex `model_provider`; Claude: the API backend if the log names one).
   * Additive, optional (D51); lets a provider switch between sessions be seen without reading another file.
   */
  provider?: string;

  /** Position of this exchange within its session (0-based, in file order). */
  seq: number;
  /** True if a compaction happened earlier in the session. */
  afterCompaction: boolean;
  /** Length in characters of the prompt text (text itself discarded). */
  promptChars: number;
  /** 1 if this exchange started with a human prompt; 0 if agent-initiated / resumed stretch. */
  humanPrompt: 0 | 1;
  /**
   * 1 if the prompt text was judged English, 0 if not; absent = unknown (counted as not English). Derived at parse
   * time; the text is discarded. Additive, optional (D47f/D51); pushback stays off below 70% English prompts.
   */
  promptEnglish?: 0 | 1;

  interrupted: 0 | 1;
  /** Prompt reads like pushback on the previous answer (heuristic, English) or near-duplicate of previous prompt. */
  pushback: 0 | 1;
  /** Prompts the user typed while the agent was working (queued mid-turn). */
  queuedMidTurn: number;

  /** Model responses (API requests), deduplicated. Main thread only. */
  steps: number;
  toolCalls: number;
  /** Failed tool results, excluding user rejections and auto-mode/permission blocks. */
  toolErrors: number;
  /**
   * The tool-error split (METHOD.md §3), added at the contract freeze; optional until WP-10Δ/11Δ fill it (required
   * from WP-12). `toolErrorsEdit`: edit/apply and other non-command failures. `toolErrorsCmd`: command non-zero
   * exits. toolErrorsEdit + toolErrorsCmd = toolErrors.
   */
  toolErrorsEdit?: number;
  toolErrorsCmd?: number;
  /**
   * Command tool calls that ran (excluding rejections and blocks): the denominator of `cmdFailures`. Additive,
   * optional until the readers fill it (D51).
   */
  cmdCalls?: number;
  /** Tool calls the user explicitly rejected. */
  rejections: number;
  /** Tool calls blocked by auto-mode classifier / permission rules (not user, not tool failure). */
  blocked: number;
  reads: number;
  edits: number;
  /** Edits to a file with no read of that file earlier in the exchange or previous 10 tool calls. */
  blindEdits: number;
  /** 1 if any single file was edited 3+ times in this exchange. */
  churned: 0 | 1;

  outTok: number;
  /** Uncached input tokens. */
  inTok: number;
  cacheRead: number;
  cacheWrite: number;
  /** Final API failures surfaced to the user (e.g. Claude isApiErrorMessage). */
  apiErrors: number;
  /** API retry attempts (e.g. Claude system/api_error). */
  apiRetries: number;
  compactions: number;

  thinkBlocks: number;
  thinkRedacted: number;
  /** Median length of thinking signatures in this exchange (depth proxy), 0 if none. */
  thinkSigMedian: number;

  /** Subagent activity spawned during this exchange (context only, never votes). */
  subToolCalls: number;
  subTokens: number;
  /**
   * Research work (reads, edits, blind edits) done by this exchange's ATTRIBUTED subagents (D62a): Claude subagent
   * transcripts linked to the exchange and sidechain records inside it; Codex child threads attributed with evidence
   * (D39). `reads`/`edits`/`blindEdits` stay main-thread only, so the main-vs-subagent share stays visible (the 20b
   * subagent mix flag); the research metrics count both, so a vendor change in delegation can't pass for a quality
   * shift. A delegated edit is blind when it modifies a file whose content that subagent had not seen earlier in its
   * own transcript AND the spawning exchange's main thread never made known (a forked subagent inherits the main
   * thread's context). Records the main thread itself logged are never counted again as subagent work. Additive,
   * optional: absent = 0 (history parsed before D62; its research metrics are re-derived or paused by parser version).
   */
  subReads?: number;
  subEdits?: number;
  subBlindEdits?: number;
  /** Wall-clock span of the exchange in ms (0 if unknown; never negative even if clocks jumped). */
  durationMs: number;
}

export type ChangeKind =
  | "version" | "model" | "served-model" | "effort" | "mode" | "entrypoint"
  | "config" | "instructions" | "mcp" | "skills" | "plugins" | "hooks" | "system-prompt";

/**
 * Who most plausibly initiated a change (METHOD.md §9; frozen at the contract freeze, docs/CONTRACT.md).
 * - `unknown`: moved in the logs with no command record and no settings diff (Desktop picker, CLI flag, env var,
 *   another launch surface), anything before snapshots existed, a torn read. Never counts as `agent`.
 *   (Renamed from `unclear` so it can't be confused with the verdict state `unclear`.)
 * - `meta`: wasitme's own writes (key-path allow-list) or a parser-definition change; skipped by attribution.
 */
export type ChangeSide = "you" | "agent" | "unknown" | "meta";

/** How much a change can decide (METHOD.md §9). `unknown`-side events are `weak`, `meta` events `routine`. */
export type ChangeStrength = "strong" | "weak" | "routine";

/** Where the evidence for a change came from (METHOD.md §9). */
export type ChangeProvenance =
  | "command" | "settings_snapshot" | "project_snapshot" | "org_settings" | "log_field" | "attachment";

export interface ChangeEvent {
  /** Stable id: HMAC of agent+kind+from+to+t. */
  id: string;
  t: string;
  day: string;
  agent: AgentId;
  kind: ChangeKind;
  side: ChangeSide;
  /** Allow-listed labels or short hashes ("h:1a2b3c4d"), never raw content. */
  from: string;
  to: string;
  evidence: "log" | "snapshot";
  /** Added at the contract freeze; optional until the readers/configsnap fill it (required from WP-12). */
  strength?: ChangeStrength;
  /** Added at the contract freeze; optional until the readers/configsnap fill it (required from WP-12). */
  provenance?: ChangeProvenance;
  /** True if a user command (/model, /effort, settings edit) explains it. */
  userInitiated?: boolean;
  note?: string;
}

/** Per-reader parse statistics — surfaced so silent format drift is visible. */
export interface ParseStats {
  files: number;
  filesFailed: number;
  /** Lines that were not valid JSON objects (excluding a truncated final line). */
  badLines: number;
  /** Final line of a file that was cut off mid-write (normal for live sessions). */
  truncatedTail: number;
  /**
   * Record types this version doesn't recognise, with counts (format-drift warning). Keys are log-derived:
   * always write them with `bump()` (util.ts), never `obj[key] = obj[key] + 1`, so a key like "constructor" or
   * "__proto__" is counted instead of reading Object.prototype.
   */
  unknownTypes: Record<string, number>;
  /** Records skipped as duplicates (resume replays, fork copies, streaming splits). */
  duplicates: number;
  /** Records with timestamps outside [2020-01-01, now + 1 day]. */
  badTimestamps: number;
  /**
   * Earliest timestamp (epoch ms) among the records rejected only for being later than now + 1 day; absent when there
   * were none. A clock set backward makes real records look future-dated: the store re-parses the unchanged source
   * once its clock passes this (util.ts noteBadTime). Additive, optional (WP-12 review).
   */
  futureMin?: number;
}

export interface FileStamp { path: string; mtimeMs: number; size: number }

/** A unit of caching: one session's files. Re-parsed only when its fingerprint changes. */
export interface Source {
  agent: AgentId;
  /** Stable key relative to the agent root (never exported). */
  key: string;
  files: FileStamp[];
  /**
   * Digest of what OUTSIDE `files` this source's parse reads, known before parsing (D39, decided at WP-12): Codex —
   * the thread's other pages, the fork parent, the descendant threads and the provider switch from the thread index.
   * The store keeps a salted fingerprint of it next to the files' own, and re-parses the source when it moves because
   * a dependency changed or appeared — not when a dependency merely disappeared (the stored result was derived with
   * it, and history must survive the deletion of logs). Memory only; absent = nothing known before parsing (Claude
   * reports what it actually used after parsing instead: ParseResult.deps).
   */
  depKey?: string;
  /**
   * The dependencies behind `depKey` that exist right now, one string per dependency (its role, path and file
   * identity). Memory only; the store keeps salted digests of them. With it, the store tells "a dependency changed or
   * appeared" (re-parse) from "dependencies only disappeared" (keep the stored result) per source, whatever happened
   * to other sources in the same scan. Absent: the store falls back to the agent-wide rule. Additive, optional
   * (WP-12 review).
   */
  depParts?: string[];
}

export interface ParseContext {
  hash: HashFn;
  /** Scan time, injected for testability. */
  now: Date;
  /**
   * IANA timezone used to compute `day`. Required (D47e): the system zone is never assumed silently; the scan
   * resolves it once and records it with its history, so a zone change re-derives every stored `day`.
   */
  timeZone: string;
  /**
   * Store-backed record ids of earlier files (WP-12 review): lets the Claude reader's resume dedupe know an earlier
   * session's records without re-reading its log in a fresh process. Absent (read-only scans, direct reader calls):
   * everything is read from disk, as before. Additive, optional.
   */
  priorCache?: PriorCache;
}

/**
 * Per-file record ids kept by the store between processes. Ids are salted digests of record uuids (never the uuids);
 * an entry is used only while the file is exactly as it was when the ids were read (the store checks its identity).
 */
export interface PriorCache {
  /** Id space: differs whenever `id` gives different results (another salt). */
  readonly space: string;
  /** Salted id of one record uuid. */
  id(uuid: string): string;
  /** Ids of every record in `file` when stored for exactly this file, else undefined. */
  load(file: FileStamp): readonly string[] | undefined;
  /** Remember the ids of every record in `file`, read when the file matched `file`'s stamp. */
  save(file: FileStamp, ids: readonly string[]): void;
}

export interface ParseResult {
  exchanges: Exchange[];
  /** Changes visible inside this source's logs (version/model/effort/mode/mcp/skills/system-prompt…). */
  events: ChangeEvent[];
  stats: ParseStats;
  /**
   * Cross-file identity of each exchange (same order as `exchanges`), for the store's global dedupe (merge.ts,
   * "the earliest copy wins"): a salted id of the record that opened the exchange, independent of the
   * file it was read from — Claude: the opening record's uuid; Codex: the opening turn's id when it is
   * UUID-shaped and the exchange starts with a human prompt (counter ids are per-thread and never dedupe across
   * files). `null`: no identity that is safe to compare across files. Additive, optional (WP-12).
   */
  origins?: (string | null)[];
  /**
   * OTHER sources of the same reader whose content this parse actually used (Claude: the earlier sessions whose
   * records this session replays), each as the salted id `ctx.hash(source.key, "k-")` — never the key itself (keys
   * are encoded project paths). The store re-parses this source when one of them changes on disk — and not when it
   * disappears (its derived history stays). Complements `Source.depKey`, which a reader computes before parsing.
   * Additive, optional (WP-12).
   */
  deps?: string[];
}

export interface Reader {
  agent: AgentId;
  /** Root directory scanned (respecting env overrides). */
  root(): string;
  /** Cheap: stat only, no file reads. */
  list(): Source[];
  /**
   * Fill `depKey` on sources from the latest list() (WP-12, D39). May read file heads (Codex: the leading
   * session_meta of every rollout, i.e. the scan's thread index, which parse() then reuses). Optional: a reader
   * whose cross-file inputs are only known after parsing (Claude) reports them in ParseResult.deps instead.
   */
  depKeys?(sources: Source[]): void;
  parse(source: Source, ctx: ParseContext): Promise<ParseResult>;
}

/** Status of one agent's data source, surfaced in `doctor` and the UI. */
export interface SourceStatus {
  agent: AgentId;
  found: boolean;
  files: number;
  stats: ParseStats;
  firstDay?: string;
  lastDay?: string;
  error?: string;
}

/** A point-in-time fingerprint of the user's global agent configuration. Hashes/counts only. */
export interface ConfigSnapshot {
  t: string;
  agent: AgentId;
  /** Short hashes ("h:xxxxxxxx") / counts / allow-listed labels keyed by stable item ids. */
  items: Record<string, string | number | boolean>;
}

export function emptyStats(): ParseStats {
  return { files: 0, filesFailed: 0, badLines: 0, truncatedTail: 0, unknownTypes: {}, duplicates: 0, badTimestamps: 0 };
}
