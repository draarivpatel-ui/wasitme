/**
 * Record vocabularies the Codex reader recognises. Anything else is counted in
 * `ParseStats.unknownTypes` so silent format drift becomes visible.
 */

/** Top-level envelope `type` values of a rollout line (`{timestamp, ordinal, type, payload}`). */
export const ENVELOPES = new Set([
  "session_meta", "turn_context", "event_msg", "response_item", "token_usage_record", "compacted",
  "world_state", "inter_agent_communication_metadata",
]);

/** `event_msg.payload.type` values, current (paginated) and legacy. */
export const EVENT_TYPES = new Set([
  // lifecycle (+ aliases accepted by Codex's own decoder)
  "task_started", "turn_started", "task_complete", "turn_complete", "turn_aborted",
  // paginated canonical items
  "item_started", "item_updated", "item_completed",
  // usage / settings
  "token_count", "thread_settings_applied", "session_configured",
  // legacy tool lifecycle
  "exec_command_begin", "exec_command_end", "exec_command_output_delta", "exec_approval_request",
  "patch_apply_begin", "patch_apply_end", "apply_patch_approval_request",
  "mcp_tool_call_begin", "mcp_tool_call_end", "mcp_list_tools_response", "mcp_startup_update", "mcp_startup_complete",
  "web_search_begin", "web_search_end", "view_image_tool_call", "user_shell_command",
  // legacy conversation stream
  "user_message", "agent_message", "agent_message_delta", "agent_reasoning", "agent_reasoning_delta",
  "agent_reasoning_raw_content", "agent_reasoning_raw_content_delta", "agent_reasoning_section_break",
  // errors / misc
  "error", "stream_error", "warning", "background_event", "deprecation_notice", "turn_diff", "plan_update",
  "get_history_entry_response", "list_custom_prompts_response", "list_skills_response", "entered_review_mode",
  "exited_review_mode", "conversation_path", "shutdown_complete", "context_compacted", "undo_started",
  "undo_completed",
]);

/** Paginated `item_completed.item.type` values. */
export const ITEM_TYPES = new Set([
  "UserMessage", "AgentMessage", "Reasoning", "CommandExecution", "FileChange", "McpToolCall",
  "CollabAgentToolCall", "WebSearch", "Extension", "ImageView", "SubAgentActivity", "ContextCompaction",
  "FunctionCallOutput", "DynamicToolCall", "Plan", "TodoList",
]);

/**
 * Items that are tool calls made by the agent. `ImageView` is excluded: on real logs only 3 of 1,020
 * ImageView items had a matching `view_image` call — they are mostly images attached by other tools.
 */
export const TOOL_ITEMS = new Set(["CommandExecution", "FileChange", "McpToolCall", "CollabAgentToolCall", "WebSearch", "Extension", "DynamicToolCall"]);

/** `response_item.payload.type` values. */
export const RESPONSE_TYPES = new Set([
  "message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output",
  "local_shell_call", "web_search_call", "tool_search_call", "tool_search_output", "agent_message",
  "image_generation_call", "ghost_snapshot", "compaction", "other",
]);

/** Response-item calls counted as tool calls in legacy files that have no `*_end` events. */
export const RESPONSE_CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call", "web_search_call"]);
export const RESPONSE_OUTPUTS = new Set(["function_call_output", "custom_tool_call_output"]);

/** `parsed_cmd[].type` values that only look at files. */
export const READ_CMDS = new Set(["read", "search", "list_files"]);

/** Statuses that mean the user declined the call (not a tool failure). None observed yet; kept for forward compat. */
export const DECLINED = new Set(["declined", "rejected", "denied", "user_rejected"]);

/** Injected-message tags that start an automation-triggered (agent-initiated) stretch of work. */
export const AUTOMATION_TAGS = new Set(["heartbeat", "scheduled-task", "scheduled_task", "automation"]);

