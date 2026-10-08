/**
 * Closed vocabularies for config values that are NOT free text. A value outside its list is not an
 * error: it is exported only as a salted hash (see labelOf), so a user-chosen word — a client name
 * used as a hook event, a provider table or a mode — can never ride along as readable text.
 *
 * Provenance: the Claude Code and Codex lists below were read out of the installed binaries
 * (Claude Code 2.1.289 hook-event and permission-mode enums; Codex approval/sandbox variants).
 * A newer release that adds a value shows up as a hash until the list is updated: counts and
 * change detection keep working, only the readable label is missing.
 */

/** Claude Code hook events (`settings.hooks.<event>`). */
export const KNOWN_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification", "UserPromptSubmit",
  "UserPromptExpansion", "SessionStart", "SessionEnd", "Stop", "StopFailure", "SubagentStart", "SubagentStop",
  "PreCompact", "PostCompact", "PreModelSwitch", "PostModelSwitch", "PermissionRequest", "PermissionDenied",
  "Setup", "TeammateIdle", "TaskCreated", "TaskCompleted", "Elicitation", "ElicitationResult", "ConfigChange",
  "WorktreeCreate", "WorktreeRemove", "InstructionsLoaded", "CwdChanged", "FileChanged", "DirectoryAdded",
  "MessageDisplay",
]);

/** Claude Code `permissions.defaultMode`. */
export const PERMISSION_MODES: ReadonlySet<string> = new Set([
  "default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto",
]);

/** Codex `approval_policy` (`granular` is normally a table, which is hashed; the bare word is a valid variant name). */
export const APPROVAL_POLICIES: ReadonlySet<string> = new Set(["untrusted", "on-failure", "on-request", "granular", "never"]);

/** Codex `sandbox_mode`. */
export const SANDBOX_MODES: ReadonlySet<string> = new Set(["read-only", "workspace-write", "danger-full-access"]);

/**
 * Codex `model_provider` ids that are not user-invented. Any other value names a user-defined
 * `[model_providers.<id>]` table and is hashed. (openai, ollama, lmstudio and amazon-bedrock are
 * present in the Codex binary; azure and oss are included on the review's list, not separately verified.)
 */
export const BUILTIN_PROVIDERS: ReadonlySet<string> = new Set(["openai", "azure", "ollama", "lmstudio", "oss", "amazon-bedrock"]);
