# Reproduce the 2026-10-05 calibration run

[`2026-10-05.json`](2026-10-05.json) is the artifact the shipped engine reads. It was written by
[`engine/scripts/calibration-run.mjs`](../../engine/scripts/calibration-run.mjs) at the commit recorded in its `commit` field, with the seed
in `runSeed`. Everything in it comes from synthetic logs; the harness reads no real log, configuration or path.

The `commit` field, here and in the other dated files in this folder, names a commit in the pre-publication development
history, which the public repository does not contain. The public repository starts from a later state of the same code,
which includes analysis changes made after this run (for example [D70](../DECISIONS.md)); a run from it repeats the
method, so compare the numbers as described below.

A full run from scratch uses one core at background priority and takes about four hours. It writes to a temporary folder, never over the
committed artifact. The cache keeps finished sequences, so re-running the same command after an interruption continues where it stopped
(the cache recomputes if the analysis or synthesis code changed since).

```sh
cd engine && ../scripts/dev/heavy.sh npm run build
mkdir -p "${TMPDIR:-/tmp}/wasitme-calibration"
WASITME_HEAVY_LANE=long ../scripts/dev/heavy.sh env \
  WASITME_CAL23="full" WASITME_CAL_ATTR="0" WASITME_CAL_CACHE="${TMPDIR:-/tmp}/wasitme-calibration/repro.cache.jsonl" \
  WASITME_CAL_CANDIDATES="session-t95-cr2" WASITME_CAL_DECIDER="wp21" WASITME_CAL_EFFECT="40" \
  WASITME_CAL_EFFECT_PILOT="40" WASITME_CAL_EFFECT_SIZES="2" WASITME_CAL_ETA="0" WASITME_CAL_MDE="0" \
  WASITME_CAL_NOTE="Reproduction of 2026-10-05: 1,000 null sequences per profile + 40 planted x2 per profile." \
  WASITME_CAL_NULL="1000" WASITME_CAL_NULL_PILOT="1000" WASITME_CAL_OUT="${TMPDIR:-/tmp}/wasitme-calibration/repro.json" \
  WASITME_CAL_SE="0" WASITME_CAL_SENS_EFFECT="0" WASITME_CAL_SENS_NULL="0" \
  node scripts/calibration-run.mjs >> "${TMPDIR:-/tmp}/wasitme-calibration/repro.log" 2>&1
```

The committed artifact was produced with `WASITME_CAL_MAX_WORKERS=4` (four workers) and part of its cache from an earlier run of the same
code: `runtime.sequencesFromCache` is 4,060 of 7,280. Each sequence has its own fixed seed, so the worker count is meant to change only the
time; compare the numbers below rather than expecting a byte-identical file.

Then compare `gNullSeq` (the null rates) and `power` / `effectRows` (the planted runs) with the committed file. The artifact's own `resume`
field holds the exact command it was produced with.
