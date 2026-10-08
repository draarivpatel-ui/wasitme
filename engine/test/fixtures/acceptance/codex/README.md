# Codex reader acceptance fixtures

Synthetic Codex home (`home/`) used by `engine/test/acceptance/codex.test.ts` (black-box tests of
`codexReader`) and `codex-fixtures.test.ts` (fixture self-checks). The tests point
`WASITME_CODEX_DIR` at `home/` and parse every source with
`{ hash: makeHash("test-salt"), now: 2026-10-04T12:00:00Z, timeZone: "UTC" }`.

**Privacy: 100% synthetic.** Every record is written by `generate.mjs`. Nothing was copied, sliced or
"anonymised" from a real log. Real Codex logs were consulted only through aggregate probes that
printed counts of field names / enum values (no text, paths or ids), to keep shapes realistic.

**Regenerate:** `node generate.mjs` (deterministic). `codex-fixtures.test.ts` fails if `home/` drifts
from the generator, so never hand-edit `home/`.

## Tree

| Fixture (thread suffix) | Path under `home/` | Scenario | Exchanges |
|---|---|---|---|
| A `0001` | `sessions/2026/09/27/…` | paginated main session (`item_completed`) | 6 |
| B `0002` | `sessions/2026/09/27/…` | subagent thread (`parent_thread_id`, `source.subagent`) | 0 |
| C `0003` | `sessions/2026/09/27/…` | forked subagent: own `session_meta`, copied parent `session_meta` at line 1, copied parent messages, `subagent_history_start_ordinal` → `thread_settings_applied` | 0 |
| D `0004` | `sessions/2026/09/28/…` | legacy history (`exec_command_end` / `patch_apply_end` / `mcp_tool_call_end`, `user_message` events, `token_count` only) | 3 |
| E `0005` | `sessions/2026/09/28/…` | legacy fork of D (`forked_from_id`) with D's `session_meta` + D1–D2 copied, all re-stamped at the fork moment | 1 |
| F `0006` | `sessions/2026/09/29/…` | migration: F1 legacy-only, F2 every prompt/tool twice (canonical item + legacy event, same ids/text), F3 canonical-only | 3 |
| G `0007` | `sessions/2026/09/30/…` | `history_base` child of A (no `forked_from_id`, no copies, ordinals continue from `end_ordinal_exclusive`) | 1 |
| H `0008` | `sessions/2026/10/01/…` **and** `archived_sessions/…` | `codex exec` session; byte-identical archived twin | 1 |
| I `0009` | `sessions/2026/10/01/…` | `external-import-turn-1..3` stamped at one moment (no `turn_context`, no token records, `started_at` keeps the original time) + one real turn | 1 |
| J `000a` | `sessions/2026/10/02/…` | raw U+2028/U+2029 in strings, 3 malformed lines, unknown envelope types (one path-like), 2 out-of-range timestamps, clock reset backward, ANSI+path model label | 3 |
| K `000b` | `sessions/2026/10/03/…` | `<heartbeat>`-started session, then a prompt whose exchange absorbs `<task-notification>` and `<scheduled-task>` turns | 2 |
| M `000f` | `sessions/2026/10/03/…` | steering: second `UserMessage` inside a running turn | 2 |
| R `0010` | `sessions/2026/10/03/…` | read paths relative to the turn cwd, edits absolute | 1 |
| L `000c` | `sessions/2026/10/04/…` | live session: last turn unfinished, final line truncated (no newline) | 2 |
| O `000e` | `sessions/2026/10/04/…` | 0-byte rollout | 0 |
| N `000d` | `archived_sessions/…` only | archived-only session | 1 |
| — | `sessions/2026/10/01/notes.txt`, `history.jsonl` | decoys that must never be listed or read | — |

16 sources, 27 exchanges. Every prompt, output, diff, id, branch, nickname and instruction carries a
`canary` marker; outputs also carry fake `sk-live…`, `AKIA…`, `ghp_…` secrets.

## Expected per-exchange values (what the tests assert exactly)

