# Claude Code plugins, mods, status line, hooks — and Codex equivalents (2026-10-04)

Sources: code.claude.com/docs/en/plugins/{manifest-reference,marketplace-reference,host-marketplace,components,security}, /plugins/mods/{overview,reference,interface,api,admin}, /statusline, /hooks, /skills, /data-usage, /settings-reference. Types: github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts. Example mod: github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/token-weather (Apache-2.0).

## Transcript retention (correction)
data-usage doc: transcripts kept 30 days by default (`cleanupPeriodDays`), **but sessions started/continued in Claude Desktop or Cowork are exempt by default**. A ~50-day-old desktop transcript still exists on the test machine. → Treat 30-day cleanup as applying to terminal sessions; ingest-to-history still matters.

## Plugin structure (VERIFIED)
- `.claude-plugin/plugin.json` optional, only `name` required: `{ "name":"wasitme","version":"0.1.0","description":"...","author":{"name":"..."},"license":"MIT","repository":"https://github.com/draarivpatel-ui/wasitme" }`. Don't prefix `claude-`.
- Layout at plugin root: `skills/<name>/SKILL.md`, `commands/*.md` (older), `agents/*.md`, `hooks/hooks.json`, `.mcp.json`, `bin/` (put on Bash tool PATH; but a top-level bin/ is rejected by claude.ai org sync), `settings.json`, `scripts/`.
- Repo as its own marketplace: `.claude-plugin/marketplace.json` `{ "name":"wasitme","owner":{"name":"..."},"plugins":[{"name":"wasitme","source":"./","description":"..."}] }` (root source "./" INFERRED OK; run `claude plugin validate`). Can add a second entry with `"source":"./plugin"` subfolder.
- Install: `/plugin marketplace add draarivpatel-ui/wasitme` then `/plugin install wasitme@wasitme` then `/reload-plugins`; or one-step `/plugin install wasitme --marketplace draarivpatel-ui/wasitme` (≥ 2.1.275); CLI `claude plugin marketplace add …`, `claude plugin install …`. Pin `draarivpatel-ui/wasitme#v0.1.0`.
- Updates: auto-update OFF by default for third-party marketplaces. Version = plugin.json version → marketplace entry version → commit SHA. If you set version, users only get updates when you bump it.
- Plugin `settings.json` honors only `agent` and `subagentStatusLine` — **a plugin cannot install a status line**; user must add it (we can offer a consented command/skill that edits settings).
- Slash commands: skills become `/<plugin>:<name>` (e.g. `/wasitme:report`). A bare `/wasitme` only via a mod's `$.command.register`. Skill frontmatter: name, description, argument-hint, arguments, disable-model-invocation, user-invocable, allowed-tools. Shell injection `!`cmd`` runs before Claude sees the skill.

## Mods (VERIFIED; need Claude Code ≥ 2.1.287, on by default)
- A plugin whose JS/TS hooks module runs in-process. `hooks/hooks.json` = `{ "modules": ["./register.mjs"] }`. Module exports `register(on, options)`; hook signature `($, e, next)`.
- Hooks run in terminal CLI, Desktop Code tab, VS Code extension, `claude -p`, cloud. **Drawing only in terminal (incl. editor terminals, JetBrains) and Desktop Code tab.** Desktop WSL: no plugins. Raster/Image terminal-only.
- Drawing: `$.ui.open({id,title})` + `on('ui.render',{component:'Pane'},…)` pane; `{component:'AbovePrompt'}` band; `$.ui.status(text)` (prefixed `⚠ <mod>:` — looks like a warning, avoid); `$.ui.toast(text)`. Unprompted pane (timer/session.start) only seats at ≥144 terminal columns; pane opened from a command/button seats at any width.
- Refresh: no auto timer; `$.ui.invalidate('ui.render')` or `$.clock.every(ms, fn)`. Redraw throttle 10/s (30/s visible pane). Hook exec limit 10s per event.
- Data access (not sandboxed): `$.fs.read/write/list/exists/stat` (4 MiB/file), `$.process.run([...])` (no shell, 30s default, 10 min max), `$.http.fetch` (localhost ok), `$.store` (persists in ~/.claude/plugins/store/), `$.session.usage()`, `$.session.messages()` (newest 4,096). No Node APIs, no setTimeout, no DOM in module.
- Host reads `on(...)` and `$.noun.method(...)` from source → write them literally. `claude plugin validate` prints `hooks:` and `calls:` lines; `claude plugin test` runs `*.test.ts`; `claude --plugin-dir ./dir` hot-reloads.
- Admin: `allowManagedModsOnly` (managed settings) refuses marketplace mods; `disableAllHooks`, `--safe-mode` stop mods.
- Example `token-weather`: `on("session.start")`, `on("turn.complete")` (skip if `e.agentId`), `on("ui.render",{component:"AbovePrompt"})` returning `Box`/`Text` from `$.ui.resolve(e)`; reads `$.session.usage()`, calls `$.ui.invalidate("ui.render")`.
- Install trust: generic warning "Make sure you trust a plugin…"; mod warning says it runs with your permissions, can read files/env/settings, see prompts, approve tool calls. → wasitme mod should use minimal `calls:` (no `$.http.fetch`, no `$.env.get`, no `tool.call`/`prompt.submit` hooks) and document its exact `calls:` line.
  **[Corrected 2026-10-04, WP-03 spike S-INST: on Claude Code 2.1.289 the interactive install shows only the generic "Make sure you trust a plugin…" warning; the mod-specific wording above was not observed in any flow. See docs/spikes/2026-10-04-claude-plugin.md §3.1.]**
