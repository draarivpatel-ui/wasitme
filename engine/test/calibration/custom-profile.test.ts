/**
 * WP-24a G0 helper: a sequence spec may carry an unregistered (custom) profile, e.g. one matched to real
 * counts. Synthetic data only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSequence, profileOf, specProfile, type Profile } from "../../src/analysis/calibration/index.js";

test("a custom profile equal to a registered one gives the identical sequence", () => {
  const plain = generateSequence({ profile: "few-long", seed: "g0-custom|1" });
  const custom = generateSequence({ profile: "few-long", seed: "g0-custom|1", custom: { ...profileOf("few-long") } });
  assert.equal(custom.exchanges.length, plain.exchanges.length);
  assert.deepEqual(custom.exchanges.map((x) => x.id), plain.exchanges.map((x) => x.id));
  assert.deepEqual(custom.exchanges.map((x) => x.toolErrors), plain.exchanges.map((x) => x.toolErrors));
});

test("a custom profile's volume and rates are the ones used", () => {
  const base = profileOf("few-long");
  const sparse: Profile = { ...base, exchangesPerDay: 2, rates: { toolError: 0.2 } };
  const spec = { profile: "few-long" as const, seed: "g0-custom|2", custom: sparse };
  assert.equal(specProfile(spec), sparse);
  const dense = generateSequence({ profile: "few-long", seed: "g0-custom|2" });
  const seq = generateSequence(spec);
  assert.ok(seq.exchanges.length < dense.exchanges.length / 3, "far fewer exchanges at 2/day than at 14/day");
  const rate = (xs: typeof seq.exchanges) => xs.reduce((a, x) => a + x.toolErrors, 0) / Math.max(1, xs.reduce((a, x) => a + x.toolCalls, 0));
  assert.ok(rate(seq.exchanges) > 2 * rate(dense.exchanges), "the custom tool-error rate shows in the exchanges");
});

test("a custom Codex profile generates Codex exchanges", () => {
  const seq = generateSequence({ profile: "codex", seed: "g0-custom|3", custom: { ...profileOf("codex"), exchangesPerDay: 1.5, noise: { codexExecPerDay: 0.5 } } });
  assert.ok(seq.exchanges.length > 0);
  assert.ok(seq.exchanges.every((x) => x.agent === "codex"));
});
