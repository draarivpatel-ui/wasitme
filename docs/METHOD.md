# Method

How wasitme decides what to say. This is written for a technical reader who wants to attack the statistics, so it prefers
exact rules to friendly ones. Two conventions:

- **Every number is one that exists in this repository,** and is linked to where (one early planning table in section 6 says it is
  the exception). Where a number has not been measured, the text says **not measured**. Nothing here is rounded up.
- The code is the authority, and decisions are numbered `D##` in [DECISIONS.md](DECISIONS.md). The engine and the data files say
  "verdict"; the interface says "Finding" ([D57](DECISIONS.md)).

## Status at a glance

All calibration numbers are from synthetic logs. The artifact the shipped engine reads is [`2026-10-05.json`](calibration/2026-10-05.json).

| Piece | State |
|---|---|
| Indicator definitions, gates, windows, materiality, the decision table | Fixed in code and tested ([D23](DECISIONS.md), [D47](DECISIONS.md), [D56](DECISIONS.md)) |
| Estimator (cluster scheme, level, small-sample correction) | **Chosen: `session-t95-cr2`** (session clusters, level 0.95, CR2 correction, bootstrap; [D58](DECISIONS.md), [D69](DECISIONS.md)). It led a weak screen of the six candidates on pilot power and was then run in full; the other five were not ([`selection`](calibration/2026-10-05.json) in the artifact) |
| False "changed" and false "agent" at 1,000 null sequences per profile | **Measured, and within the limits:** 0 of 1,000 in each of 7 profiles, for both. The 95% Clopper–Pearson upper bound is 0.37% per profile, against limits of 6% and 2% |
| False-alarm budget per user over 90 days of always-on use | The same measurement: each sequence is 90 daily evaluations, and none of the 7,000 null sequences ever showed a false change or a false agent |
| Any agent marked calibrated | **Both.** Claude Code (6 profiles) and Codex (1 profile), under the voting construct `toolErrorsNonCmd`. The shipped engine reads these flags ([D69](DECISIONS.md)); a new install shows *Too early to tell* until the gates are met, not *Timeline only* |
| Power to find a real change | **Low for some users:** a planted doubling is found in 7 to 10 of 40 runs for few long sessions, sparse failures and Codex, and in 34 to 39 of 40 for the three profiles with many short sessions and ordinary failure rates (many short sessions, single project, multi-project; [below](#what-the-calibration-runs-so-far-show)) |
| G-onset (the onset interval covers the true onset) | Pass: 144 of 144 in the 2026-10-05 run |
| G-MDE and the standard-error check | Passed in the earlier small run ([`2026-10-04.json`](calibration/2026-10-04.json)); **not repeated** on the final decider |
| G-attr (limits on mis-attributing a planted change) | **Not measured on the final decider.** The artifact records it as scaffolding with zero sequences |
| Measured coverage of the printed range | **Not measured** |
| Research-family indicators on real logs after the subagent fix | **Re-run pending** ([D62](DECISIONS.md), [D65](DECISIONS.md)) |
| Projected dates | Off in v1 ([D66](#13-progress-and-why-there-are-no-dates)); G-ETA failed on four of seven profiles |

## 1. What an answer is allowed to be

wasitme reports one of five states ([D22](DECISIONS.md)): **you**, **agent**, **none**, **insufficient** and **unclear**, plus two
display states, *stale* and *Timeline only*. The rules that shape every sentence:

- Counts are **indicators.** They do not measure answer quality, and which direction counts as "worse" for an indicator is an assumption, not something validated.
- The strongest claim is "around the time of". It never says one thing caused another ([D10](DECISIONS.md)).
- It prefers "too early to tell" to a guess. A single moved indicator never becomes "no detectable change".
- Routine agent updates never decide alone. A change on your side that was recorded outranks them.
- The words are written by the engine, not by the interface, and a copy lint over every string bans overclaims
  ([`lint-copy.mjs`](../scripts/lint-copy.mjs), [D31](DECISIONS.md)).

## 2. Exchanges, sessions and days

- **Exchange** = one real human prompt plus the main-thread work until the next one. Prompts queued mid-turn count inside the
  current exchange. Machine-written text (summaries, injected context, notifications, scheduled turns) is not a prompt. The reader
  tests are in [`engine/test/acceptance/`](../engine/test/acceptance/) and [`engine/test/readers/`](../engine/test/readers/).
- **Only interactive sessions vote.** A reader's own classification (`interactive` or `scripted`) wins; where it is unknown, automation
  entry points and sessions with no human prompt on a complete past day are excluded. Every exclusion is counted ([D47a](DECISIONS.md)).
  Subagent work is context, except that research indicators count the whole exchange's work, main thread plus attributed
  subagents, so a vendor change in how much work is delegated cannot pass for a change in care ([D62a](DECISIONS.md)).
- **Days are local calendar days** in a time zone fixed at scan time and stored. Today is excluded, because a half day is not a day.
  Time is never assumed to move forward: a window is decided by an exchange's day alone, and durations are never negative
  ([`attribution.test.ts`](../engine/test/analysis/attribution.test.ts), "clock-backward timestamps").
- **Clusters.** Totals are kept per session and per local day, so the unit of independence can be the session or the
  session-day. The scheme is part of the estimator choice ([section 6](#6-estimator-range-and-the-smallest-detectable-change)).
- **Exclusions** you set with `wasitme exclude` (date ranges, projects, entry points) are applied before analysis and stay local.

## 3. Indicators

Each indicator is a ratio of totals over a window: events divided by opportunities, summed over every cluster in the window
([`defs.ts`](../engine/src/analysis/metrics/defs.ts), tests in [`metrics.test.ts`](../engine/test/analysis/metrics.test.ts)).

| Indicator (as shown) | id | Definition | Family | Role | "1 pt" |
|---|---|---|---|---|---|
| Tool errors (excl. commands) | `toolErrorsNonCmd` | Failed edit, apply and other non-command tool calls, over non-command tool calls that ran | errors | **votes** | 1 percentage point |
| Reads per edit | `readsPerEdit` | Reads (read, search, list) over edits; needs at least 40 edits per window | research | **votes** | 1.0 read |
| Edits without reading first | `blindEdits` | Edits to a file not read in the exchange or the last 10 calls, over edits | research | **votes** | 1 percentage point |
| Interruptions | `interrupts` | Interrupted exchanges over exchanges | friction | supports | 1 percentage point |
| Pushback prompts | `pushback` | Pushback-like prompts over prompts: a start-anchored English phrase list or a near-duplicate re-ask | friction | supports | 1 percentage point |
| Tool errors (all) and command failures | `toolErrors`, `cmdFailures` | Every failed call; non-zero exits of commands | errors | context | |
| Files edited 3+ times, steps, output tokens, cache hits, API retries and errors, compactions, thinking redaction, prompt length, duration | | | context | context | |

- "Tool calls that ran" excludes your rejections and permission or auto-mode blocks from both sides of the ratio.
- **Why non-command errors vote.** Most command failures reflect the code under test, not the agent. The construct was
  written down before any attribution code ([D47d](DECISIONS.md)), with a stated condition for overriding it; the counts-only check on
  real logs found that condition did not hold, so it stands ([D61](DECISIONS.md)).
- **Pushback** is off unless at least 70% of the window's prompts are in English, and, like interruptions, it measures your own
  reaction: a user primed to expect a problem interrupts more. So friction supports a finding and never decides one ([D30](DECISIONS.md)).
- **Families** are errors, research and friction. Only errors and research vote.

## 4. Windows and tiers

A comparison sets a **recent** window against a longer **baseline** window before it, both made of complete local days
([`windows.ts`](../engine/src/analysis/metrics/windows.ts)).

| Tier | Recent | Baseline | History needed |
|---|---|---|---|
| 1 | 14 days | 28 days | 42 days |
| 2 | 21 days | 42 days | 63 days |
| 3 | 28 days | 56 days | 84 days |

wasitme uses the first tier whose history is met and in which every voting family has an eligible, sensitive voting indicator.
If none does, it uses the largest tier whose history is met. A tier extends only when its gates or its sensitivity fail, and
because extension depends on the data (optional stopping), the extension rule runs inside the calibration harness, where its
false-alarm cost is measured rather than assumed.

## 5. Gates

An indicator takes part in a comparison only if, **in each window**, all of these hold ([`d23.ts`](../engine/src/analysis/gates/d23.ts),
[`gates.test.ts`](../engine/test/analysis/gates.test.ts), [D23](DECISIONS.md)):

- at least 10 events;
- at least 10 session-days;
- at least 5 sessions;
- the largest session supplies strictly less than 50% of the window's denominator (exactly one half fails);
- for reads per edit, at least 40 edits.

Sessions and session-days are counted only where the indicator has a denominator, so a session-day with reads and no edits is
not evidence for reads per edit. The test file checks the boundaries: 10, 10 and 5 pass, 9, 9 and 4 fail.

An eligible indicator is **sensitive** if its smallest detectable change is at most ×2. "Too early to tell" often means no
voting family has a sensitive indicator yet, not that nothing was found.

## 6. Estimator, range and the smallest detectable change

**Effect.** For indicator Y over opportunities X, with recent window *r* and baseline window *b*:

```
θ = ln((ΣY_r + 0.5) / ΣX_r) − ln((ΣY_b + 0.5) / ΣX_b)          ratio = exp(θ)
```

The 0.5 is a pseudo-count so a window with no events does not give an infinite ratio ([`ratio.ts`](../engine/src/analysis/stats/ratio.ts)).

**Standard error.** A stratified cluster bootstrap resamples whole clusters within each window (B = 2,000), seeded from the data so the same logs give the same
answer ([`bootstrap.ts`](../engine/src/analysis/stats/bootstrap.ts)). Each window's variance is then:

- multiplied by a small-sample factor: `count` (U/(U−1) for U units, df U−1) or `cr2` (Bell–McCaffrey: each unit's residual is scaled by
  its leverage on the ratio, with Satterthwaite degrees of freedom; it reduces to `count` when units are equal and inflates
  more when one session dominates; [`smallsample.ts`](../engine/src/analysis/stats/smallsample.ts));
- floored at the Poisson or binomial variance of the window's event count, because a bootstrap cannot see noise inside clusters that
  happened to have zero events.

The two windows' degrees of freedom are combined Welch–Satterthwaite style. When both windows have at least 5 sessions, the engine also
computes the standard error under the other cluster scheme and **keeps the larger** ([`evaluate.ts`](../engine/src/analysis/gates/evaluate.ts)).
In the calibration harness a closed-form (sandwich) version of the same standard error stands in for the bootstrap so thousands
of sequences stay cheap; the 2026-10-04 artifact checks the two against each other: median |ln(SE ratio)| of 0.012 to 0.021 across five configurations
against a limit of 0.05 ([`2026-10-04.json`](calibration/2026-10-04.json), `seCheck`).

**Range.** `exp(θ ± t(level, df) · SE)`. This is the interval the interface calls **range**.

**Smallest detectable change (MDE).** `exp((t_{1−α/2} + t_{.80}) · SE · 1.1)`: the change that would be found 80% of the time
([`mdc.ts`](../engine/src/analysis/stats/mdc.ts)). The factor 1.1 is a 10% optimism correction on the log scale, taken
from an early spike where the plain formula came out about 10% optimistic against simulated power (`mdeOptimism` in the artifact's `layout`). The check
that it holds is called G-MDE: an effect planted at the reported MDE must be detected 60 to 95% of the time. In
[`2026-10-04.json`](calibration/2026-10-04.json) it passes: 76 of 84 probes (90.5%), and 53 of 56 (94.6%) for the indicators planted directly.
Reads per edit is planted indirectly and understates detection there, which the artifact says in its own note.

**The candidates** ([D29](DECISIONS.md), [`d23.ts`](../engine/src/analysis/gates/d23.ts)). The method is not fixed by decree. It is
whichever candidate passes the verdict-level gate with the most power ([section 14](#14-calibration)).

| Id | Clusters | Level | Small-sample correction | Estimator |
|---|---|---|---|---|
| `d23-literal` (D23's literal text) | session-day | 0.99 | count | bootstrap |
| `session-day-t99-cr2` | session-day | 0.99 | CR2 | bootstrap |
| `session-t95-cr2` (**chosen**, [D69](DECISIONS.md)) | session | 0.95 | CR2 | bootstrap |
| `two-level-t95-cr2` | session, then day | 0.95 | CR2 | bootstrap |
| `wcb-session-t99`, `wcb-session-t95` | session | 0.99, 0.95 | not applicable | null-imposed, studentised wild cluster bootstrap with Webb weights |

The first per-indicator false-positive study, on synthetic users with 1,000 resamples, is why the literal text was not simply
adopted. This one table is quoted from the planning notes, which this repository does not publish, so treat it as background rather
than a reproducible result:

| Method | few long sessions, steps | few long sessions, tool errors |
|---|---|---|
| `d23-literal` | 11.1% | 5.8% (upper bound 6.9%) |
| session-day, level 0.99, CR2 | 7.8% | 3.6% |
| session clusters, level 0.95, CR2 | 1.5% | 1.3% |
| two-level, level 0.95, CR2 | 0.9% | 0.4% |

These are per-indicator rates, an input to the choice and not the gate itself. The gate is about false findings at the level of the
whole decision, after the agreement rules and persistence below.

### What "range" means

The interface prints **range** and never a percentage, because the nominal level is not a promise. With a handful of very long
sessions there are few independent clusters, and a t interval's real coverage can sit well below its label (the table above is the
evidence: methods with nominal levels of 0.95 and 0.99 produced very different false-positive rates on the same data). So:

- the range is an interval built to be honest about few clusters and uneven session sizes;
- its **measured coverage** is **not measured**: the calibration measures how often the whole decision is wrong (section 14), not how
  often a printed range contains the true ratio;
- so read it as approximate, and read the counts beside it (`k` of `n` per window, in every report).

This is also why the copy lint bans printing a nominal level ([D31](DECISIONS.md)).

## 7. "Changed": materiality and agreement

An indicator moved **materially** when all three hold ([`material.ts`](../engine/src/analysis/stats/material.ts), [D23](DECISIONS.md)):
its range excludes ×1; the ratio moved by at least 25%; and the absolute change is at least "1 pt" as defined per indicator in the table above.

A comparison is **changed** when ([`agreement.ts`](../engine/src/analysis/confounders/agreement.ts), [D30](DECISIONS.md)):

1. at least two voting indicators are material, from **both** voting families (errors and research);
2. they all moved the same way;
3. none is material the other way;
4. each has at least 4 degrees of freedom (below that, it is counted but not usable);
5. dropping any one of the 3 most influential days does not remove the change (a change resting on a day or two is **fragile** and not changed).

Related rules:

- **Opposite directions** give *unclear (mixed)*, never *none*.
- **One material indicator** never gives *none*. If it survives a Holm correction across the eligible voting indicators it becomes
  *insufficient (single indicator)* and the headline names it; if not, it appears only in "Why this finding" ([`single.ts`](../engine/src/analysis/confounders/single.ts)).
  Only indicators that survive Holm get non-neutral ink in the interface.
- **A detected shift outranks low sensitivity.** A large effect shows even when the MDE is above ×2.
- **Never "no detectable change" while an indicator moved.** Any material voting indicator rules out *none*.

## 8. Confounders

A change in your workload can pass for a change in the agent, so every shifted indicator is checked ([`confounders/`](../engine/src/analysis/confounders/),
[`confounders.test.ts`](../engine/test/analysis/confounders.test.ts)):

- **Directly standardised ratio.** The baseline is reweighted to the recent window's mix of project, model and entry point, over
  the groups present in both. If the standardised range no longer excludes ×1 or falls under materiality, the result is *unclear
  (workload)*. If no groups overlap, the text says "your projects differ too much to compare" and the result is *unclear (workload)*.
  The standardised ratio is shown beside the raw one.
- **Projects.** If at least 2 projects qualify (each passing the full gate alone in both windows), a shifted indicator must agree in at least ⅔ of them.
- **Flagged, never decisive:** a prompt-length ratio outside [0.67, 1.5]; a 15 point move in the share of long-context starts (currently
  `fields_missing`, [D53f](DECISIONS.md)); a 20 point move in mode, entry point, subagent share of edits, or Codex's interactive-to-scripted mix.

Losing a shift under standardisation only ever makes a result less specific. It never turns *none* into a claim.

## 9. Events: side, strength and provenance

The timeline is built from changes found in the logs (retroactively) and in snapshots of your configuration (from the day you install).
Each event gets a **side**, a **strength** and a **provenance** ([`events.ts`](../engine/src/analysis/attribution/events.ts),
[`attribution.test.ts`](../engine/test/analysis/attribution.test.ts), "classifyEvent").

| Class | What | Decides? |
|---|---|---|
| you · strong | Model, effort, thinking or permission mode changed **with** a command or settings record; an instruction-file hash changed; the set of MCP servers, skills, plugins or hooks changed; a Codex provider switch | yes |
| you · weak | Any other allow-listed setting; auto-memory files; theme; permission-rule tweaks | listed, never decides |
| meta | wasitme's own writes (matched by key path); a parser change | skipped |
| agent · strong | The served model differs from the requested one on at least 5 consecutive main-thread requests in at least 2 sessions, excluding stubs, routing and subagent requests | yes, **but admitted only if it proves stable; off by default** |
| agent · routine | A version bump | background only |
| unknown | Model or effort moved in the logs with **no** command and **no** settings change (the Desktop picker, a flag, an environment variable); anything before snapshots existed; a torn read | never `agent` |

- **Prompt hashes are context only.** A system-prompt hash can change for reasons unrelated to behaviour, so it never votes for *agent*.
- **A re-pick is not a change.** A `/model` or `/effort` that selects what was already in effect is dropped before analysis
  and not shown ([D65, D67](DECISIONS.md), tests "re-pick").
- **Derived model and effort events** (between sessions, from each day's majority) are `unknown` unless a recorded event matches.
  On real logs these are frequent, so most "changed" results for a user who switches models in a picker will honestly be
  *unclear (unknown provenance)* ([D61](DECISIONS.md)).
- **Fully observed days.** A day is fully observed when a global configuration snapshot was taken that day and every Claude Code session
  active that day has a project snapshot from the SessionStart hook ([D63](DECISIONS.md)). A marathon session is fully observed only on
  the days it starts or resumes; everything before install is partially observed; Codex has no hooks and is partially observed by design.
- **Format drift.** Unknown record types are counted and the Sources page shows them. The data format reserves two pause reasons for
  them (unknown records inside an indicator's own feature family, or over 2% of a window's records), but this version raises neither:
  the one pause it raises is `parser_changed`, when a family's parser version moved and history parsed by the old version still falls
  in the window ([`scan.ts`](../engine/src/store/scan.ts), `pausedFor`). Parsers are versioned per family; a version bump re-derives
  history where the source logs still exist.

## 10. Onset and attribution

Attribution runs only after *changed* ([`onset.ts`](../engine/src/analysis/attribution/onset.ts),
[`decide.ts`](../engine/src/analysis/attribution/decide.ts), [D56](DECISIONS.md)).

1. **Split statistic.** For each day *d* with at least 5 session-days (with a denominator) on each side for **every** counted
   indicator (a day that fails this for any one of them is skipped), `Z(d) = Σ s·θ(d)/SE(d)` over the shifted indicators.
2. **Onset interval I** = days with `Z(d) ≥ max Z − Δ`, at least ±2 days wide plus a 1-day guard. Δ is 2 (provisional); the
   check G-onset requires that I covers the true onset at least 80% of the time. It does: 24 of 24 in [`2026-10-04.json`](calibration/2026-10-04.json) and 144 of 144 in [`2026-10-05.json`](calibration/2026-10-05.json).
3. **Resolution.** Events about 3 days apart cannot be separated, and with an update every few days I almost always contains a routine one.
4. **Candidates** are the events inside I.
5. **Rule-out by strata, from positive evidence only.** Hold a your-side candidate's dimension at its old value. If the shift still
   shows and the gates pass, that candidate is ruled out. A restricted run that *loses* the shift shows nothing. If you made a `/model`
   switch inside I, that dimension is dropped from the standardisation first, so your own recorded change reaches *Your side* instead of
   being washed out as workload ([D53a](DECISIONS.md)).
6. **Version-boundary test** (required for *Agent side* by elimination): one boundary inside I; a comparison within ±7 days of it shows the
   shift by itself under the same gates; the shift replicates in at least 2 qualifying projects (⅔ agreeing); and every day is fully observed.

## 11. The decision table

First match wins ([`decide.ts`](../engine/src/analysis/attribution/decide.ts); one test per row in
[`attribution.test.ts`](../engine/test/analysis/attribution.test.ts)).

| # | In plain words | Result |
|---|---|---|
| 1 | The agent isn't calibrated | Timeline only (`insufficient`, `calibration_pending`) |
| 2 | Even at the largest tier, some voting family has no eligible voting indicator (eligible: its fields are present, the tier's history is met, the §5 gate passes and a range could be computed; the df floor is tested later, in rows 12 to 14) | Too early to tell (`needs_data`), with counters |
| 3 | Material indicators moved in opposite directions | Can't tell which (`mixed`) |
| 4 | Changed, but your workload mix moved too, or projects disagree | Can't tell which (`workload`) |
| 5 | Changed, and a change of unknown origin sits in the onset window (an undated change that could decide counts here too, since it cannot be placed outside the window) | Can't tell which (`unknown_provenance`) |
| 6 | Changed; a strong change of yours isn't ruled out **and** a strong agent-side event is there | Can't tell which (`both_sides`) |
| 7 | Changed; a strong change of yours isn't ruled out; agent-side candidates are routine or absent | **Your side** |
| 8 | Changed; a strong agent-side event; every strong change of yours ruled out or absent | **Agent side**, plus a blind-spot line if days were partially observed. Needs the served-model tripwire, which is off by default |
| 9 | Changed; only routine updates and weak changes of yours in I; fully observed; the version-boundary test passes | **Agent side** (`by_elimination`) |
| 10 | The same as 9, fully observed, but the boundary test fails or there is nothing in I | Can't tell which (`nothing_recorded_on_your_side`) |
| 11 | The same as 9, but days were partially observed | Can't tell which (`blind_spot`) |
| 12 | Not changed; exactly one voting indicator is material and survives Holm | Too early to tell (`single_indicator`), naming it |
| 13 | Not changed; no voting indicator is material; each voting family has a sensitive voting indicator with at least 4 degrees of freedom ([D53](DECISIONS.md)(d)) | **No detectable change** |
| 14 | Anything else, including a material indicator that fails Holm, a change resting on one day, or a lone indicator under the df floor | Too early to tell, with counters |

Notes: *Agent side* can come from row 9 only, until the served-model tripwire is admitted ([D56](DECISIONS.md); the "tripwires are OFF by default"
test). Rows 9 and 10 cannot be reached for Codex. In the 280 planted runs, row 5 fired in 3, and in none of them because of a derived
(between-session) event ([D64](DECISIONS.md); `effectRows` in [`2026-10-05.json`](calibration/2026-10-05.json): 3 raw, 0 shown, 0 from derived events).

## 12. Persistence

What the glance shows changes only when two evaluations agree: at least 24 hours apart in data time, with the second recent window
holding at least 30% new denominator **for every voting indicator** and at least 2 new session-days ([`decide.ts`](../engine/src/analysis/attribution/decide.ts), "persistence"
and "separated()" tests). Leaving a state uses the same rule, with one exception ([D70](DECISIONS.md)): a move to *Too early to tell*
(`needs_data`) is confirmed on time alone, 24 hours after it first appeared, when not one new session-day has arrived since, because an
agent that went quiet can never supply the new data the rule asks for, and holding "No detectable change" over no data would be wrong.
That exception only ever moves the glance towards *Too early to tell*, never to a finding. Row 1 bypasses persistence both ways. While a
change is pending the glance holds its state.

Persistence is for **stability, not for false-alarm control.** False-alarm control comes from the sequence gate in the calibration, which
measures the persisted output over 90 days.

## 13. Progress, and why there are no dates

For each voting indicator not yet eligible, the interface shows what is missing as counts of events, sessions and session-days
("31 of 40 edits so far"). It does not predict a date. When the largest session holds half or more of a window's denominator,
it shows no count of sessions for that: how many more would dilute it depends on how big they are, so the words say that one
session holds most (or exactly half) of the window's tool calls, edits or other denominator, and that more sessions are needed.

The analysis still projects one: from the trailing pace of new sessions and the roughly 1/√data scaling of the standard error. The
calibration checks those projections (G-ETA). After the D64 rule (a date shown only when it was stable across three evaluations
and no one session dominated), the check still failed on four of seven synthetic profiles ([`2026-10-05-eta-d64.json`](calibration/2026-10-05-eta-d64.json)):

| Profile | Dates within ±30% of the outcome | Result |
|---|---|---|
| many short sessions, single project, multi-project | 21 of 22, 17 of 21, 21 of 21 | pass |
| few long sessions | 22 of 44 | fail |
| few long sessions, high dispersion | 1 of 12 | fail |
| sparse failures | 13 of 25 | fail |
| Codex | 0 of 6 | fail |

A "not at your current pace" claim was followed by readiness within 30 days in 167 of 210 cases for the few-long profile, so the claim was
wrong about four times in five. That decided it: **v1 shows no projected dates** ([D66](DECISIONS.md), `SHOW_DATES = false` in
[`facts.ts`](../engine/src/words/facts.ts)). Dates may return only when every profile passes. The harness keeps measuring.

## 14. Calibration

Calibration is how wasitme earns the right to print findings. It is a harness over **synthetic** logs
([`engine/src/analysis/calibration/`](../engine/src/analysis/calibration/), [`engine/src/synth/`](../engine/src/synth/)); no real log is read.

**Setup.** Seven profiles: few very long sessions, the same with high session dispersion, many short sessions, single project,
multiple projects, sparse failures, and Codex. Each null sequence is a user whose setup and agent do **not** change in effect, run for 90
daily evaluations with no-effect background events: a version bump about every 3 days, a no-effect your-side effort change, and a
no-effect model change of unknown origin. **False "changed"** means the persisted result claimed a change (rows 4 to 11) on any of the 90 days.
Planted sequences add a doubling of tool errors and edits without reading first (and halve reads) at a version bump on plan day 75.

**What marks an agent calibrated.** The artifact sets `calibrated` for an agent only when that agent's own null runs pass the
[D23](DECISIONS.md) bounds: a Clopper–Pearson 95% upper bound of at most 6% false "changed" and at most 2% false "agent", over at least
1,000 null sequences per profile, including the 90-day sequences. The other D23 checks are reported in the artifact as separate rows
(G-MDE, G-onset, the standard-error check, G-ETA as redefined in [D64(c)](DECISIONS.md), and G-attr: a routine update's effect must
not be attributed to "you" more than 5% of the time, and a your-side or Desktop-picker effect not to "agent" more than 2%). The
[status table](#status-at-a-glance) says which of them were run on the final decider.

The shipped engine reads the artifact's own flags and never re-judges them ([`calflags.ts`](../engine/src/store/calflags.ts),
[`calibration.test.ts`](../engine/test/store/calibration.test.ts), which also holds the shipped copy equal to the newest artifact). An agent
counts as calibrated only if the artifact is complete, chose an estimator the engine can run, and passed under the voting construct in use.
Anything else is *Timeline only*.

### What the calibration runs so far show

| Artifact | Status | What it is |
|---|---|---|
| [`2026-10-04.json`](calibration/2026-10-04.json) | complete, small (203 sequences, 20 null per profile) | First end-to-end run with the attribution decider. Too few sequences to pass any agent. G-MDE pass, G-onset pass (24 of 24), standard-error check pass, G-ETA fail |
| [`2026-10-05-screen-interim.json`](calibration/2026-10-05-screen-interim.json) | partial | Weak screen of all six candidates under an interim decider with 20 to 30 null sequences each. Removes nobody; `session-t95-cr2` and `two-level-t95-cr2` led on pilot power |
| [`2026-10-05-eta.json`](calibration/2026-10-05-eta.json), [`-eta-d64.json`](calibration/2026-10-05-eta-d64.json) | complete (probes only) | The G-ETA studies behind [section 13](#13-progress-and-why-there-are-no-dates) |
| [`2026-10-05.json`](calibration/2026-10-05.json) | complete; **the artifact the shipped engine reads** | `session-t95-cr2` with the full decider: 1,000 null sequences per profile in 7 profiles (7,000), plus 40 planted doublings per profile (280). 4,060 of the 7,280 sequences were resumed from the cache of an earlier run of the same code ([`REPRODUCE.md`](calibration/REPRODUCE.md)) |

From the 2026-10-05 run (`session-t95-cr2`, `toolErrorsNonCmd` voting, UTC days, 90 daily evaluations per sequence):

- **False alarms: none observed.** 0 false "changed", 0 false "agent" and 0 false "you" in each profile's 1,000 null sequences, for both
  Claude Code (six profiles, 6,000 sequences) and Codex (one profile, 1,000). The Clopper–Pearson 95% upper bound is 0.368% per profile
  (`0.00368`), inside the 6% and 2% limits.
- **What a user whose setup and agent did not change in effect sees,** as days out of every 100 daily evaluations:

  | Profile | Too early to tell | No detectable change |
  |---|---|---|
  | few long sessions | 71 | 29 |
  | few long sessions, high dispersion | 98 | 2 |
  | many short sessions | 20 | 80 |
  | single project | 21 | 79 |
  | multi-project | 19 | 81 |
  | sparse failures | 96 | 4 |
  | Codex | over 99 | under 1 |

  A single indicator moving (*single indicator*, a kind of *Too early to tell*) is under 1% of days in every profile. This is why
  "Too early to tell" is common, on purpose.
- **Power to find a planted doubling** of tool errors and edits without reading first (and a halving of reads) at a version bump, 40 sequences each. *Found*
  means a change was claimed on or after the planted onset; none was claimed early in any profile.

  | Profile | Found | 95% range | Median days from onset to the first claim (found runs only) |
  |---|---|---|---|
  | many short sessions | 35 of 40 | 73 to 96% | 13 |
  | single project | 34 of 40 | 70 to 94% | 13 |
  | multi-project | 39 of 40 | 87 to 100% | 12 |
  | few long sessions | 10 of 40 | 13 to 41% | 28 |
  | few long sessions, high dispersion | 7 of 40 | 7 to 33% | 30 |
  | sparse failures | 10 of 40 | 13 to 41% | 25 |
  | Codex | 9 of 40 | 11 to 38% | 31 |

  A single user with a few very long sessions has little power, and that is a property of the data, not a setting to turn up.
- **Attribution in the planted runs.** Row 5 (a change of unknown origin in the onset window) fired in 3 of the 280 planted runs when
  counted raw and in none once persistence was applied, and in none of them because of a derived (between-session) event. In an earlier,
  partial run of the same decider (since superseded by this one), "you" was claimed in 5 of 280 planted agent-side cases, an upper
  bound of about 4% and inside the 5% limit ([D64](DECISIONS.md)). G-attr itself was not run on the final decider.

### Not measured

- the measured coverage of the printed range;
- G-MDE, the standard-error check and G-attr on the final decider (the 2026-10-05 run sets their sizes to zero; the earlier numbers are in
  [`2026-10-04.json`](calibration/2026-10-04.json)), and the pseudo-count and Holm sensitivity rows;
- the research indicators (reads per edit, edits without reading first) on real logs after the subagent and `relocated` fixes ([D62, D65](DECISIONS.md));
- anything about how often the rules misfire on **real** logs: every number above is from synthetic users.

## 15. Limits of the method

- **One user is a small sample.** The gates are set so wasitme refuses rather than guesses, which means refusing a lot.
- **The indicators are proxies.** They do not measure answer quality, and the "worse" direction is an assumption.
- **Sessions on other machines are not visible.**
- **The 30-day cleanup** of terminal transcripts limits how far back a new install can see; wasitme keeps what it has derived.
- **Hidden delegation** (work moved into subagents) is handled for the research indicators and flagged as a mix move; other indicators
  may still shift when delegation does.
- **Multiple comparisons.** The single-indicator note is Holm-corrected. The `Investigate` and ad hoc comparisons are always labelled exploratory.
- **A synthetic calibration is not the world.** It shows the rules behave as designed under stated assumptions; it cannot show the
  assumptions are right. Real-log checks are counts only and are reported as such ([D61](DECISIONS.md)).

## 16. Where to attack it

Start with [`gates/d23.ts`](../engine/src/analysis/gates/d23.ts), [`stats/`](../engine/src/analysis/stats/), [`attribution/decide.ts`](../engine/src/analysis/attribution/decide.ts)
and the dated artifacts in [`docs/calibration/`](calibration/). The calibration harness is reproducible: [`REPRODUCE.md`](calibration/REPRODUCE.md) has the exact
command, seeds are in each artifact, and every run is single-core. Issues that name a rule, a number and a synthetic reproduction are the most useful kind.
