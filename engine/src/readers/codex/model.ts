/**
 * In-memory model of one parsed rollout file. Holds text and paths only transiently (for heuristics);
 * nothing here is exported from the reader except derived numbers and allow-listed labels.
 */
import type { InteractiveClass } from "../../types.js";
import type { Trigger } from "./text.js";

export interface Usage { inTok: number; cacheRead: number; cacheWrite: number; outTok: number }

export interface EditPath {
  /** Normalised path ("" if the log did not say which file). Memory only. */
  path: string;
  /** File created by this change (cannot have been read first). */
  isNew: boolean;
}

export interface ToolEvent {
  /**
   * The tool-error split (METHOD.md §3): `cmd` = a shell command (CommandExecution, exec_command_end, a shell-type
   * response_item call), whose failures are non-zero exits (`toolErrorsCmd`); `other` = every other call
   * (FileChange / patch, McpToolCall, collab, extensions, …), whose failures are `toolErrorsEdit`.
   */
  kind: "cmd" | "other";
  failed: boolean;
  /** The user declined the call. */
  rejected: boolean;
  /** A command whose parsed parts only read/search/list files. */
  read: boolean;
  /** Files read by this call (normalised, memory only). */
  readPaths: string[];
  edits: EditPath[];
}

export interface Msg {
  ts?: number;
  trigger: Trigger;
  /** Human text (memory only). */
  text: string;
  images: boolean;
}

/**
 * One Codex turn (`turn_id`, or a synthetic turn for legacy records without ids), with the
 * history-mode-specific sources already resolved to a single one each per turn (never both).
 */
export interface Turn {
  key: string;
  /** Stable id of the turn's first record (turn id, else ordinal / line index). */
  firstRecordId: string;
  firstTs?: number;
  minTs?: number;
  maxTs?: number;
  /**
   * The turn's valid record times in file order, and each one's position among all records of the file (so the turns
   * of one exchange can be merged back into file order). The exchange's wall-clock span is measured over them with the
   * Claude reader's SpanClock, never as max minus min: clocks get reset mid-exchange. Absent: no times known.
   */
  stamps?: number[];
  stampOrder?: number[];
  versions: string[];
  models: string[];
  efforts: string[];
  modes: string[];
  messages: Msg[];
  tools: ToolEvent[];
  usage: Usage[];
  compactions: number;
  interrupted: boolean;
  abortTs?: number;
  apiErrors: number;
  apiRetries: number;
  thinkBlocks: number;
  thinkRedacted: number;
  thinkSigs: number[];
  /** root_turn_id values seen on this turn (subagent → root-thread turn linkage). */
  rootTurnIds: Set<string>;
  /**
   * Thread ids this turn's spawn items name (CollabAgentToolCall receivers, SubAgentActivity agent_thread_id):
   * evidence that a child thread's work belongs to this turn's exchange. Memory only.
   */
  spawned: Set<string>;
}

/** turn_context settings in file order (main-thread change events). */
export interface CtxObservation {
  turnKey: string;
  ts?: number;
  version: string;
  model?: string;
  effort?: string;
  mode?: string;
  /** thread_settings_applied seen since the previous observation (explicit user settings change). */
  settings: { model?: string; effort?: string; mode?: string }[];
}

/** Own session_meta records in file order (version / instructions / dynamic tools). */
export interface MetaObservation {
  ts?: number;
  version: string;
  instructions?: string;
  tools?: string;
  /** `model_provider` as a salted short hash ("h:xxxxxxxx"); the raw name never leaves the parser. */
  provider?: string;
}

export interface ThreadParse {
  threadId?: string;
  parentThreadId?: string;
  cwd?: string;
  /** `session_meta.source` mapped to the fixed enum (known.ts ENTRYPOINTS), else "other" / "unknown". */
  entrypoint: string;
  /** Driven by another agent (subagent, agent-created, guardian): never human prompts. */
  automated: boolean;
  /**
   * Scripted run (`codex exec`): its prompt is a real prompt, but its settings are the script's, so it emits
   * no change events. Whether it votes is decided downstream from `entrypoint`.
   */
  scripted: boolean;
  /** Whether this session votes (METHOD.md §2), from source / originator / thread_source (session.ts). */
  interactiveClass: InteractiveClass;
  /** File has canonical item_completed events (paginated history). */
  paginated: boolean;
  turns: Turn[];
  observations: CtxObservation[];
  metas: MetaObservation[];
}
