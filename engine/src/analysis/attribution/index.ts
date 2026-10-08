/**
 * Attribution layer (WP-21, METHOD.md §9–§12): onset, the strata rule-out, the version-boundary test, the
 * decision table, persistence and the `calibrated` flag. Pure, no I/O, no clock reads.
 *
 *   attributeAgent(exchanges, events, opts)  — the whole pipeline (20a → events → evidence → 20b with D53 dims → decide)
 *   decide(input)                            — the decision table + persistence, one pure function (WP-23 wraps it)
 *
 * READINGS this layer had to make where the written rules left a choice (D56 records the main ones; each also stated
 * where it is implemented):
 *  R1  decide's input adds `evidence` (onset, rule-outs, boundary test, D53 dims, observation, persistence data):
 *      these need session-level cells and exchanges, which the 20a evaluation does not carry. `now` is an input.
 *  R2  "Changed" = 20b `changedOf` AND not fragile under the 3-most-influential-days rule. 20b's per-metric
 *      leave-one-session-out flags (`fragileMetrics`) are informational only (trace detail); they do not re-derive
 *      "changed" (D53c) or demote a lone indicator.
 *  R3  Row 2 is checked at the evaluation's selected tier (20a: first ready tier, else the largest with its history
 *      met) — that is "even at the largest tier"; no tier → row 2.
 *  R4  Row 13's "sensitive" also needs df ≥ the floor (D53d: low_df blocks `none`).
 *  R5  Ruled-out you·strong candidates are eliminated; rows 9–11 apply to the remaining candidates.
 *  R6  Prompt-hash events (`system-prompt`) are context, never candidates, unless an admitted tripwire; at a version
 *      bump (agent·routine) they are background like the bump.
 *  R7  Readers emit only intra-session changes, so version/model/effort changes BETWEEN sessions are derived from
 *      Exchange day-majority labels (version → agent·routine; model/effort → unknown·weak unless the latest recorded
 *      event of that kind explains the new value). Mode/entrypoint are not derived (strata and mix flags cover them).
 *  R8  Onset: split day = first "after" day; qualifying needs ≥ 5 session-days per side for every counted metric;
 *      I = hull{Z ≥ max−Δ} ∪ peak±2, then ±1 guard, clipped to the tier span; Δ = 2 provisional (WP-23 G-onset).
 *  R9  Rule-out holds a model/effort/mode/entrypoint dimension at the event's old value; ruled out only when the
 *      restricted run is still "changed" on the same side under the same gates. Other kinds (instructions, mcp,
 *      skills, plugins, hooks, config incl. Codex model_provider) are never ruled out.
 * R10  Version-boundary test: exactly one boundary day in I (version events grouped by new version, earliest day);
 *      pre [b−7, b−1] vs post [b, b+6]; "changed" on the same side; per counted metric ≥ 2 qualifying projects agree
 *      AND ≥ ⅔ agree; every day of pre ∪ post fully observed. Row 9 also needs every day of I fully observed.
 * R11  "Fully observed" is counted over I (the observation scope WP-22 must also use for snapshot.observation, or
 *      `checkSnapshot`'s by_elimination rule can fail). Codex is partial by design. Default input: none observed.
 * R12  Persistence compares (state, reason); "two consecutive evaluations agree" = the anchor (first evaluation
 *      with the new outcome) and a later one with the same outcome ≥ 24 h later in data time, with ≥ 30% new
 *      denominator for EVERY voting metric (days after the anchor's recent window) and ≥ 2 new session-days; any
 *      other outcome in between resets the wait. Row 1 bypasses persistence both ways; `previous = null` shows the
 *      raw outcome; a clock that went backward re-anchors.
 * R13  An undated decisive event (no valid day or time) counts as an `unknown` candidate (less specific, never more).
 * R14  Tripwires (served≠requested, vendor template, cache_miss) are detectors + an admissibility switch, all off by
 *      default; while off their events are context. Any other agent·strong event is context too.
 * R15  D53 is enforced: `decide` throws when the assessment still stratifies on a dimension a you·strong model or
 *      entrypoint candidate in I requires dropping.
 */
export * from "./types.js";
export * from "./events.js";
export * from "./labels.js";
export * from "./tripwires.js";
export * from "./onset.js";
export * from "./evidence.js";
export * from "./decide.js";
export * from "./pipeline.js";
