# Prior art: parsers, metrics, statistics, reuse (2026-10-04)

Notes marked "seen" were checked read-only, as counts, against one real setup's local logs at audit time.

## Projects
| Project | License | Notes |
|---|---|---|
| anthropics/claude-code#42796 (a user's before-and-after analysis) | n/a | Before/after tables, no CIs. Anthropic replied: thinking redaction is UI-only; local logs hide thinking; adaptive-thinking default (Feb 9) and effort default (Mar 3); summing log lines inflates request counts. Postmortem causes: effort default drop (Mar 4–Apr 7), reasoning-cache bug (Mar 26–Apr 10), verbosity prompt (Apr 16–20). |
| nerf-watch (Abelo9996) | MIT, TS, 0★, created 2026-10-03 | Closest competitor. Claude+Codex: tokens, cache-hit, tool-error, effort, context window, model mismatch (requested vs served), fallbacks. Per-session medians; min 5 sessions & 50 turns/side, 100 tool calls for error rates, 20 turns/project; change must appear in ≥2 projects and ≥2/3 of projects with data both sides; version-boundary scan + 7d-vs-28d same-version drift. Gaps: no interrupts/pushback/read:edit/steps; counts rejections as errors; reads Codex `exec_command_end`/`patch_apply_end`/`mcp_tool_call_end` which current logs don't have (current = `item_completed`). |
| codeburn | MIT, TS, ~11k★ | Cost tracker. One-shot rate, retries (edit → non-read Bash → re-edit same file in a turn, `src/classifier.ts countRetries`), cost per edit turn. Descriptive cohort compare showing N + drill-through. Bugs: subagent transcripts inflated session counts (#974); Codex `token_usage_record` streaming snapshots → 3.7x cache overcount (#1380). |
| agentsview | MIT, Go, ~6k★ | Most thorough parser (SQLite). Signals: retries = ≥3 identical consecutive calls; edit churn = ≥3 edits to one file within 10 steps; frustration markers; runaway loops. Bugs: backgrounded sessions double-ingested (#1370); subagent messages labelled User (#1223). |
| ccusage | MIT, TS/Rust | Dedupe mistakes catalog: #888 kept first streaming line (undercount); #1635 gateway logs share message id w/o requestId; #1762 cross-session duplicates on resume; #913 /btw sidechain replay; Codex forks double-counted (#1175, #1349, #1370); Codex re-emitted token_count (#1288). |
| claude-code-log | MIT, Python | Best format docs: dev-docs/messages.md, dev-docs/dag.md. |
| inspecto | MIT, TS, 0★ | Reads-per-edit, rewrite ratio, retry density (prompt similarity >0.6), `calibrate` (Spearman vs git outcomes). Bug: treats human prompt as `typeof content === "string"` → misses most real prompts (in local logs, list-form user records far outnumber string-form ones). |
| nerfwatch (lukejacobsen7) | MIT, Python | Active probes; bootstrap CI; two-sided CUSUM (k=0.5σ, h=4σ). Not for organic data. |
| claude-session-analyzer | **no license** | Do not copy. Its `isinstance(content,str)` interrupt check misses all list-form interrupts. |
| sniffly | MIT, Python, stale | Interrupt texts: `[Request interrupted by user for tool use]`, `API Error: Request was aborted.` |

## Metric definitions from issue #42796
Read:Edit = Read/Edit. Research:Mutation = (Read+Grep+Glob)/(Edit+Write). Write% = Write/(Edit+Write). Edits without prior Read of same file (window ~10 calls). Reasoning loops ("oh wait", "actually,", "let me reconsider"…) per 1k tool calls. Interrupts per 1k tool calls. Thinking depth via `signature` length (r=0.971 vs thinking length). Stop-hook violations. Frustration = share of prompts matching phrases (5.8% → 9.8%).

## Parser edge cases (must handle)
1. Streaming split: one response across several lines repeating usage → merge by message.id + requestId, keep MAX output_tokens; don't keep first line; don't rely on stop_reason (often null).
2. Cross-file duplicates: resumed sessions replay messages with same uuid, different sessionId → dedupe by uuid, keep earliest.
3. Missing requestId (gateway/relay) → key session+timestamp.
4. Compaction replay & rewind forks: replays have new uuids but same parentUuid/timestamp; don't count abandoned branches silently.
5. Sidechain replays (/btw, aside) re-log parent history; keep subagents out of main-thread prompt metrics.
6. `model:"<synthetic>"` + isApiErrorMessage = API error stub; separate `system` subtype `api_error`.
7. Real user prompt filter: exclude isMeta, isCompactSummary, interrupt text, tool-result carriers, text starting "This session is being continued", `<local-command-caveat>`, `<task-notification>`, "Stop hook feedback:", lone `<system-reminder>`, IDE tags. In newer logs `origin.kind == "human"` marks real prompts (seen).
8. Queued prompts typed mid-turn: `attachment.type = queued_command` (seen), prompt string or blocks; older `queue-operation` remove records; modern writes both → dedupe; skip isMeta / origin.kind=peer. These are real mid-turn pushback.
9. Interrupts: list-form text `[Request interrupted by user]` / `… for tool use` (both seen); also `API Error: Request was aborted.`
10. User rejection vs tool failure: `toolDenialKind` field (values such as user-rejected, automode-blocked…) / "doesn't want to proceed" text.
11. Thinking redaction: empty-text thinking blocks (more than half of those seen); signature length is depth proxy; attachments `thinking_drop`, `thinking_stripped`.
12. Confounders on records: `effort`, `version`, `entrypoint`, `permissionMode`, attachment `model`, /model /effort commands.
13. Truncated last line = partial write.
14. Subagent files `<session>/subagents/agent-*.jsonl`, start with null parentUuid.
15. Codex fork replay: forked/subagent rollouts copy parent history with new timestamps; check `forked_from_id`, `parent_thread_id` (both seen).
16. Codex tokens: `token_count` repeats byte-identically; input includes cached; reasoning inside output; `token_usage_record` (response_id, turn_token_usage, usage) holds streaming snapshots → dedupe by response_id keep last.
17. Codex tools: `event_msg/item_completed` items CommandExecution/McpToolCall/FileChange/CollabAgentToolCall with status completed/failed; interrupts `turn_aborted` reason "interrupted"; compaction `compacted` + `ContextCompaction` items. Support legacy shapes too.
18. Codex injected context in user messages: `# AGENTS.md`, `<environment_context>`, `<INSTRUCTIONS>`, `<turn_aborted>`, `<subagent_notification>`, `<codex_internal_context …>`; re-emitted first prompt after turn_aborted.
19. Codex archived_sessions: dedupe by basename.
20. Count unparseable/unknown record types and surface them (format drift).

## Metrics to compute (ratio of totals per window; no composite score)
Interrupt rate (per 100 prompts, per 1k tool calls); user-rejection rate; pushback-like prompt rate (editable phrase list + near-duplicate of previous prompt); tool error rate (excl. rejections); research:mutation and Read:Edit; edits without prior read; write share; retry rate (codeburn) + churn (agentsview); steps per prompt; tokens per prompt (output, total, uncached input); cache hit rate (excl. first turn of session); API error rate + compaction rate; thinking depth proxy (median signature length + redacted share); stop-phrase rate. Context on every row: model, effort, CLI version, project, main vs subagent.

## Change detection (recommended)
Cluster bootstrap on **known split points** (CLI version, model, effort, date windows), not blind CUSUM. Resample clusters (sessions — or, for few-long-session users, session-days) ~2,000×; 95% interval of difference in ratio-of-totals; report effect size + interval, no p-values. Call a change real only if: minimum effect size AND interval excludes 0 AND same direction in ≥2/3 of projects with enough data (nerf-watch workload rule). Never a verdict from one metric. If prompt length / project mix / session length / CLAUDE.md size also changed → "cause unclear". Below minimum data → "insufficient data". CUSUM only optional ongoing monitor.

## Reuse
All MIT except claude-session-analyzer (none → don't copy). Prefer re-implementing from definitions; keep MIT notices in THIRD_PARTY_NOTICES if adapting code (nerf-watch © Abel Yagubyan; codeburn © AgentSeal; agentsview © Kenn Software LLC; ccusage © ryoppippi; claude-code-log © Daniel Demmel; nerfwatch © Luke Jacobsen; inspecto © Rahul Bhardwaj; sniffly © Chip Huyen). Credit issue #42796 in docs.
