/**
 * The closed text bank. EVERY piece of prose the scenario generators emit (prompts, assistant text,
 * thinking text, tool output, command text) is assembled from this file — nothing is read from the
 * machine it runs on. A test tokenises all generated prose and checks it against `vocabularyWords()`,
 * which is how "100% synthetic" is proven rather than assumed.
 *
 * Constraints baked into the templates (and re-verified by tests against src/pushback.ts and
 * src/similarity.ts): ordinary prompts never start with a pushback phrase and are never
 * near-duplicates of the previous prompt; pushback templates always match isPushback().
 */
import type { Rng } from "./rng.js";

export const NOUNS = [
  "parser", "cache", "scheduler", "router", "queue", "tokenizer", "exporter", "importer", "validator",
  "formatter", "renderer", "adapter", "gateway", "registry", "resolver", "serializer", "encoder", "decoder",
  "watcher", "loader", "planner", "reducer", "selector", "manifest", "ledger", "timer", "buffer", "channel",
  "handler", "dispatcher", "tracker", "mapper", "builder", "collector", "limiter", "indexer", "emitter",
  "pipeline", "template", "snapshot",
] as const;

export const MODULES = [
  "billing", "search", "uploads", "reports", "inventory", "catalog", "notifications", "analytics", "checkout",
  "profiles", "scheduling", "messaging", "payments", "shipping", "metrics", "settings", "exports", "imports",
  "audit", "sessions", "onboarding", "invoices", "ratings", "coupons",
] as const;

export const ADJECTIVES = [
  "slow", "flaky", "legacy", "redundant", "optional", "nested", "stale", "verbose", "strict", "lazy",
  "partial", "duplicate", "empty", "invalid", "oversized", "noisy",
] as const;

export const EXTENSIONS = ["ts", "js", "py", "md", "json", "css"] as const;

/** Ordinary prompts. Each is long enough (>= 40 chars) for the near-duplicate guard to be meaningful. */
export const PROMPTS = [
  "Add a {adj} {noun} to the {module} module and cover it with tests",
  "Write unit tests for the {noun} in {module} so that the {adj} cases are covered",
  "Refactor the {module} {noun} to use a {noun2} instead of the {adj} {noun3}",
  "Can you explain how the {noun} in {module} decides when to retry",
  "Please rename the {noun} helper in {module} to {noun2} and update every caller",
  "Investigate why the {module} {noun} takes {n} seconds on a {adj} input",
  "Implement a {noun} for {module} that handles {adj} input without crashing",
  "Update the {module} docs so the {noun} section matches the current behavior",
  "Let's split the {module} {noun} into two smaller {noun2} modules",
  "What would it take to remove the {adj} {noun} from {module}",
  "Fix the {adj} {noun} in {module} so it returns {n} items instead of {n2}",
  "Review the {module} {noun} for race conditions and list anything suspicious",
  "Create a small {noun} script for {module} that prints a summary of {noun2} usage",
  "Make the {noun} in {module} configurable through a {noun2} option with a sane default",
  "Move the {adj} {noun} logic out of {module} and into a shared {noun2} helper",
  "Run the {module} tests and tell me which {noun} cases are failing",
  "Look at the {module} {noun} and propose a plan before changing anything",
  "Add logging around the {noun} in {module} so we can see why the {noun2} stalls",
  "Wire the new {noun} into the {module} flow and keep the public interface unchanged",
  "Check whether the {module} {noun} still works when the {noun2} is {adj}",
  "Document the {adj} {noun} behavior in {module} with a short worked example",
  "Compare the {module} {noun} with the {noun2} and recommend which one to keep",
  "Trace a request through the {module} {noun} and summarize each hop",
  "Tighten the types on the {noun} in {module} without changing runtime behavior",
] as const;

export const PROMPT_TAILS = [
  "Keep the diff small.",
  "Show me the plan first.",
  "Do not touch the {noun2} code.",
  "Follow the existing {noun3} conventions.",
  "Explain the tradeoffs briefly.",
  "Run the checks when you are done.",
] as const;

