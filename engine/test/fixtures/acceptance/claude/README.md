# Claude Code reader — acceptance fixtures

Black-box fixtures for `engine/src/readers/claude.ts`, used by `engine/test/acceptance/claude*.test.ts`.
The tests only use the contract in `engine/src/types.ts` (`Reader.root/list/parse`), with
`WASITME_CLAUDE_DIR` pointed at `home/` (the `~/.claude` equivalent, so `root()` = `home/projects`).
They use a fixed ctx: `makeHash("test-salt")`, `now = 2026-10-04T12:00:00Z`, `timeZone = "UTC"`.

**100% synthetic.** Every record was written by hand in `build-fixtures.ts` using only the field names
and enums that a counts-only check of real logs found (names and enum values, no content). Nothing was
copied, sliced or "anonymized" from real logs. Every free-text field carries a privacy sentinel (`TESTSECRET`,
`sk-ant-TESTSECRET123`, `/Users/alice/secret-project`, a `feature/TESTSECRET-branch` git branch and a
`secret-slug-TESTSECRET` slug), so the privacy tests can prove none of it reaches the output.

## Files

| File | What it is |
|---|---|
| `build-fixtures.ts` | Deterministic generator and the single source of truth. It defines the scenario registry (`SCENARIOS`), the prompt texts whose lengths the tests assert (`PROMPTS`) and the sentinels. Importing it has no side effects. |
| `harness.ts` | Test helpers. Importing it sets `WASITME_CLAUDE_DIR` and `CLAUDE_CONFIG_DIR` to `home/` and `HOME` to an empty temp dir **before** the reader is imported, so a test can never read the real `~/.claude`. It also provides the fixed ctx, `findSource` (never assumes `files[0]` is the main file or that `list()` comes back in any order), a per-process memoized `parseScenario`, and `expectFields`. |
| `home/**` | The generated tree. Do not edit it by hand. |

Regenerate after changing the generator (`claude-fixtures.test.ts` fails if the committed bytes differ):

```sh
npm run build -w engine && node engine/dist/test/fixtures/acceptance/claude/build-fixtures.js
```

All timestamps are in `toISOString()` form (`…T10:00:00.000Z`) and earlier than `now`, apart from the
two deliberately out-of-range ones in `clock`. Session files are named `<sessionId>.jsonl` like the real
ones. Session ids are `c1a0de00-0000-4000-8000-0000000000NN`.

## Scenarios

The numbers in brackets are research/05 edge-case numbers. E0, E1, … are exchanges in file order.

