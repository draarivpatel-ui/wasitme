/**
 * The null scenarios: version bumps every ~3 days with NO planted effect. The planted parameters (base
 * rates, user shape, volume, per-session effects) must be recoverable from simple counts of the files,
 * and the version boundaries must not move any rate beyond noise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayString } from "../src/synth/params.js";
import { BASE_RATES } from "../src/synth/params.js";
import {
  METRICS, clusterRatio, corpusOnDisk, diffRows, pooledRate, referenceRows, windowAssign, zScore, type Corpus,
} from "../src/synth/testkit.js";
import { weekday } from "../src/synth/params.js";

const DENSE = ["toolError", "toolCalls", "outTok", "thinkDepth"];
const SPARSE = ["interrupt", "pushback", "blindEdit"];

async function check(name: string, run: (c: Corpus, ref: Awaited<ReturnType<typeof referenceRows>>) => void): Promise<void> {
  const c = corpusOnDisk(name);
  try {
    const ref = await referenceRows(c.dir);
    assert.deepEqual(diffRows(c.rows, ref), [], "planted facts are exactly recoverable from the files");
    run(c, ref);
  } finally {
    c.cleanup();
  }
}

function commonNullAssertions(c: Corpus, ref: Awaited<ReturnType<typeof referenceRows>>): void {
  const t = c.truth;
  assert.equal(t.events.filter((e) => e.effect).length, 0, "no event carries an effect");
  assert.ok(t.events.length >= 12, `version bumps are generated (${t.events.length})`);
  assert.ok(t.events.every((e) => e.auto && e.kind === "version" && e.side === "agent"));
  assert.ok(t.segments.every((s) => Object.keys(s.factors).length === 0), "every segment has the base rates");

  // Bumps arrive every ~3 days (2..4).
  const days = t.events.map((e) => e.day);
  for (let i = 1; i < days.length; i++) {
    const gap = days[i]! - days[i - 1]!;
    assert.ok(gap >= 2 && gap <= 4, `bump gap ${gap}`);
  }

  // No change at a version boundary beyond noise: dense metrics tightly, sparse ones against gross bias.
  const bumps = t.events.map((e) => dayString(t.startDay, e.day));
  for (const m of [...DENSE, ...SPARSE]) {
    const est = clusterRatio(ref, METRICS[m]!, windowAssign(bumps, 3));
    const z = zScore(est);
    const limit = DENSE.includes(m) ? 4 : 5;
    assert.ok(Math.abs(z) < limit, `${m}: ratio ${est.ratio.toFixed(2)} z ${z.toFixed(1)} across ${bumps.length} version bumps`);
  }
}

function baseRates(ref: Awaited<ReturnType<typeof referenceRows>>): void {
  const near = (name: string, got: number, planted: number, lo = 0.6, hi = 1.6): void => {
    assert.ok(got >= planted * lo && got <= planted * hi, `${name}: counted ${got.toFixed(4)} vs planted ${planted} (allowed ${lo}x..${hi}x)`);
  };
  near("interrupt", pooledRate(ref, METRICS.interrupt!), BASE_RATES.interrupt);
  near("pushback", pooledRate(ref, METRICS.pushback!), BASE_RATES.pushback);
  near("toolError per call", pooledRate(ref, METRICS.toolError!), BASE_RATES.toolError, 0.7, 1.4);
  near("rejection per call", pooledRate(ref, (r) => [r.rejections, r.toolCalls]), BASE_RATES.rejection, 0.7, 1.7);
  near("blocked per call", pooledRate(ref, (r) => [r.blocked, r.toolCalls]), BASE_RATES.blocked, 0.5, 1.8);
  // Churn runs are non-blind by construction, which pulls the pooled rate a little under the planted per-edit rate.
  near("blind per edit", pooledRate(ref, METRICS.blindEdit!), BASE_RATES.blindEdit, 0.6, 1.25);
  near("thinking blocks per step", pooledRate(ref, (r) => [r.thinkBlocks ?? 0, r.steps]), BASE_RATES.thinkProb, 0.85, 1.15);
  near("redacted share", pooledRate(ref, (r) => [r.thinkRedacted ?? 0, r.thinkBlocks ?? 0]), BASE_RATES.thinkRedacted, 0.85, 1.15);
  // mean of 500 * lognormal(1, .35) (x1.06) with a mild per-session effect (x1.03)
  near("thinking depth", pooledRate(ref, METRICS.thinkDepth!), BASE_RATES.thinkDepth * 1.09, 0.85, 1.15);
  near("queued per exchange", pooledRate(ref, (r) => [r.queuedMidTurn, 1]), BASE_RATES.queued, 0.6, 1.6);
}

function weekdayVolume(c: Corpus, planted: number): number {
  const perDay = new Map<string, number>();
  for (const r of c.rows) perDay.set(r.day, (perDay.get(r.day) ?? 0) + 1);
  let sum = 0;
  let n = 0;
  for (let d = 0; d < c.truth.days; d++) {
    const dow = weekday(c.truth.startDay, d);
    if (dow === 0 || dow === 6) continue;
    sum += perDay.get(dayString(c.truth.startDay, d)) ?? 0;
    n++;
  }
  assert.ok(sum / n > planted * 0.75 && sum / n < planted * 1.2, `weekday volume ${(sum / n).toFixed(1)} vs planted ${planted}`);
  return sum / n;
}

test("null-few-long: few very long sessions, no effects anywhere", async () => {
  await check("null-few-long", (c, ref) => {
    commonNullAssertions(c, ref);
    baseRates(ref);
    weekdayVolume(c, 14);
    const bySession = new Map<string, { n: number; days: Set<string> }>();
    for (const r of c.rows) {
      const s = bySession.get(r.session) ?? { n: 0, days: new Set() };
      s.n++;
      s.days.add(r.day);
      bySession.set(r.session, s);
    }
    const sizes = [...bySession.values()].map((s) => s.n).sort((a, b) => a - b);
    assert.ok(bySession.size >= 8 && bySession.size <= 40, `${bySession.size} sessions`);
    assert.ok(sizes[sizes.length >> 1]! >= 20, `median exchanges per session ${sizes[sizes.length >> 1]}`);
    assert.ok([...bySession.values()].filter((s) => s.days.size >= 3).length >= 5, "long sessions span several days");
    assert.ok(c.rows.every((r) => r.entrypoint === "claude-desktop"), "desktop-app user");
  });
});

test("null-many-short: many short sessions, no effects anywhere", async () => {
  await check("null-many-short", (c, ref) => {
    commonNullAssertions(c, ref);
    baseRates(ref);
    weekdayVolume(c, 16);
    const bySession = new Map<string, { n: number; days: Set<string> }>();
    for (const r of c.rows) {
      const s = bySession.get(r.session) ?? { n: 0, days: new Set() };
      s.n++;
      s.days.add(r.day);
      bySession.set(r.session, s);
    }
    const sizes = [...bySession.values()].map((s) => s.n).sort((a, b) => a - b);
    assert.ok(bySession.size >= 150, `${bySession.size} sessions`);
    assert.ok(sizes[sizes.length >> 1]! <= 3, `median exchanges per session ${sizes[sizes.length >> 1]}`);
    assert.ok([...bySession.values()].every((s) => s.days.size === 1), "short sessions stay within a day");
    assert.ok(c.rows.every((r) => r.entrypoint === "cli"));
  });
});
