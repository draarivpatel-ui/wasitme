# Contract freeze: glance.v1 and snapshot.v1 (WP-02, 2026-10-04)

`contract/glance.v1.schema.json` and `contract/snapshot.v1.schema.json` are **frozen**. From here on only additive
changes are allowed, made to the schema, `contract/fixtures/generate.mjs` and the regenerated goldens in the same commit,
and only by the contract owner, with the maintainer's agreement (AGENTS.md). Thresholds freeze separately, at the WP-23 calibration gate. The
goldens' engine-owned text is the words layer's (D59): a wording change in `engine/src/words` is also a golden change.

| Piece | Where |
|---|---|
| Schemas | `contract/glance.v1.schema.json`, `contract/snapshot.v1.schema.json` |
| Shared goldens | `contract/fixtures/{glance,snapshot,tamper}/*.json` + `manifest.json`, written by `contract/fixtures/generate.mjs` (`--check` in the engine tests) |
| Engine types, decoder, checks, validator | `engine/src/contract/` (`vocab.ts`, `glance.ts`, `snapshot.ts`, `display.ts`, `check.ts`, `validate.ts`) |
| Tests | `engine/test/contract/contract.test.ts` (+ the Swift app and the mod decode the same goldens); `engine/test/words/contract-goldens.test.ts` rebuilds every golden's words from its facts and requires zero differences (D59) |

## Schema diff (draft → frozen v1)

### glance.v1
| Change | Before (draft) | Frozen |
|---|---|---|
| State vocabulary (D22) | `insufficient \| no_change \| your_side \| agent \| unclear` | `you \| agent \| none \| insufficient \| unclear`; `stale` is a display state, never written |
| New top-level | — | `staleAfterSec` (int, default 7,200 when absent), `demo` (bool), `lead` (`timeline \| verdict`) |
| `scanError` | free string | kind enum, nullable: `permission_denied \| write_failed \| timeout \| internal` (no text) |
| `engine` | optional | required |
| Removed | `primaryAgent`, top-level `statusline` | agents are engine-ordered, single-glyph surfaces speak for `agents[0]`; the status-line segment is per agent (`statusLine`) |
| `agents[].agent` | enum `claude-code \| codex` | open string (1–32) so new agents decode |
| New per agent | — | `reason` (nullable enum, METHOD.md §11), `pending`, `calibrated` (D23), `label` ≤24, `confidence` ≤160, `band` ≤100, `statusLine` ≤80 |
| Removed per agent | `direction` | the engine's words carry direction; glyphs map from `state` (+ `pending`, `calibrated`, stale) only |
| `n` | `{exchanges, clusters, days}` | `{exchanges, sessions, sessionDays, days}` |
| `progress` | `{have, need, unit, etaDays}` | `{tier 1–3, etaDate \| null, notAtCurrentPace, unlock[≤6]{metric, family, have, need}}` with `have/need = {events, sessions, sessionDays}` (METHOD.md §13) |
| `topMetrics[]` | `{id, label, unit, recent: number, baseline: number, ratio, ci, status}` | `{id, label, unit, family, role, recent{k,n}, baseline{k,n}, ratio, range, mde, status}` (integer totals; `ci` renamed `range`, D31) |
| Chart | `sparkline{points{v,lo,hi,n}, markers}` | `strip{metric, days[≤42]{d,k,n}, window{ratio,lo,hi,mde}}` (daily integers, one window-level range) |
| Events | `topEvents[≤3]{day, kind, side: you\|agent\|unclear, label}` | `events[≤5]{day, kind, side: you\|agent\|unknown\|meta, strength, label, new}`, newest first |
| Strictness | open objects | `additionalProperties: false` on every engine-written object (catches engine drift and golden typos; consumers still ignore unknown fields because they never validate) |