| Scenario | Project folder / file | Intent |
|---|---|---|
| `basic` | `-Users-alice-secret-project/…01.jsonl` | Happy path. Four legacy-shape prompts, labels never change (2.1.288 / claude-opus-5-5 / high / default / claude-desktop). Per-exchange steps, tokens, reads/edits and `durationMs` (prompt → last record: 30 s, 25 s, 26 s, 9 s). Pushback: E1 starts with "no," (phrase) and E3 is a near-duplicate of E2 (Jaccard 0.85). No events and clean stats. |
| `filters` | same folder, `…02.jsonl` | Legacy records with **no `origin` field** [#7 #9 #10]. Only 3 records are prompts. Not prompts: an isMeta caveat, `<local-command-stdout>`, a "This session is being continued…" text with no flag, an isMeta skill expansion, `<task-notification>`, "Stop hook feedback:", a lone `<system-reminder>`, a lone `<ide_opened_file>`, a string-content tool-result carrier (has `toolUseResult`) and the interrupts. E0 is a legacy `[Image #1] …` prompt (text block + image block + `imagePasteIds`), which the spike missed. It has a list-form interrupt and a non-error `<synthetic>` "No response requested." stub, which is not a step. E1 has a legacy text-only rejection ("doesn't want to proceed", no `toolDenialKind`), which is a rejection and not a tool error, plus a string-form "… for tool use" interrupt. E2 has two interrupts and the flag stays 1. There is no `effort` field, so effort is `unknown`. |
| `modern` | `-Users-alice-secret-project-modern/…03.jsonl` | `origin.kind` shapes. A task-notification starts agent work before any prompt: exchange X0 with `humanPrompt 0`, `t` = the notification record (08:00:00) and `promptChars 0` [#7]. In E1 two real `queued_command` attachments (one string, one blocks prompt) each have `queue-operation` enqueue/dequeue twins → `queuedMidTurn 2`. An isMeta queued command and a peer queued command are skipped [#8]. A peer message (`origin.kind peer`) is not a prompt, and its reply stays in E1. E2 is a modern `[Image #2]` prompt followed by an interrupt record that itself carries `origin.kind human`, which is still not a prompt. E3 is an IDE-selection block plus typed text in one human prompt. |
| `tools` | `-Users-alice-secret-project-tools/…04.jsonl` | Tool outcomes [#10]. E0 has 15 tool calls: 1 plain error, 1 `user-rejected`, 1 `automode-blocked`, 1 `permission-rule` → blocked 2. Reads: Read×3, Glob, Grep = 5. Edits: Edit×6 + MultiEdit = 7. Blind edits: b.ts and e.ts were never read → 2. Churn: a.ts edited 3× → 1. Calls #11 and #12 are one response streamed over two lines (same requestId, identical usage) → 1 step, 2 tool calls, usage counted once [#1]. E1 covers the "previous 10 tool calls" window: f.ts was read by the immediately preceding call (previous exchange) → not blind; a.ts was read 15 calls earlier → blind. |
| `usage` | `-Users-alice-secret-project-usage/…05.jsonl` | Responses and tokens. E0 [#1 #11]: response 1 is streamed over 3 lines (out 12/12/310). Response 2 is streamed over 3 lines with out 25/520/515, so **MAX ≠ last**, which pins the MAX rule. Three thinking blocks: signatures 400 (empty text), 1000, 600 (empty text) → 3 / 2 redacted / median 600. E1 [#6]: 3 `system/api_error` retries, then a `<synthetic>` `isApiErrorMessage` stub → apiRetries 3, apiErrors 1, steps 0, model not `<synthetic>`. E2: 2 retries, then success → apiRetries 2, apiErrors 0. E3 [#3]: no `requestId`; two **different** responses share `message.id` (different timestamps and usage) → 3 steps. E4 [#4]: auto `compact_boundary` mid-exchange, an `isCompactSummary` record, then the previous assistant and tool_result re-logged with new uuids (same parentUuid, timestamp and requestId) → no double count. E5: `afterCompaction` is true. |
| `subagents` | `-Users-alice-secret-project-subagents/…06.jsonl` + `…06/subagents/` | [#5 #14] E1 spawns `subagents/agent-a1b2c3d4e5f60718.jsonl`: 3 tool calls, 560 output tokens, with one response split over 2 lines (100 → 260). E2 spawns the nested `subagents/workflows/wf-7/agent-b5e6f7a8b9c0d1e2.jsonl`: 2 tool calls, 400 tokens, including an Edit that must not count as a main edit. Subagent usage is output-only on purpose, so `subTokens` comes out the same however "tokens" is defined. Subagents run claude-sonnet-5/low; main runs claude-opus-5-5/high, and subagent labels must not vote. Decoys: `workflows/wf-7/journal.jsonl` (would add 99,999 tokens), `subagents/notes.txt`, `tool-results/*.txt`. E3 has an inline /btw aside (`isSidechain`) that re-logs E0's prompt and response (new uuids, same requestId) and then asks its own question (out 35). |
| `resumeA`, `resumeB` | `-Users-alice-secret-project-resume/…07.jsonl`, `…08.jsonl` | [#2] B is A resumed the next day. It starts with a `summary` record, then replays all 6 of A's records with the same uuid, timestamp and requestId but `sessionId` = B, then adds one new exchange. Parsed in order A then B: A has 2 exchanges, B has 1, and B's `stats.duplicates` = 6. Totals across a scan are 3 exchanges, 5 steps and 250 out tokens in any parse order. Rescans must be identical. |
| `unicode` | `-Users-alice-secret-project-robust/…09.jsonl` | Raw U+2028/U+2029 inside the prompt, assistant text, tool input and tool result. `JSON.stringify` leaves them unescaped. A reader that also splits on them (Node `readline`) corrupts records. The E0 prompt is 65 UTF-16 units. |
| `damaged` | same folder, `…10.jsonl` | [#13] 4 bad lines (`{not json`, `[1,2,3]`, `"just a string"`, and a partial record in the middle of the file) and a final line cut off mid-record with no trailing newline → `badLines 4`, `truncatedTail 1`. The truncated response (out 999) is not counted. |
| `clock` | same folder, `…11.jsonl` | The clock goes backward: E1's prompt is 6 h before E0's. Exchanges stay in file order. E1 contains tool results stamped 2019 and 2035 → `badTimestamps 2`, those records still count, and `durationMs` ignores them (40 s). E2's clock jumps back mid-exchange, so `durationMs` must be in [0, 931 000] and never negative. |
| `drift` | same folder, `…12.jsonl` | [#20] One record of every non-message type that the counts-only check found (none may appear in `unknownTypes`), including `cost-state` with huge `modelUsage` totals that must not be added to tokens. Also attachments, system subtypes, 2× `relocated` (unknown, counted) and 1 record whose `type` is a path (counted, but its key must be sanitized). E1 holds malformed-but-valid JSON: `message` as a string, string `content`, `usage` with `"1000"` / `-50` / `null`, `content: 42`, `message: null`. No crash, no negatives. |
| `empty` | same folder, `…13.jsonl` | Zero-byte session file. Listing it is optional; if it is listed, it parses to nothing. |
| `labels` | `-Users-alice-secret-project-labels/…14.jsonl` | [#12] Version auto-update 2.1.287 → 2.1.288 between E0 and E1. A `/model` command (caveat + `<command-name>` + `<local-command-stdout>` with ANSI codes) and then sonnet/medium → opus/high, plus permission mode default → bypassPermissions in E2. Entrypoint `cli` never changes. Expected: exactly one event each for version, model, effort and mode, each timed between the last old record and the first new one. The model event has `userInitiated: true` and `side: "you"`. |
| `labelsDirty` | same folder, `…15.jsonl` | Labels that `cleanLabel` must reject: a path as the model, ANSI and `<b>` in effort, an 80-char model. Also a version majority within E1 of 3 records 2.1.288 vs 1 record 2.1.289. |
| `home/history.jsonl` | outside `projects/` | Decoy (Claude Code prompt history). It must never be listed. |

## Interpretation choices pinned by the tests (spec pins, not stated verbatim in the contract)

- `WASITME_CLAUDE_DIR` points at the `~/.claude` equivalent; `root()` is `<dir>/projects`.
- Subagent work goes only into `subToolCalls` and `subTokens`, and (D62a) its reads / edits / blind edits into
  `subReads` / `subEdits` / `subBlindEdits`. Main `steps`, `toolCalls`, `reads`, `edits` and tokens, and the
  exchange's labels, come from the main thread only.
- A streamed response counts once, with the **maximum** `output_tokens` across its lines (research/05 #1).
- With no `requestId`, responses are keyed per timestamp, not by `message.id` alone (research/05 #3).
- `queued_command` prompts never open an exchange; they increment `queuedMidTurn` (research/05 #8).
- `interrupted`, `pushback` and `churned` are 0/1 flags, as typed in the contract.
- `relocated` was not in the first list of known types; since D62b it is (EnterWorktree moved the transcript),
  so it is no longer reported in `unknownTypes`.
- An agent-initiated exchange's `t` is its first record (the task-notification), not its first response.
- A model change right after `/model` has `userInitiated: true` and `side: "you"`.
- Cross-file resume duplicates are dropped somewhere inside a scan (per-source counts are checked for
  parse order A then B), and re-parsing a source gives identical results.

## Deliberately NOT asserted (ambiguous in contract/research; see the test report)

Rewind forks and abandoned branches (#4). A replayed *human prompt* after compaction. `automode-unavailable`
denials. "API Error: Request was aborted." as an interrupt. `<command-name>` custom slash commands as
prompts. `stats.duplicates` when streaming splits are present. `promptChars` when IDE tags share a prompt.
Where an inline /btw aside's tokens go (main or sub are both accepted, but never both). `side` for
version and effort events. `seq` numbering inside a resumed file. Whether `durationMs` uses max − min or
another clamp after a mid-exchange clock jump (only the bounds are checked).