`inTok` = `input_tokens − cached_input_tokens` (input includes cached: research 05 #16);
`cacheRead` = `cached_input_tokens`; `cacheWrite` = `cache_write_input_tokens`; `outTok` =
`output_tokens` (reasoning is inside output: research 05 #16). One response = one `response_id`
(`token_usage_record`, keep the last snapshot) or, when a turn has no `token_usage_record`, one
non-repeated `token_count` with `info` (research 05 #16).

| Ex | steps | tools | err | reads | edits | blind | out | in | cacheRead | other |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 | 7 | 6 | 1 | 2 | 2 | 0 | 2320 | 7600 | 89000 | repeated `token_count` |
| A2 | 6 | 5 | 1 | 0 | 1 | 1 | 1530 | 3100 | 100600 | pushback (phrase); MCP failed; spawn_agent + wait |
| A3 | 4 | 3 | 0 | 1 | 1 | 0 | 1090 | 5400 | 33400 | compactions 1 (`compacted` + `ContextCompaction`) |
| A4 | 4 | 3 | 0 | 0 | 3 | 0 | 1500 | 2500 or 1500 | 32800 | pushback (near-dup), churned, cacheWrite 1000, snapshot, gpt-6.1-sol/xhigh, afterCompaction |
| A5 | 1 | 1 | 0 | 1 | 0 | 0 | 120 | 500 | 9500 | interrupted |
| A6 | 1 | 0 | 0 | 0 | 0 | 0 | 80 | 500 | 10000 | durationMs 10000 |
| D1 | 6 | 5 | 2 | 1 | 1 | 0 | 1220 | 7200 | 54500 | exit 2, MCP `Err`; null-info + repeated `token_count` |
| D2 | 4 | 3 | 1 | 1 | 1 | 0 | 1030 | 2000 | 48200 | pushback (phrase) |
| D3 | 1 | 1 | 0 | 1 | 0 | 0 | 80 | 300 | 13200 | interrupted |
| E1 | 3 | 2 | 0 | 1 | 1 | 0 | 640 | 1800 | 41500 | durationMs 60000 |
| F1 | 2 | 1 | 0 | 1 | 0 | 0 | 500 | 4400 | 10000 | `token_count` only |
| F2 | 4 | 3 | 1 | 1 | 1 | 0 | 930 | 1600 | 32700 | every record twice |
| F3 | 2 | 1 | 0 | 0 | 1 | 1 | 500 | 700 | 18500 | durationMs 40000 |
| G1 | 2 | 1 | 0 | 0 | 0 | 0 | 700 | 5500 | 35000 | same project as A |
| H1 | 1 | 0 | 0 | 0 | 0 | 0 | 60 | 3000 | 0 | entrypoint `exec` |
| I4 | 2 | 1 | 0 | 1 | 0 | 0 | 350 | 9400 | 9000 | the only exchange in I |
| J1 | 2 | 1 | 0 | 1 | 0 | 0 | 250 | 4300 | 6000 | U+2028/U+2029 prompt |
| J2 | 2 | 1 | 0 | 0 | 1 | 1 | 210 | 900 | 11300 | t 09:00 after a 15:00 turn; pushback; model unknown/other |
| J3 | 1 | 0 | 0 | 0 | 0 | 0 | 50 | 200 | 6200 | durationMs 5000 |
| K0 | 2 | 1 | 0 | 0 | 0 | 0 | 300 | 4300 | 4000 | humanPrompt 0, promptChars 0 |
| K2 | 6 | 3 | 1 | 1 | 1 | 1 | 670 | 1700 | 31100 | absorbs K3, K4; durationMs 1510000 |
| M1 | 3 | 2 | 0 | 1 | 1 | 0 | 870 | 6000 | 16600 | queuedMidTurn 1 |
| M2 | 2 | 1 | 0 | 0 | 1 | 0 | 390 | 800 | 16500 | |
| R1 | 4 | 3 | 0 | 1 | 2 | 1 | 1220 | 5300 | 21500 | relative read covers absolute edit |
| L1 | 2 | 1 | 0 | 0 | 1 | 1 | 600 | 3600 | 3000 | |
| L2 | 1 | 1 | 0 | 1 | 0 | 0 | 90 | 400 | 3600 | unfinished, durationMs 9000 |
| N1 | 2 | 1 | 0 | 1 | 0 | 0 | 400 | 2800 | 2500 | `list_files` read |

Stats: J `badLines 3, badTimestamps 2`, unknownTypes `codex:future_record_kind 1, codex:event_msg:future_event_kind 1,
codex:unrecognised 1` (keys namespaced by family; the path-like type collapses to `codex:unrecognised`); L `truncatedTail 1`;
F `duplicates ≥ 1`; O `files 1, everything else 0`. Events (A only): one `model`
gpt-6-luna → gpt-6.1-sol and one `effort` high → xhigh at 2026-09-27T14:20:00.000Z.

## Semantics assumed, and where each comes from

| Assertion | Source |
|---|---|
| One exchange per real human prompt; subagent work never creates one | types.ts `Exchange` doc |
| Injected context is not a prompt: `# AGENTS.md`, `<environment_context>`, `<INSTRUCTIONS>`, `<turn_aborted>`, `<subagent_notification>`, `<codex_internal_context>`, `<task-notification>`, `<heartbeat>`, `<scheduled-task>` | research 05 #18 + task brief |
| Work before any human prompt is an agent-initiated exchange (`humanPrompt 0`, `t` = its first record); later non-human turns are absorbed into the open exchange | types.ts `humanPrompt`, `t`, `Exchange` doc |
| Imported `external-import-turn-N` turns are not this agent's work → no exchanges | task brief; observed shape (no `turn_context`, no tokens, one timestamp) |
| Fork copies are not re-counted (`forked_from_id`; subagent forks also give `subagent_history_start_ordinal`); `history_base` children hold only their own records | research 05 #15, 07 "Forks/subagents" |
| Migration twins (item + legacy event with the same id / text) count once | research 07 "Two history modes" |
| `toolCalls` = CommandExecution, McpToolCall, FileChange, CollabAgentToolCall items (legacy: the three `*_end` events) | research 05 #17 |
| `toolErrors`: item `status: failed`; legacy `exit_code ≠ 0`, `success: false`, MCP `Err` | research 05 #17, 06 |
| `reads` = commands whose `parsed_cmd` is read / search / list_files | research 06 (Claude reads = Read, Grep, Glob, LS; Codex `parsed_cmd` types) |
| `blindEdits` / `churned`: types.ts definitions (window = this exchange or previous 10 tool calls; read paths resolved against the turn cwd) | types.ts |
| `interrupted` = `turn_aborted` with reason `interrupted` | research 05 #17 |
| One compaction per `compacted` + `ContextCompaction` pair; `afterCompaction` only for later exchanges | research 05 #17, types.ts |
| `version` = `session_meta.cli_version`; `model`/`effort` = `turn_context`; `mode` = `approval_policy`; `entrypoint` = `session_meta.source`; `servedModel` = `model` | types.ts field docs (entrypoint examples "vscode, exec" are Codex `source` values) |
| `pushback` = `isPushback(prompt)` or `isNearDuplicate(previous prompt, prompt)` | types.ts `pushback`; shared `pushback.ts`, `similarity.ts` |
| `durationMs` = wall-clock span, never negative; exact only where every attribution agrees, otherwise bounded | types.ts `durationMs` |
| Archived twin deduped by basename; only `sessions/**/rollout-*.jsonl` and `archived_sessions/rollout-*.jsonl` are sources | research 05 #19; task brief |
| Privacy: no prompt text, cwd, paths, commands, outputs, secrets or raw ids in `JSON.stringify(result)`; labels pass `cleanLabel` or are `unknown`/`other` | types.ts header, CLAUDE.md |

Where no source decides a value the tests accept every defensible reading instead of picking one:
`inTok` when `cache_write_input_tokens > 0` (A4: 2500 or 1500); `durationMs` of an exchange followed by
another turn (bounded by the turn's own span and the gap to the next prompt). `thinkBlocks`,
`thinkRedacted`, `thinkSigMedian` and `sub*` are only checked as invariants (`sub*` must be 0 outside
A2, the exchange that spawned the subagent). Steering (M) and relative reads (R) are not on the
enumerated task list; they live in their own `describe` blocks so a disagreement is easy to isolate.

## Observed vs constructed shapes

Observed in aggregate on real Codex 0.142–0.160 rollouts (counts of field names / enums only):
envelope `{timestamp, ordinal, type, payload, metadata?}`; turn start order `task_started` →
(first turn: developer/AGENTS.md/environment_context messages, `world_state`) → `turn_context` →
user `response_item` → `item_completed` `UserMessage`; `item_completed` payload
`{thread_id, turn_id, item, started_at_ms?, completed_at_ms}`; item shapes for UserMessage,
AgentMessage, Reasoning, CommandExecution, FileChange (`changes` keyed by absolute path), McpToolCall,
CollabAgentToolCall, SubAgentActivity, ContextCompaction; `token_usage_record` and `token_count`
payload keys; `turn_aborted` without `task_complete`; `compacted` without `turn_id`; subagent-fork
layout; `history_base` without `forked_from_id`; import turns; steering turns; mostly relative
`parsed_cmd` read paths.

Constructed (not present in the real logs above; built from docs/research/07): every legacy record
(`exec_command_end`, `patch_apply_end`, `mcp_tool_call_end`, `user_message`, `agent_message` events,
envelopes without `ordinal`, `session_meta` without `history_mode`); the non-subagent legacy fork and
its copy boundary (copied parent `session_meta` at line 1, copied records stamped exactly at the
fork's `session_meta` time); migration twins; `token_count` with `info: null`; a streaming snapshot
(real logs show one `token_usage_record` per `response_id`).

Simplifications: each tool item has exactly one matching `custom_tool_call` / `function_call`
response_item (real logs: 5,020 `exec` calls vs 4,653 CommandExecution items); one `parsed_cmd` entry
per command; one file per FileChange; `CommandExecution.cwd` is the absolute turn cwd (real values are
not plain paths).