### snapshot.v1
Now literally "the glance plus": every glance top-level field and glance agent field appears with the same name and an
identical sub-schema (a test holds the two schema files to that). Removed: `scan{ok,ms,error,incremental}` (replaced by the
glance's `scanOk`/`scanError`), `verdict{...}` nesting (fields moved up to the agent), `likelyCause`, `mdc`, `notes`,
metric `worseWhen/nBaseline/nRecent/ci`, event `evidence/userInitiated/note`, top-level `sources` (moved into `health`).
Added per agent: `tier`, `windows{recent,baseline}`, `metrics[]` (glance metric + `eligible, ineligibleReason (enum),
sensitive, shifted, standardized{ratio,range}, series[]{d,k,n}`), `onset{from,to}`, `timeline[]` (the full event list:
`id, t, day, kind, side, strength, provenance, label, from, to, new`, oldest first), `candidates[]{event, status
open|ruled_out|background, test strata|version_boundary|routine|null}`, `confounders[]{id enum, moved, value}`,
`observation{fullyObservedDays, partiallyObservedDays, note}`, `setup{}` (counts and allow-listed labels, ≤40 keys),
`trace[]{row 1–14, matched, text}` ("Why this finding"), `disclaimer` (the fixed sentence for none/you/agent, else null).
Added top-level: `health{sources[], parserVersions{}, sandbox, paused[]}` (source `error` is a kind enum; `unknownTypes`
keys bounded to the `cleanLabel()` charset, ≤60 chars, ≤64 keys) and `calibration{artifactDate, methodId, agents[]{agent,
calibrated, sequences, falseChanged, falseAgent}}`.

### engine/src/types.ts
- `ChangeSide`: `you | agent | unclear` → `you | agent | unknown | meta` (METHOD.md §9). The Claude and Codex readers
  now emit `unknown` where they emitted `unclear`; reader tests and two acceptance-test side assertions were migrated
  (vocabulary change by the contract owner, not an acceptance dispute).
- Added, **optional until the readers fill them (required from WP-12)**: `ChangeEvent.strength`, `ChangeEvent.provenance`,
  `Exchange.toolErrorsEdit`, `Exchange.toolErrorsCmd`, `Exchange.interactiveClass` (`interactive | scripted | unknown`).
- `ParseStats.unknownTypes` keys are log-derived: readers now count with `bump()` (util.ts), so `constructor`,
  `toString` or `__proto__` are counted instead of reading `Object.prototype` (a freeze item; the plain-object
  shape is kept so existing `deepEqual(..., {})` tests hold).

## Display rules
Every surface decodes the same way (`engine/src/contract/display.ts` is the reference; `manifest.json` holds each
golden's expected result, and the Swift app and the mod are tested against it). First match wins:

1. Not a JSON object, or `schema` is not the expected id → **mismatch**. Nothing from the document is shown. Every
   surface points at `wasitme update`, which only prints how to update (the engine has no network code), in its own words:
   - Mac app (`AppCopy`) and Control Center canvas (`ui/src/pages.ts`): the title **Update needed**, then "This version
     can't read the status file's format. Run `wasitme update` in Terminal." The command is drawn as code, never with
     backticks, and the canvas prints typographic apostrophes.
   - Claude Code plugin pane (`plugin/mod/theme.ts`): "wasitme parts are out of sync", then "Run
     ~/.local/bin/wasitme update, then /reload-plugins.", and "Found: <the file's schema id>" when it named one. The pane
     calls this mismatch only for a `schema` string that is not the expected id; a missing or non-string `schema` reads
     "The last scan is not in the shape this plugin expects", and text that is not a JSON object "Could not read the
     last scan".
   - Command line: `wasitme status` prints `wasitme: update needed` (plus, at a terminal, the sentence below on
     stderr). The terminal report says "The results file was written by a different version of wasitme. Run: wasitme
     scan. If this comes back, parts of wasitme are out of sync: update it so every part is the same version (wasitme
     update shows how)."; `wasitme doctor` says nearly the same. The status line installed into Claude Code
     (`packaging/statusline.sh`) prints nothing for another schema.
   - The Mac app also refuses an `engine.json` written by a newer schema major, with "written by a newer version (…);
     Update needed: run `wasitme update`" (`WasitmeIdentity.updateNeededMessage`). That is an error about the engine file,
     not a display state of the glance or snapshot.
2. `privacy.containsText` is not the boolean `false` (missing counts) → **refused**. Nothing is shown.
3. `generatedAt` unparseable (RFC 3339 with an explicit offset only; never guessed as local time), older than
   `staleAfterSec` (default 7,200 s), or more than **300 s in the future** (a clock that went backward) → **stale**
   for every agent. The last known state may be shown dimmed beside the stale mark, never as current.
4. No agents → **empty**.
5. Otherwise each agent shows its state. An unknown `state` → `unclear`; an unknown `reason` → `null`; an unknown
   event `side` → `unknown` (never `agent`); an unknown `scanError` → `internal`; an unknown `lead` → `timeline`;
   missing `pending`/`calibrated`/`demo` → `false`; missing `staleAfterSec` → 7,200.

A file with the right schema id but a missing or mistyped `agents`, `scanOk` or `generatedAt` is corrupt (never engine
output): a consumer may refuse it (the mod shows "not in the shape this plugin expects") or decode it with no-claim
defaults (the reference decoder and the app: no agents, scan failed, stale). Either way it never shows a verdict as current.

**Unlock counters.** Each `progress.unlock` item is one gate shortfall of one indicator, counted in the window that
falls short; each of its three pairs is one quantity: `events` is the indicator's own events against the 10 it needs,
or, for an indicator with a denominator floor (reads per edit), its edits against 40. An indicator waiting only for
history or for an interval has no item. A surface shows one pair per item, the **binding** one: of the units still
short of their target (a count ≥ 0 below a target > 0; a missing field is never read as 0), the one furthest from it
by have ÷ need, a tie going to the earlier of sessions, session-days, events. It is shown in its own unit ("7 of 10
session-days", "31 of 40 edits") and any progress bar is drawn from the same pair. A sentence that lists what is
missing may name every pair that is short, each in its own unit, but never a pair that is met. When no unit is short
(only one session dominating), no count and no bar are shown. The reference is `bindingGate` in `engine/src/contract/display.ts`;
the canvas (`ui/src/derive.ts`), the app (`Unlock.binding`) and the mod (`plugin/mod/render.ts`) implement the same rule.

`scanOk: false` is orthogonal: a notice next to whatever the rules decided. `pending: true` keeps the held state (the
glyph doesn't move until two evaluations agree, METHOD.md §12); `calibrated: false` is always `insufficient (calibration_pending)`,
shown as "Timeline only". Every string is engine-owned text: consumers render it as plain text (never HTML, Markdown or
escapes), strip control, bidi and invisible characters, and bound its width. `glance/hostile-labels.json` is valid and as
nasty as the schema allows; it must render safely everywhere.

## Semantic rules (checked by `checkGlance`/`checkSnapshot`, not expressible in the schema)
- `reason` must fit the state: insufficient → `calibration_pending | needs_data | single_indicator`; unclear →
  `mixed | workload | unknown_provenance | both_sides | nothing_recorded_on_your_side | blind_spot`; agent →
  `null | by_elimination`; you and none → `null`.
- `calibrated: false` ⇔ insufficient + `calibration_pending`. `scanError` is null exactly when `scanOk`.
- `band` is non-empty only for you/agent. `progress.notAtCurrentPace` ⇒ `etaDate: null`. Interrupts never appear in `unlock`.
- Ranges contain their ratio; ineligible metrics show no ratio; strip days strictly ascending; glance events newest
  first, snapshot timeline oldest first; candidates point at timeline ids; you/agent have an onset; `by_elimination`
  needs fully observed days and a `version_boundary` candidate; the disclaimer is exactly the fixed sentence for
  none/you/agent and null otherwise. A non-empty `trace` lists decision-table rows in order and ends at the single
  matched row, which must be the row that yields the agent's state/reason (`needs_data`: row 2 or 14).
- Copy lint (DESIGN.md §3, D31) over every engine string: "quality" (outside the fixed disclaimer), "score", "dumber", "smarter",
  "nerf(ed)", "proves", "caused by", "nothing changed on your side", "look(s) like", `after … doubled|rose|fell`, a bare
  "no change", "99%".

## Setup keys
`setup` is an open map in the schema (at most 40 keys named `^[A-Za-z][A-Za-z0-9]{0,31}$`, each a string, number or
boolean), so a newer engine can add a key without a schema change, and a consumer shows a key it doesn't know under its own
words. The keys v1 writes ([D80](DECISIONS.md); `SETUP_KEYS` in `engine/src/contract/vocab.ts`), in this order; a key whose
value is unknown is left out:

| Key | Agents | Value | Read from |
|---|---|---|---|
| `version` | both | the installed version as logged, e.g. `2.1.281` (no agent name) | the last kept exchange |
| `model` | both | the model as logged | the last kept exchange |
| `effort` | both | the effort level | the last kept exchange |
| `mode` | both | the permission mode (Claude Code) or approval policy (Codex) | the last kept exchange |
| `entrypoint` | both | where the session ran from, e.g. `cli`, `claude-desktop`, `claude-vscode`, `exec` | the last kept exchange |
| `mcpServers` | both | how many MCP servers the user-level config lists | the last config snapshot |
| `skills` | both | how many skills the user-level skills folder holds | the last config snapshot |
| `hooks` | Claude Code | how many hook handlers settings.json defines | the last config snapshot |
| `pluginsEnabled` | both | how many plugins are enabled | the last config snapshot |
| `pluginsInstalled` | Claude Code | how many plugins are installed | the last config snapshot |
| `instructions` | both | whether the global instructions file exists (`CLAUDE.md` in the Claude Code config folder; `AGENTS.override.md` or `AGENTS.md` in the Codex home) | the last config snapshot |
| `instructionsBytes` | both | that file's size in bytes, only when it exists | the last config snapshot |

Labels pass the same allow-list as the scan's other labels; counts are non-negative integers. `wasitme demo` and the goldens
write exactly these keys (`engine/test/output/setup-keys.test.ts` holds both to a scan of synthetic logs). The canvas's
Setup page has a row for each (`SETUP_ROWS` in `ui/src/pages.ts`, held to this list by `ui/test/model.test.mjs`): `version`
under the agent's name, linked to its last update; `instructions` and `instructionsBytes` as one row named after the file.
Before D80 the demo and the goldens wrote `agentVersion` ("Claude Code 2.1.289"), `instructionsKTokens`, `plugins` and
`outputStyle`, which no scan wrote. No consumer of a glance or snapshot reads those names now: the Swift app decodes
`setup` as a generic map, the Claude Code mod and the terminal, Markdown and HTML reports do not show it, and the canvas
uses the keys above. The design system's own mock data (`design/system/demo-data.v3.json` and the screens made from it)
still uses the old shape; it never reaches a document.

## Goldens
34 files + manifest. Valid glance (25): every state × lead (`{state}-{timeline|verdict}`), every remaining reason
(`insufficient-single_indicator`, `unclear-{mixed,workload,unknown_provenance,nothing_recorded_on_your_side,blind_spot}`,
`agent-by_elimination`), `calibration_pending` (two agents: Claude Code `you` + Codex timeline-only), `stale`,
`stale-future-dated`, `pending`, `empty`, `demo`, `scan-failed`, `hostile-labels`. Valid snapshot (4): `you-and-codex`,
`agent-by_elimination`, `insufficient-timeline`, `empty`. Tamper (5, deliberately invalid): `glance-schema-mismatch`,
`snapshot-schema-mismatch`, `glance-unknown-values` (unknown state/reason/side/strength, missing optional-looking
fields, extra fields), `glance-contains-text`, `glance-no-privacy`. Sizes are measured compact (as the engine writes);
the largest glance golden (`hostile-labels`) is ~7 KB, and a worst-case two-agent glance (every string at its limit) stays under 16 KB.
Numbers come from `design/demo-data.v2.json`. Words are the engine's own (D59, which supersedes the earlier hand-written
text): every engine-owned string in a golden is what `engine/src/words` produces for that golden's facts, and
`engine/test/words/contract-goldens.test.ts` holds the two equal with no documented deviations. So in the goldens:
the status line is `wasitme: {label}[ +n]` and never names a change (`+1` where the golden has a `new` event); an event
with no printable facet says "MCP server added" or "Settings changed"; the confidence line is the exchange/session-day/
session counts, the other-machines sentence, and for a blind spot "Some days weren't fully observed." appended (sessions
are counted once even when one spans both windows); the churn unit is "per 100 edit exchanges"; the Codex line is
"Findings for Codex are off until wasitme's tests pass for Codex logs."; each trace sentence names the condition that
decided its row. `progress` is what v1 writes ([D66](DECISIONS.md), D72): `etaDate` is null and `notAtCurrentPace` is
false in every golden, and the same test compares the whole object. The date and not-at-pace decode rules are held by
each consumer's own inline fixture, not by a golden.

## Decisions taken at the freeze (for DECISIONS.md)
1. **Fixture split.** Goldens that validate (`glance/`, `snapshot/`) vs tamper cases that must not (`tamper/`), one
   manifest driving all consumers. Schema-mismatch and unknown-state cases cannot validate by definition.
2. **String policy.** The schema bounds string length (in code points) only — no character-class patterns. Sanitising is a
   consumer duty; producer-side protection stays with `cleanLabel()` and `scripts/check-privacy.mjs`. Log-derived map keys
   (`unknownTypes`) are the exception and are charset-bounded.
3. **Closed objects.** `additionalProperties: false` on engine-written objects; additive changes update schema + goldens together.
4. **`reason`** is required and nullable; `needs_data` is the one invented name (METHOD.md §11 rows 2/14, "insufficient with progress").
5. **`scanError`** is a nullable kind enum (`permission_denied | write_failed | timeout | internal`).
6. **No `primaryAgent`**: engine order decides; single-glyph surfaces speak for `agents[0]`.
7. **Stale rule**: `staleAfterSec` from the file (default 7,200), future tolerance 300 s, unparseable ⇒ stale. Replaces the
   mod's 48 h + 10 min and matches the app's 2 h + 5 min.
8. **Snapshot naming**: the full event list is `timeline`; `events` keeps the glance's newest-five meaning.
9. **Event strength for non-you/agent sides**: `unknown` events are `weak`, `meta` events `routine` (neither decides).
10. **Size** is measured on compact JSON (`JSON.stringify` without indentation).
11. **Mod option name**: the mod keeps `glancePath` (it points at glance.json); an earlier `snapshotPath` wording should read
    `glancePath`. The installer writes `{"glancePath": "<home>/.wasitme/glance.json"}` through `claude plugin configure
    --values-stdin`, which keeps the keys it is not given, so `showBand` stays as the person set it.
12. **Swift**: `VerdictState` raw values are the D22 names only; `stale` stays a display state (`MenuBarGlyph.stale`) and
    `calibration_pending` a reason (`VerdictReason`), not new verdict cases; missing `calibrated`/`pending` decode as `false`.
    The case for `none` is `VerdictState.noDetectableChange` (raw value `"none"`): a case named `none` would be confused
    with `Optional.none` wherever a state is optional. Don't rename it back.
13. **demo-data.v2 copy** moved to the engine's wording (since D59 the engine's words are the source of truth for golden text); its `unclear` case became `both_sides` (two changes on the user's own
    side are `you` under row 7), its `agent` case is `by_elimination` with the row-9 conditions stated, the Codex case
    is `calibration_pending`, and stale/single_indicator/layout cases were added. Numbers unchanged.
14. **Schema minor ids** (`wasitme.glance/1.<minor>`) are reserved and never written. Every consumer (reference decoder,
    mod, app — harmonised in WP-50, D45) treats anything but the exact id, compared as a string, as a mismatch.
15. **Hook test switch**: `WASITME_HOOK_DRY_RUN=1` makes the plugin hooks print the `launchctl` command instead of running
    it (tests only; it can only make the hook do less).