- The bundled `plugin-authoring` skill has full types and guidance — load it before writing the mod.

## Status line (VERIFIED)
`settings.json`: `{ "statusLine": { "type":"command", "command":"~/.claude/statusline.sh", "padding":0, "refreshInterval":5 } }` (seconds, min 1). Updates on each assistant message, /compact, mode changes, rate-limit/cache expiry; debounced 300ms; running script cancelled on new update. Each stdout line = one row; ANSI + OSC 8 links OK; COLUMNS/LINES env.
Stdin JSON: session_id, session_name, prompt_id, transcript_path, cwd, version, model.{id,display_name}, workspace.{current_dir,project_dir,added_dirs,git_worktree,repo}, output_style.name, cost.{total_cost_usd,total_duration_ms,total_api_duration_ms,total_lines_added,total_lines_removed}, context_window.{…, used_percentage, current_usage{…}}, exceeds_200k_tokens, fast_mode, effort.level, thinking.enabled, prompt_cache.{warm,hit_ratio,misses,last_miss_cause,…}, rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}, vim.mode, agent.name, pr.{…}, worktree.{…}.
Status line must be FAST (it runs often) → read a cached snapshot, never re-scan logs.

## Hooks (VERIFIED)
- SessionEnd: stdin `{session_id, transcript_path, cwd, hook_event_name, reason}`; can't block; all SessionEnd hooks share a 1.5s budget, raised up to 60s if a hook sets `timeout`. Stop fires every turn (600s default). `"async": true` = non-blocking, no timeout enforced.
- Recommended: SessionStart (async) + SessionEnd ingest; ingest must be idempotent, fast, tolerate half-written transcripts. Cold `npx` can blow the 1.5s budget → call an installed binary or set timeout.
  **[Corrected 2026-10-04, WP-03 spike S-HK: a `timeout` on a plugin's SessionEnd hook is ignored for that budget (cut at ~1.5 s with `timeout: 10`); only a `timeout` on a settings.json hook or `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` raises it. See docs/spikes/2026-10-04-claude-plugin.md §5.3.]** Use `"${CLAUDE_PLUGIN_ROOT}"`. `CLAUDE_PLUGIN_DATA` survives updates. Plugin install doesn't prompt per hook.

## Codex
- Hooks: SessionEnd, Stop etc.; stdin has session_id, transcript_path, cwd, hook_event_name, model, permission_mode; SessionEnd timeout 1s default / 3s max; `~/.codex/hooks.json`, repo `.codex/hooks.json`, or plugin `hooks/hooks.json`; **each new/modified hook must be reviewed via `/hooks`** (plugin hooks skipped until reviewed); env `PLUGIN_ROOT`, `PLUGIN_DATA`.
- Status line: `tui.status_line` is a list of built-in item ids — **no external command** → no Codex status line.
- `notify`: runs on agent-turn-complete; a user may already have `notify` set → never overwrite.
- Plugins/marketplaces: root `plugin.json` (Agent Plugins schema) or `.codex-plugin/plugin.json`; repo marketplace `.agents/plugins/marketplace.json`; `codex plugin marketplace add owner/repo`. Local evidence suggests Codex 0.160 also reads `.claude-plugin` marketplaces (INFERRED). Verify with a real install before promising.
