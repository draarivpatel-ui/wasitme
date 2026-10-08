/**
 * Calibration tests: the recommended interval method must not cry wolf on synthetic users with no
 * change (false-positive rate ≤ 6% at a nominal 5%), for both user shapes plus the medium shape that
 * separates CR2 from K/(K−1), and must still catch real changes. Fast settings run by default (≈15 s);
 * the full table runs only with WASITME_CALIBRATION=full (minutes — run it through scripts/dev/heavy.sh).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calibrate, FEW_LONG_SESSIONS, formatCalibration, INTERRUPT_RATE, MANY_SHORT_SESSIONS, MEDIUM_SESSIONS,
  simulateWindows, STEPS_PER_PROMPT, TOOL_ERROR_RATE, wilson,
  type CalibrationResult, type MethodId, type MetricShape, type UserShape,
} from "../../src/analysis/stats/calibrate.js";
import { RECOMMENDED_METHOD } from "../../src/analysis/stats/compare.js";
import { Rng } from "../../src/analysis/stats/rng.js";

const RECOMMENDED: MethodId = "session/t95:cr2";
const FULL = process.env.WASITME_CALIBRATION === "full";

test("the recommended method id matches compare.ts's default", () => {
  assert.equal(RECOMMENDED_METHOD.clusters, "session");
  assert.equal(RECOMMENDED_METHOD.twoLevel, false);
  assert.equal(RECOMMENDED_METHOD.interval, "t95");
  assert.equal(RECOMMENDED_METHOD.smallSample, "cr2");
});

test("simulated users have the intended shapes and are deterministic", () => {
  const spans = (shape: UserShape) => {
    const w = simulateWindows(shape, STEPS_PER_PROMPT, 1, new Rng("shape"));
    const days = new Map<string, Set<string>>();
    for (const c of [...w.recent, ...w.baseline]) {
      if (!days.has(c.session)) days.set(c.session, new Set());
      days.get(c.session)!.add(c.day);
    }
    const inBoth = [...new Set(w.recent.map((c) => c.session))].filter((s) => w.baseline.some((c) => c.session === s)).length;
    const perSession = [...days.values()].map((d) => d.size);
    return { sessions: days.size, meanDays: perSession.reduce((a, b) => a + b, 0) / perSession.length, inBoth };
  };
  const few = spans(FEW_LONG_SESSIONS), many = spans(MANY_SHORT_SESSIONS);
  assert.ok(few.sessions < 40 && few.meanDays > 3 && few.inBoth >= 1, JSON.stringify(few));
  assert.ok(many.sessions > 150 && many.meanDays < 1.3, JSON.stringify(many));
  assert.deepEqual(
    simulateWindows(MEDIUM_SESSIONS, TOOL_ERROR_RATE, 1, new Rng("d")),
    simulateWindows(MEDIUM_SESSIONS, TOOL_ERROR_RATE, 1, new Rng("d")),
  );
  // Every cell is well-formed: proportions never exceed their denominator.
  const w = simulateWindows(MANY_SHORT_SESSIONS, TOOL_ERROR_RATE, 3, new Rng("x"));
  assert.ok([...w.recent, ...w.baseline].every((c) => c.num >= 0 && c.den > 0 && c.num <= c.den && /^\d{4}-\d{2}-\d{2}$/.test(c.day)));
});

test("an injected multiplier shows up in the recent window's pooled rate", () => {
  const rng = new Rng("mult");
  let rec = 0, base = 0;
  for (let i = 0; i < 40; i++) {
    const w = simulateWindows(MANY_SHORT_SESSIONS, STEPS_PER_PROMPT, 2, rng);
    const rate = (cs: typeof w.recent) => cs.reduce((a, c) => a + c.num, 0) / cs.reduce((a, c) => a + c.den, 0);
    rec += rate(w.recent);
    base += rate(w.baseline);
  }
  const ratio = rec / base;
  assert.ok(ratio > 1.8 && ratio < 2.2, String(ratio));
});

test("Wilson interval", () => {
  const [lo, hi] = wilson(50, 1000);
  assert.ok(Math.abs(lo - 0.0381) < 5e-4 && Math.abs(hi - 0.0653) < 5e-4, `${lo} ${hi}`);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

interface Scenario {
  shape: UserShape;
  metric: MetricShape;
  /**
   * A method that must be miscalibrated (> 6%) on this cell, in the same paired run — shows the cell
   * actually distinguishes the recommended method from it.
   */
  contrast?: MethodId;
}

const SCENARIOS: Scenario[] = [
  { shape: FEW_LONG_SESSIONS, metric: TOOL_ERROR_RATE },
  { shape: FEW_LONG_SESSIONS, metric: STEPS_PER_PROMPT },
  { shape: MANY_SHORT_SESSIONS, metric: TOOL_ERROR_RATE },
  { shape: MANY_SHORT_SESSIONS, metric: STEPS_PER_PROMPT },
  // Rare events (≈4% of prompts): the Poisson/binomial floor and CR2 must hold here too.
  { shape: MANY_SHORT_SESSIONS, metric: INTERRUPT_RATE },
  // The cell that justified CR2 over the spec's K/(K−1) rule: unequal session sizes with a moderate
  // number of sessions. If CR2 regressed to K/(K−1) behaviour, this cell would exceed 6%.
  { shape: MEDIUM_SESSIONS, metric: STEPS_PER_PROMPT, contrast: "session/t95:count" },
];