/**
 * The injected app tags (`<task-notification>`, `<command-name>`/`<command-message>`,
 * `<local-command-stdout>`, `<heartbeat>`, `<scheduled-task>`, plus their sibling tags). The app writes these as
 * whole messages, so a message that starts with one is injected context in full: no closing tag is needed, and
 * text after the block (e.g. a notification's trailing instructions) never turns it into a typed prompt.
 */
export const APP_TAGS = new Set([
  "task-notification", "command-name", "command-message", "command-args", "local-command-stdout", "local-command-caveat",
  ...AUTOMATION_TAGS,
]);

/**
 * Wrapper tags Codex and its clients put around (or instead of) what a person typed. Only these are stripped
 * from the start of a user message; any other leading markup (a pasted <svg>, a <template> block,
 * "<b>why is this bold</b>") is typed text.
 * Sources: the reader spec and the spike's NON_HUMAN_TAGS; image / in-app-browser-context /
 * recommended_plugins wrappers seen on real logs while building this reader; user_shell_command (a `!cmd`
 * the user ran, not a prompt) and skill (injected skill body) from Codex's own injected-message markers.
 */
export const INJECTED_TAGS = new Set([
  "environment_context", "INSTRUCTIONS", "user_instructions", "turn_aborted", "subagent_notification",
  "task-notification", "command-name", "command-message", "command-args", "local-command-stdout",
  "local-command-caveat", "codex_internal_context", "image", "in-app-browser-context", "recommended_plugins",
  "user_shell_command", "skill",
  ...AUTOMATION_TAGS,
]);

/** `session_meta.thread_source` values that mean software, not a person, drives the thread. */
export const AUTOMATED_THREAD_SOURCES = new Set(["subagent", "agent_created_thread", "guardian_review"]);

/**
 * `Exchange.entrypoint` for Codex: the fixed enum of `session_meta.source` values (Codex's SessionSource,
 * serialized lowercase; the object form `{subagent: …}` is a spawned thread). Anything else is "other",
 * a missing source is "unknown". `originator` is an open, client-supplied string and never becomes a label.
 */
export const ENTRYPOINTS = new Set(["cli", "vscode", "exec", "mcp", "subagent", "unknown"]);

/**
 * Classifier inputs (METHOD.md §2), read in memory only. `originator` is an open, client-supplied string: only these
 * exact values carry a signal; anything else (including codex-rs's generic default `codex_cli_rs`, which every
 * entry point used before per-surface originators existed) is neutral and leaves the decision to `source`.
 */
export const INTERACTIVE_ORIGINATORS = new Set(["codex-tui", "codex_tui", "Codex Desktop", "codex_vscode"]);
export const SCRIPTED_ORIGINATORS = new Set(["codex_exec", "codex_sdk_ts"]);
/** `session_meta.source` values whose sessions a person drives / software drives. */
export const INTERACTIVE_SOURCES = new Set(["cli", "vscode"]);
export const SCRIPTED_SOURCES = new Set(["exec", "mcp"]);

/**
 * Turn ids of imported history: a fixed prefix plus a counter (Codex Desktop writes `external-import-turn-N`),
 * where real turns carry uuids. Such a turn is excluded whatever it contains — the original work lives elsewhere.
 * The shape rule in rollout.ts (a user message with no turn_context, no model call, no tool work) still catches
 * imports written under uuid ids.
 */
export const IMPORTED_TURN_ID = /^(?=[A-Za-z])[\w.-]{0,64}?import[\w.-]{0,64}?[-_.]\d{1,9}$/i;

/**
 * Legacy response_item function names that run a shell command (their failures are command exits, `toolErrorsCmd`).
 * Every other function call (apply_patch, MCP `server__tool`, plan updates, …) is a non-command call.
 */
export const COMMAND_FUNCTIONS = new Set(["shell", "container.exec", "exec_command", "write_stdin", "local_shell", "unified_exec"]);
