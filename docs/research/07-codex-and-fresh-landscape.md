# Codex specifics + fresh landscape (2026-10-04)

Sources: three GPT-6 Luna research runs via `codex exec --search --ephemeral` (public web only), plus Claude's own live test. Luna claims are cited to URLs in the raw notes; items marked VERIFIED-LOCAL were tested on this Mac by Claude.

## One repo = marketplace for Claude Code AND Codex — VERIFIED-LOCAL
Throwaway `CODEX_HOME`, Codex CLI 0.160.0: a folder containing only `.claude-plugin/marketplace.json` (`{"name":"wasitme-test","owner":{…},"plugins":[{"name":"wasitme-test","source":"./"}]}`) + `.claude-plugin/plugin.json` + `skills/report/SKILL.md` + `hooks/hooks.json` was accepted by `codex plugin marketplace add <dir>`; `codex plugin add wasitme-test@wasitme-test` installed it into `plugins/cache/<mkt>/<plugin>/<version>/` with skills and hooks copied, and wrote `[plugins."x@y"] enabled = true` to config.toml. The hook did NOT run on install. (Luna had marked CLI support for `.claude-plugin` UNVERIFIED; docs say the desktop app reads it as a "legacy-compatible marketplace location"; OpenAI's native format is `.agents/plugins/marketplace.json` + root `plugin.json` with `$schema: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`.) → Ship `.claude-plugin/` for both; optionally add `.agents/plugins/marketplace.json` later.

## Codex hooks (Luna, cited learn.chatgpt.com/docs/hooks)
- Events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop, Interrupt, PreCompact, PostCompact, SubagentStart, SubagentStop.
- Timeouts: most 600s default; **SessionEnd and Interrupt default 1s, max 3s**; `"async": true` supported except SessionEnd (always sync).
- stdin: session_id, transcript_path (nullable), cwd, hook_event_name, model; SessionStart adds permission_mode + source (startup/resume/clear/compact); SessionEnd adds reason; Stop adds turn_id, stop_hook_active, last_assistant_message.
- **Trust: installing a plugin does NOT authorize its hooks. User must review/trust each hook in `/hooks`; trust is pinned to the hook's hash — any change requires re-trust.** → Keep the Codex hook command stable across versions (e.g. `wasitme ingest --quiet --agent codex`), and design so wasitme works fully without hooks (scan on demand / on app refresh).
- Open issue: hooks declared in portable root plugin.json may not load (openai/codex#47925) → use `hooks/hooks.json`.
- `notify`: user-level argv; only `agent-turn-complete`; payload type, thread-id, turn-id, cwd, client, input-messages, last-assistant-message. A user may already use notify → never touch.
- `tui.status_line`: built-in item IDs only; no external command (feature request openai/codex#20244). → No Codex status line at launch.

## Codex rollout format (Luna, cited openai/codex source/PRs)
- **Two history modes**: legacy rollouts store tool events as `event_msg` (`exec_command_end`, `patch_apply_end`, `mcp_tool_call_end`); **paginated** rollouts store canonical `item_completed` TurnItems. Which appears depends on `history_mode` (codex-rs/rollout/src/policy.rs). Parser must support both. Migration can produce both a canonical user item and a legacy user event for the same message → dedupe.
- Top-level records: session_meta, response_item, event_msg, turn_context, token_usage_record (per-response), compacted, world_state. `token_count` (event_msg) = cumulative.
- Lifecycle: `task_started`/`task_complete` (decoder also accepts `turn_started`/`turn_complete`), `turn_aborted`. A rollout can end mid-turn.
- Forks/subagents: `forked_from_id` (fork lineage) ≠ `parent_thread_id` (spawn parent). Paginated forks reference parent prefix via `history_base` (child file may hold only child records); legacy forks copy inherited history (double-count risk).
- `instructions` moved session_meta → turn_context; old metadata may use `id` instead of `session_id`.
- Latest tag 0.162.0-alpha.13 (2026-10-04).

## Fresh landscape, Sep 20 – Oct 4 (Luna)
- MarginLab, LiveNerf (1.2k★; r/ClaudeAI thread "Is Opus 5.5 entering a nerfed phase" ~2,707 votes Sep 29 — demand signal, not verified by Claude), BridgeBench Nerf Bench (Sep 27): all **synthetic benchmarks**, none analyze the user's own logs.
- Agents Monitor (0★, Sep 23): local Claude/Codex usage logs, no quality/regression. awesome-skills/insights: portable /insights friction report, no version/config correlation.
- nerf-watch: Luna couldn't find it via search, but Claude verified via GitHub API it exists (created 2026-10-03, 0★).
- No Anthropic/OpenAI built-in longitudinal quality tracking announced in window. OpenAI Admin Console analytics (Sep 16) = adoption/outcomes, not regression detection.
- **Gap still open:** "your own logs → did your setup or the agent change?" with honest stats + polished multi-surface UX.