/** Pushback openers. Every template must satisfy isPushback() (see tests). */
export const PUSHBACKS = [
  "No, that is not what I asked for. {cont}",
  "No - the {noun} in {module} is still {adj}. {cont}",
  "Wrong, the {noun} in {module} should not be {adj}. {cont}",
  "That's still broken in {module}. {cont}",
  "That is not right, the {noun} is {adj}. {cont}",
  "It's still not working for the {module} {noun}. {cont}",
  "It doesn't work when the {noun} is {adj}. {cont}",
  "Still not fixed - the {module} {noun} fails the same way. {cont}",
  "Not what I wanted, the {noun} should be {adj}. {cont}",
  "You forgot to update the {noun} in {module}. {cont}",
  "You broke the {module} {noun}. {cont}",
  "Why did you change the {noun} in {module}? {cont}",
  "I said keep the {noun} interface unchanged. {cont}",
  "I meant the {adj} {noun} in {module}, not the {noun2}. {cont}",
  "Stop. {cont}",
  "Revert that change to the {noun} and try a smaller fix. {cont}",
  "Undo the {noun} edit in {module}. {cont}",
  "Ugh, the {noun} is {adj} again. {cont}",
  "Try again, and keep the {noun} {adj}. {cont}",
  "Actually, the {module} {noun} should be {adj}. {cont}",
  "Wait, the {noun} in {module} is still {adj}. {cont}",
] as const;

export const PUSHBACK_CONTINUATIONS = [
  "Please fix it and rerun the tests.",
  "Show me the failing {noun} first.",
  "Be more careful with the {noun2} this time.",
  "Only touch the {module} files.",
  "Explain what went wrong before you change anything.",
] as const;

/** Appended to the previous prompt to make a near-duplicate re-send. */
export const DUPLICATE_SUFFIXES = [" again please", ", one more time", " - same request as before", " (retrying)"] as const;

/** Prompts typed while the agent is working. Never pushback, never near-duplicates. */
export const QUEUED = [
  "also keep the {noun} backwards compatible",
  "and add a test for the {adj} {noun} case",
  "plus mention the {noun2} change in the {module} notes",
  "oh and please leave the {adj} {noun} alone for now",
  "one more thing, log the {noun} timing in {module}",
] as const;

export const AGENT_PLANS = [
  "I will start by reading the {module} {noun}.",
  "Let me look at how the {noun} is wired into {module}.",
  "First I want to check the {adj} {noun} handling.",
  "I will search for every use of the {noun} before changing it.",
] as const;

export const AGENT_SUMMARIES = [
  "I updated the {noun} in the {module} module and added a test for the {adj} case.",
  "The {noun} now handles {adj} input and the {module} tests pass.",
  "I moved the {adj} {noun} logic into a shared {noun2} helper and updated the callers.",
  "Here is what I found: the {noun} in {module} retries {n} times before it gives up.",
  "Done. The {module} {noun} is configurable and the default is unchanged.",
] as const;

export const AGENT_MIDWAY = [
  "That looks right so far, checking the {noun2} next.",
  "The {noun} depends on the {noun2}, so I will adjust both.",
  "One test still fails for the {adj} {noun}, looking into it.",
] as const;

export const THINKING = [
  "The {noun} depends on the {noun2}, so the {module} change should stay small.",
  "I should read the {adj} {noun} before editing anything in {module}.",
  "A smaller fix in the {noun} avoids touching the {noun2} tests.",
  "Check the {module} {noun} first and then decide how to proceed.",
] as const;

export const SUBAGENT_PROMPTS = [
  "Explore the {module} {noun} code and report where the {noun2} is used",
  "Search the {module} module for every {adj} {noun} and list the files",
  "Summarize how the {noun} in {module} handles {adj} input",
] as const;

export const SUBAGENT_RESULTS = [
  "Found {n} uses of the {noun} in the {module} module.",
  "The {noun} is only used by the {noun2} in {module}.",
] as const;

export const BASH_COMMANDS = [
  "npm test -- {module}",
  "npm run lint",
  "git status --short",
  "node scripts/{noun}.js --{adj}",
  "ls src/{module}",
  "git diff --stat",
] as const;

export const BASH_DESCRIPTIONS = [
  "Run the {module} tests",
  "Check the working tree",
  "List the {module} files",
  "Run the {noun} script",
] as const;

export const READ_OUTPUT = "{n}\tsynthetic line for the {noun} in {module}";
export const GREP_OUTPUT = "src/{module}/{noun}.{ext}:{n}: synthetic match for {noun2}";
export const BASH_OUTPUT_OK = "ok: {n} checks passed for {module}";
export const EDIT_OUTPUT_OK = "The file {path} has been updated.";
export const WRITE_OUTPUT_OK = "File created successfully at {path}";
export const GENERIC_OUTPUT_OK = "ok: {n} results for the {module} {noun}";