test("recommended method: false-positive rate ≤ 6% for every user shape (3000 null users each)", () => {
  for (const { shape, metric, contrast } of SCENARIOS) {
    const methods: MethodId[] = contrast ? [RECOMMENDED, contrast] : [RECOMMENDED];
    const r = calibrate({ shape, metric, nullSims: 3000, sims: 0, resamples: 400, methods, seed: "fpr-test" });
    const row = (m: MethodId) => r.rows.find((x) => x.method === m)!;
    const cell = `${shape.name}/${metric.name}`;
    assert.ok(r.nullCounted >= 2500, `${cell}: only ${r.nullCounted} users passed the gate`);
    assert.ok(row(RECOMMENDED).falsePositiveRate <= 0.06, `${cell}: false-positive rate ${row(RECOMMENDED).falsePositiveRate}`);
    if (contrast) {
      // Paired (same replicates): only the small-sample correction differs. Miscalibrated beyond simulation noise.
      const c = row(contrast);
      assert.ok(c.falsePositiveRate > 0.06 && c.falsePositiveCi[0] > 0.05, `${cell}: ${contrast} ${c.falsePositiveRate} ${c.falsePositiveCi}`);
    }
  }
});

test("the harness has teeth: plain percentile intervals on session-days are miscalibrated for long sessions", () => {
  const r = calibrate({
    shape: FEW_LONG_SESSIONS, metric: STEPS_PER_PROMPT, nullSims: 600, sims: 0, resamples: 400,
    methods: ["day/pct95", "session/pct95", RECOMMENDED], seed: "teeth",
  });
  const fpr = (m: MethodId) => r.rows.find((x) => x.method === m)!.falsePositiveRate;
  assert.ok(fpr("day/pct95") > 0.12, `day/pct95 ${fpr("day/pct95")}`);
  assert.ok(fpr(RECOMMENDED) < fpr("session/pct95"));
});

test("recommended method still detects real changes", () => {
  const r = calibrate({
    shape: MANY_SHORT_SESSIONS, metric: STEPS_PER_PROMPT, multipliers: [0.5, 1.5], nullSims: 100, sims: 300,
    resamples: 400, methods: [RECOMMENDED], seed: "power",
  });
  const row = r.rows[0]!;
  assert.ok(row.power["1.5"]! >= 0.85, `×1.5 power ${row.power["1.5"]}`);
  assert.ok(row.power["0.5"]! >= 0.95, `×0.5 power ${row.power["0.5"]}`);
  assert.equal(row.wrongDirection, 0);
  const few = calibrate({
    shape: FEW_LONG_SESSIONS, metric: TOOL_ERROR_RATE, multipliers: [3], nullSims: 100, sims: 300,
    resamples: 400, methods: [RECOMMENDED], seed: "power-few",
  });
  assert.ok(few.rows[0]!.power["3"]! >= 0.6, `few-long ×3 power ${few.rows[0]!.power["3"]}`);
});

test("formatCalibration renders a markdown table", () => {
  const r = calibrate({ shape: MEDIUM_SESSIONS, metric: STEPS_PER_PROMPT, multipliers: [2], nullSims: 20, sims: 20, resamples: 100, methods: [RECOMMENDED, "perm/session"], seed: "fmt" });
  const md = formatCalibration([r]);
  assert.match(md, /### medium × steps/);
  assert.match(md, /\| session\/t95:cr2 \| \d+\.\d%/);
  assert.match(md, /power ×2/);
});

test("full calibration table (WASITME_CALIBRATION=full)", { skip: !FULL && "set WASITME_CALIBRATION=full" }, () => {
  const methods: MethodId[] = [
    "session/pct95", "session/t95:count", "session/t95:cr2", "session/t99:cr2",
    "day/pct95", "day/t95:cr2", "day/t99:count", "day/t99:cr2",
    "two-level/pct95", "two-level/t95:count", "two-level/t95:cr2",
    "perm/session", "perm/day",
  ];
  const results: CalibrationResult[] = [];
  for (const shape of [FEW_LONG_SESSIONS, MEDIUM_SESSIONS, MANY_SHORT_SESSIONS]) {
    for (const metric of [TOOL_ERROR_RATE, INTERRUPT_RATE, STEPS_PER_PROMPT]) {
      results.push(calibrate({
        shape, metric, methods, multipliers: [0.5, 0.667, 1.5, 2], nullSims: 2000, sims: 400,
        resamples: 1000, mdcCheck: true, seed: "full-table",
      }));
    }
  }
  console.log(formatCalibration(results));
  for (const r of results) {
    const row = r.rows.find((x) => x.method === RECOMMENDED)!;
    assert.ok(row.falsePositiveRate <= 0.06, `${r.shape}/${r.metric}: ${row.falsePositiveRate}`);
  }
});
