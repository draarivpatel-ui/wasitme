/**
 * The real decider: WP-21's `attributeAgent` (onset, strata rule-out, version-boundary test, the decision
 * table of METHOD.md §11, persistence) wrapped as a harness `Decider`.
 *
 * `attributeAgent` runs the whole pipeline from exchanges (20a evaluation → derived label events → evidence → 20b with
 * the D53 dims → decide), so it plugs in through `decideDay` (the pipeline form) rather than `decide`. Per day the
 * harness gives it the RAW synthetic exchanges and the recorded events dated before today — raw, not session-day rows,
 * because label derivation counts exchanges per day (Codex keeps a session's start version, so day majorities can
 * differ between exchange and session-day counts). It applies persistence itself (`previous`, data-time `now`), so
 * its displayed state is the glance.
 *
 * Knobs (recorded in the decider id): onset.delta (METHOD.md §10; WP-23 G-onset owns the value), fully observed days, the
 * tripwires (off: METHOD.md §9) and persistence. Fully observed days default to "since install": the user installs wasitme on
 * the first evaluation day, so plan days ≥ PRE_DAYS are fully observed for Claude (snapshots + SessionStart hooks) and
 * the 30 replayed pre-install days are not; Codex is partially observed by design whatever this says.
 *
 * D56 diagnostics: how often row 5 (`unclear (unknown_provenance)`) fires, and whether its `unknown` candidates are
 * all events DERIVED from Exchange labels (`derived: true`) rather than recorded ones.
 */
import { attributeAgent, type DecideOptions, type Decision, type OnsetOptions } from "../attribution/index.js";
import { G0_FALLBACK_ERRORS_VOTE } from "../gates/evaluate.js";
import { dayString } from "../stats/ratio.js";
import { EVALUATED_EXTRA } from "./day.js";
import type { Decider, DeciderOutput, PipelineDayInput, PipelineDayOutput } from "./decider.js";
import { planDayIndex, PRE_DAYS } from "./synth.js";

export interface AttributionKnobs {
  onset?: Partial<OnsetOptions>;
  /** "since_install" (default): plan days ≥ PRE_DAYS; "none": nothing fully observed; "all": every day. */
  fullyObserved?: "since_install" | "none" | "all";
  decide?: DecideOptions;
  /** Evaluate only the metrics the decision reads (voting + the tool-error variants; default true). */
  votingMetricsOnly?: boolean;
  /** Label rows instead of raw exchanges (default true; see the file header). */
  rows?: boolean;
}

/** Exchanges a pipeline input stands for: a label row's `n`, else 1. */
export const rowWeight = (x: object): number => {
  const n = (x as { n?: unknown }).n;
  return typeof n === "number" ? n : 1;
};

const INSTALL_IDX = planDayIndex(PRE_DAYS);

function observedDays(mode: AttributionKnobs["fullyObserved"], todayIdx: number): string[] {
  if (mode === "none") return [];
  const from = mode === "all" ? planDayIndex(0) : INSTALL_IDX;
  const out: string[] = [];
  for (let d = from; d < todayIdx; d++) out.push(dayString(d));
  return out;
}

export function attributionDecider(knobs: AttributionKnobs = {}): Decider {
  const fully = knobs.fullyObserved ?? "since_install";
  const tag = [
    `onset.delta=${knobs.onset?.delta ?? "default(2)"}`,
    `fullyObserved=${fully}`,
    `tripwires=${knobs.decide?.tripwires ? JSON.stringify(knobs.decide.tripwires) : "off"}`,
    `persistence=${knobs.decide?.persistence === false ? "off" : "on"}`,
    `input=${knobs.rows === false ? "exchanges" : "label-rows"}`,
  ].join(", ");
  return {
    id: `wp21-attributeAgent (${tag})`,
    persists: knobs.decide?.persistence !== false,
    errorsVotes: [G0_FALLBACK_ERRORS_VOTE],
    rows: knobs.rows !== false,
    decideDay(input: PipelineDayInput): PipelineDayOutput {
      const todayIdx = planDayIndexOf(input.today);
      const a = attributeAgent(input.exchanges, input.events, {
        agent: input.agent,
        now: new Date(input.now),
        timeZone: "UTC",
        errorsVote: input.errorsVote,
        method: input.method,
        ...(knobs.votingMetricsOnly === false ? {} : { metrics: EVALUATED_EXTRA }),
        calibrated: input.calibrated,
        exchangeWeight: rowWeight,
        previous: (input.previous?.raw as Decision | undefined) ?? null,
        fullyObservedDays: observedDays(fully, todayIdx),
        ...(knobs.onset ? { onset: knobs.onset } : {}),
        ...(knobs.decide ? { decide: knobs.decide } : {}),
      });
      const d = a.decision;
      const derived = new Set(a.events.filter((e) => e.derived === true).map((e) => e.id));
      const unknownIn = (cands: Decision["candidates"]) => cands.filter((c) => c.class === "unknown");
      const rawUnknown = unknownIn(d.raw.candidates), shownUnknown = unknownIn(d.candidates);
      const output: DeciderOutput = {
        state: d.state,
        reason: d.reason,
        row: d.raw.row,
        changed: d.raw.row >= 4 && d.raw.row <= 11,
        pending: d.pending,
        raw: d,
        onset: d.raw.onset ? { from: d.raw.onset.from, to: d.raw.onset.to } : null,
        metric: d.singleIndicator?.metric ?? null,
        diag: {
          rawRow5: d.raw.row === 5,
          rawRow5DerivedOnly: d.raw.row === 5 && rawUnknown.length > 0 && rawUnknown.every((c) => derived.has(c.event)),
          rawRow5AnyDerived: d.raw.row === 5 && rawUnknown.some((c) => derived.has(c.event)),
          shownRow5: d.row === 5,
          shownRow5DerivedOnly: d.row === 5 && shownUnknown.length > 0 && shownUnknown.every((c) => derived.has(c.event)),
          derivedEvents: derived.size,
        },
      };
      return { output, evaluation: a.evaluation };
    },
  };
}

function planDayIndexOf(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}
