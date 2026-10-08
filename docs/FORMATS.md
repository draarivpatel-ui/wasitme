# Formats: glance.v1 and snapshot.v1

wasitme's engine writes two JSON files, and everything you can see (the menu bar, the Control Center, the Claude Code pane,
the status line, the CLI) reads them. This page is the short version. The schemas are the authority; the display rules
are in [CONTRACT.md](CONTRACT.md#display-rules).

| | glance.v1 | snapshot.v1 |
|---|---|---|
| File | `~/.wasitme/glance.json` | `~/.wasitme/snapshot.json` |
| Schema id | `wasitme.glance/1` | `wasitme.snapshot/1` |
| Schema | [`contract/glance.v1.schema.json`](../contract/glance.v1.schema.json) | [`contract/snapshot.v1.schema.json`](../contract/snapshot.v1.schema.json) |
| Size | 16 KB or less, compact JSON | 512 KB or less, compact JSON |
| What it is | The summary: one entry per agent, the state, the words, the top three indicators, a 42-day strip, the five newest changes | The glance plus the detail behind it |
| Read by | Menu bar, popover, desktop panel, Claude Code pane and band, status-line source, CLI | Control Center, reports |

`~/.wasitme` is the default; the `WASITME_HOME` environment variable (an absolute path) moves it. Both files are written
atomically (a temporary file, then a rename), so a reader never sees half a file.

## glance.v1

Top level (all required):

| Field | Meaning |
|---|---|
| `schema` | Always `wasitme.glance/1`. |
| `engine` | The engine version that wrote it. |
| `generatedAt` | RFC 3339 time with an explicit offset. |
| `staleAfterSec` | How long the file counts as current, in seconds. Required; a reader that finds it missing assumes 7,200. |
| `scanOk`, `scanError` | Whether the last scan worked. On failure `scanError` is one of `permission_denied`, `write_failed`, `timeout`, `internal`: a kind, never error text. |
| `demo` | `true` for output of `wasitme demo`. Every surface shows a DEMO marker. |
| `lead` | `timeline` or `verdict`: which layout leads. Timeline-led is the default ([D28, D61](DECISIONS.md)). |
| `agents` | One entry per agent, in the engine's order. The single-glyph surfaces (menu bar) speak for the first. |
| `privacy` | `{ "containsText": false }`. A consumer refuses a file that does not say so. |

Per agent:

| Field | Meaning |
|---|---|
| `agent` | An open string (`claude-code`, `codex`, and whatever is added later). |
| `state` | `you`, `agent`, `none`, `insufficient` or `unclear` ([D22](DECISIONS.md)). The UI calls the result a *Finding*; the file keeps the word "verdict" in its field names. `stale` is a display state that readers compute; it is never written. |
| `reason` | Why, when the state needs one. `insufficient`: `calibration_pending`, `needs_data`, `single_indicator`. `unclear`: `mixed`, `workload`, `unknown_provenance`, `both_sides`, `nothing_recorded_on_your_side`, `blind_spot`. `agent`: `by_elimination` or null. Otherwise null. |
| `pending` | A change of state is waiting for a second agreeing evaluation; the state shown is the held one. |
| `calibrated` | This agent passed its own null calibration. `false` always means `insufficient` with `calibration_pending`, shown as **Timeline only**. |
| `label`, `headline`, `because`, `tryThis`, `confidence`, `band`, `statusLine` | The words, written by the engine. Limits: 24, 80, 200, 160, 160, 100 and 80 characters. |
| `n` | Counts behind the result: exchanges, sessions, session-days, days. |
| `progress` | What would unlock a finding: the tier, and per indicator the sessions, session-days and events you have and need. The `etaDate` field exists, but in v1 the words layer withholds projected dates (`SHOW_DATES = false` in [`engine/src/words/facts.ts`](../engine/src/words/facts.ts), [D66](DECISIONS.md)), so no surface prints one. |
| `topMetrics` | Up to three indicators: counts for the recent and baseline windows (`k` of `n`), the ratio, its **range**, and the smallest change the data could have shown (`mde`). |
| `strip` | Up to 42 daily `k`/`n` pairs for one indicator, plus the window-level ratio and range. Integers only. |
| `events` | Up to five newest changes: day, kind, side (`you`, `agent`, `unknown`, `meta`), strength, a label, and whether it is new. |

## snapshot.v1

Every glance field, with the same name and the same shape (a test holds the two schema files to that), plus:

- top level: `health` (sources, parser versions, whether the scan ran in the Node sandbox, which indicators are paused and
  why) and `calibration` (the calibration artifact's date, the method id, and per agent the sequences and false-alarm
  counts the artifact recorded);
- per agent: `tier`, `windows` (the recent and baseline day ranges), `metrics` (every indicator with eligibility, the
  standardised ratio and range, and a daily series), `onset`, `timeline` (the full change list, oldest first), `candidates`,
  `confounders`, `observation` (which days were fully observed), `setup` (counts and allow-listed labels), `trace` ("Why
  this finding": the decision-table rows in order, ending at the one that matched) and `disclaimer`.

How each part is worked out is in [METHOD.md](METHOD.md).

## Rules that hold for both

- **Frozen.** The vocabulary and shape froze at the contract freeze ([D45](DECISIONS.md)). Only additive changes are
  allowed, made to the schema, the generator and the regenerated goldens in the same commit.
- **Closed objects.** Engine-written objects have `additionalProperties: false`, so engine drift fails the tests.
  Readers are the opposite: they decode tolerantly and ignore fields they do not know.
- **Exact schema id.** Anything other than the exact id, including a minor id such as `wasitme.glance/1.2`, shows "Update
  needed". Minor ids are reserved and never written.
- **Unknown values degrade safely.** An unknown state reads as `unclear`, an unknown reason as null, an unknown side as
  `unknown` (never `agent`), an unknown `scanError` as `internal`, an unknown `lead` as `timeline`.
- **Strings are data.** Every string is engine-owned text. Readers show it as plain text (never HTML or Markdown),
  strip control, bidirectional and invisible characters, and bound its width.
- **Numbers only.** There is no field that can hold a prompt, a path or code. `privacy.containsText` is the guard and
  [`scripts/check-privacy.mjs`](../scripts/check-privacy.mjs) is the tripwire. See [PRIVACY.md](PRIVACY.md).

## Display rules, in one list

First match wins ([CONTRACT.md](CONTRACT.md#display-rules) has the full text):

1. Not a JSON object, or the wrong schema id: **mismatch**. Nothing from the file is shown.
2. `privacy.containsText` is not the boolean `false`: **refused**. Nothing is shown.
3. `generatedAt` unreadable, older than `staleAfterSec`, or more than 300 seconds in the future (a clock that went
   backward): **stale** for every agent. The last state may be shown dimmed, never as current.
4. No agents: **empty**.
5. Otherwise each agent shows its own state, with the fallbacks above.

`scanOk: false` is separate: it adds a notice next to whatever the rules decided.

## Test data

[`contract/fixtures/`](../contract/fixtures/) holds the shared goldens: 25 valid glances (every state in both layouts, every
reason, stale, pending, empty, demo, a failed scan, and a file of hostile labels), 4 valid snapshots, and 5 deliberately
invalid files. `manifest.json` says what each should decode to. The same files are decoded by the engine
([`contract.test.ts`](../engine/test/contract/contract.test.ts)), the Mac app ([`ContractTests.swift`](../macos/Tests/WasitmeCoreTests/ContractTests.swift),
[`GoldenTests.swift`](../macos/Tests/WasitmeCoreTests/GoldenTests.swift)) and the Claude Code mod
([`glance.test.ts`](../plugin/tests/glance.test.ts)). The text in them is what the engine's words layer produces, held equal by
[`contract-goldens.test.ts`](../engine/test/words/contract-goldens.test.ts). All of it is synthetic.

## Other files you may meet

These are internal. They are not public formats and can change between releases.

| File | What |
|---|---|
| `~/.wasitme/engine.json` | Where the engine is: absolute paths to Node and the CLI, and whether the Node sandbox flag works. Written by the installer, owner-only. |
| `~/.wasitme/history/`, `state/` | The derived store (see [PRIVACY.md](PRIVACY.md#what-is-stored)). |
| [`docs/calibration/*.json`](calibration/) | Dated calibration artifacts (`kind: "wasitme-calibration"`, `formatVersion: 1`, always `synthetic: true`). The engine ships a trimmed copy of the newest and reads its flags; see [METHOD.md](METHOD.md#14-calibration). |