export const ERROR_OUTPUTS = {
  Read: "File does not exist.",
  Grep: "Error: the pattern is not valid.",
  Glob: "Error: no files matched the pattern.",
  LS: "Error: the directory is not readable.",
  Edit: "Error: the string to replace was not found in the file.",
  Write: "Error: the file has not been read yet.",
  MultiEdit: "Error: an edit in the batch did not apply.",
  NotebookEdit: "Error: the cell could not be updated.",
  Bash: "Exit code 1\nError: the {noun} check failed in {module}",
  Task: "Error: the subagent did not finish.",
  default: "Error: the {noun} is unavailable.",
} as const;

export const REJECTION_OUTPUT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
export const REJECTION_RESULT = "User rejected tool use";

export const BLOCKED_OUTPUT = {
  "automode-blocked": "Permission to use {tool} was denied by the auto mode classifier. Try a safer approach.",
  "permission-rule": "Permission to use {tool} has been denied by a permission rule.",
  "automode-unavailable": "Auto mode is currently unavailable, so {tool} needs approval.",
} as const;

export const INTERRUPT_TEXT = "[Request interrupted by user]";
export const INTERRUPT_TOOL_TEXT = "[Request interrupted by user for tool use]";
export const META_CONTINUE_TEXT = "[Your previous response had no content. Please continue.]";

export const COMPACT_CONTENT = "Conversation compacted";
export const COMPACT_SUMMARY =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier part of the conversation. The user was working on the {module} {noun}.";

export const LOCAL_COMMAND_CAVEAT =
  "Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them unless the user explicitly asks you to.";

export const API_ERROR_TEXT = "API Error: the service is overloaded, please try again.";
export const API_ERROR_RETRY = "the service is overloaded";

export const TASK_NOTIFICATION =
  "<task-notification><task-id>{id}</task-id><status>completed</status><summary>Background command completed</summary></task-notification>";

export const AI_TITLES = [
  "Fix the {noun} in {module}", "Refactor the {module} {noun}", "Tests for the {module} {noun}",
  "Explain the {noun} flow", "Plan the {module} cleanup",
] as const;

export const SYSTEM_PROMPT_TEXT = "Synthetic system prompt revision {rev}. This text is generated and carries no real instructions.";
export const INSTRUCTIONS_TEXT = "Synthetic project instructions revision {rev}. This text is generated and carries no real instructions.";
export const CODEX_ENV_CONTEXT =
  "<environment_context>\n  <cwd>{cwd}</cwd>\n  <approval_policy>{approval}</approval_policy>\n  <shell>zsh</shell>\n</environment_context>";
export const CODEX_AGENTS_MD = "# AGENTS.md instructions for {cwd}\n\n<INSTRUCTIONS>\n{instructions}\n</INSTRUCTIONS>";
export const CODEX_TURN_ABORTED =
  "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running commands were stopped. The interrupted prompt was: {prompt}\n</turn_aborted>";
export const CODEX_SUBAGENT_NOTIFICATION =
  "<subagent_notification>{\"agent\":\"{nick}\",\"status\":\"completed\"}</subagent_notification>";

export const EDIT_OLD = "synthetic old line";
export const EDIT_NEW = "synthetic new line";
export const WRITE_CONTENT = "synthetic file content";
export const WEBFETCH_PROMPT = "Summarize the {noun} section";
export const TODO_CONTENT = "Check the {module} {noun}";
export const TODO_ACTIVE = "Checking the {module} {noun}";
export const SUBAGENT_DESCRIPTIONS = ["Explore {module}", "Search {module} {noun}", "Summarize {noun}"] as const;
export const COMMAND_TEXT = "<command-name>/{cmd}</command-name>\n<command-message>{cmd}</command-message>\n<command-args>{arg}</command-args>";
export const COMMAND_STDOUT = "<local-command-stdout>Set {cmd} to {arg}</local-command-stdout>";
export const PEER_MESSAGE = "A peer session finished the {module} {noun} task.";
export const CODEX_EXEC_OUTPUT = "Exit code: {code}\nWall time: {secs} seconds\nOutput:\n{out}";
export const CODEX_PATCH = "*** Begin Patch\n*** Update File: {path}\n@@\n-synthetic old line\n+synthetic new line\n*** End Patch";
export const CODEX_PATCH_OK = "Success. Updated the following files:\nM {path}";
export const CODEX_PATCH_FAIL = "apply_patch verification failed: the context did not match";
export const CODEX_READ_CMD = "cat {path}";
export const CODEX_SEARCH_CMD = "rg {noun} src";
export const CODEX_LIST_CMD = "ls src/{module}";
export const CODEX_STUB_AGENT = "I will pick this up from the earlier thread.";
/** Env labels (models, efforts, modes) that scenarios put into logs and command text. */
export const LABEL_WORDS = [
  "claude opus sonnet fable gpt luna sol terra high medium low none xhigh max default auto plan acceptedits",
  "bypasspermissions on request never untrusted model effort mode set",
  "codex desktop tui read grep glob ls edit write multiedit notebookedit bash webfetch todowrite task collab mcp",
] as const;
export const STOP_HOOK_COMMAND = "synthetic-stop-hook";

/** Fill {noun}, {noun2}, {noun3}, {module}, {adj}, {ext}, {n}, {n2} from the bank. Unknown slots stay as-is. */
export function fill(template: string, rng: Rng, extra: Record<string, string> = {}): string {
  const noun = rng.pick(NOUNS);
  let noun2 = rng.pick(NOUNS);
  let noun3 = rng.pick(NOUNS);
  if (noun2 === noun) noun2 = NOUNS[(NOUNS.indexOf(noun2) + 1) % NOUNS.length]!;
  if (noun3 === noun || noun3 === noun2) noun3 = NOUNS[(NOUNS.indexOf(noun3) + 2) % NOUNS.length]!;
  const slots: Record<string, string> = {
    noun, noun2, noun3,
    module: rng.pick(MODULES),
    adj: rng.pick(ADJECTIVES),
    ext: rng.pick(EXTENSIONS),
    n: String(rng.int(2, 97)),
    n2: String(rng.int(2, 97)),
    ...extra,
  };
  return template.replace(/\{(\w+)\}/g, (m, k: string) => slots[k] ?? m);
}

/** Every alphabetic token (lower-cased) appearing anywhere in the bank. */
export function vocabularyWords(): Set<string> {
  const out = new Set<string>();
  const add = (s: string): void => { for (const t of s.toLowerCase().match(/[a-z]+/g) ?? []) out.add(t); };
  const visit = (v: unknown): void => {
    if (typeof v === "string") add(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit([
    NOUNS, MODULES, ADJECTIVES, EXTENSIONS, PROMPTS, PROMPT_TAILS, PUSHBACKS, PUSHBACK_CONTINUATIONS,
    DUPLICATE_SUFFIXES, QUEUED, AGENT_PLANS, AGENT_SUMMARIES, AGENT_MIDWAY, THINKING, SUBAGENT_PROMPTS,
    SUBAGENT_RESULTS, BASH_COMMANDS, BASH_DESCRIPTIONS, READ_OUTPUT, GREP_OUTPUT, BASH_OUTPUT_OK,
    EDIT_OUTPUT_OK, WRITE_OUTPUT_OK, GENERIC_OUTPUT_OK, ERROR_OUTPUTS, REJECTION_OUTPUT, REJECTION_RESULT,
    BLOCKED_OUTPUT, INTERRUPT_TEXT, INTERRUPT_TOOL_TEXT, META_CONTINUE_TEXT, COMPACT_CONTENT, COMPACT_SUMMARY,
    LOCAL_COMMAND_CAVEAT, API_ERROR_TEXT, API_ERROR_RETRY, TASK_NOTIFICATION, AI_TITLES, SYSTEM_PROMPT_TEXT,
    INSTRUCTIONS_TEXT, CODEX_ENV_CONTEXT, CODEX_AGENTS_MD, CODEX_TURN_ABORTED, CODEX_SUBAGENT_NOTIFICATION,
    STOP_HOOK_COMMAND, EDIT_OLD, EDIT_NEW, WRITE_CONTENT, WEBFETCH_PROMPT, TODO_CONTENT, TODO_ACTIVE,
    SUBAGENT_DESCRIPTIONS, COMMAND_TEXT, COMMAND_STDOUT, PEER_MESSAGE, CODEX_EXEC_OUTPUT, CODEX_PATCH,
    CODEX_PATCH_OK, CODEX_PATCH_FAIL, CODEX_STUB_AGENT, LABEL_WORDS, CODEX_READ_CMD, CODEX_SEARCH_CMD, CODEX_LIST_CMD,
  ]);
  return out;
}
