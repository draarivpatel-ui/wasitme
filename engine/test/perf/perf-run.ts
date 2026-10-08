#!/usr/bin/env node
/**
 * One measured scan, in its own process (spawned by perf.ts, optionally under `node --permission`).
 *   node perf-run.js '<json options>'
 * Options: { home, userHome, claude, codex, tz, now?, calibrated? }. Prints one JSON line: wall time since process
 * start, the scan's own time and phase timings, peak RSS, and counts. Synthetic data only (the paths are the harness's
 * temp corpus). `calibrated` injects a TEST-ONLY calibration artifact (both agents passed); without it the scan uses the
 * shipped artifact (D69: both agents calibrated as well). The line reports each agent's calibrated flag and state.
 */
import { priorDiskReads } from "../../src/readers/claude/priors.js";
import { runScan } from "../../src/store/scan.js";

interface RunOptions { home: string; userHome: string; claude: string; codex: string; tz: string; now?: string; calibrated?: boolean }

const TEST_ONLY_CALIBRATION = {
  formatVersion: 1, kind: "wasitme-calibration", synthetic: true, status: "complete", date: "2026-10-01",
  selection: { chosen: "session-t95-cr2" },
  calibrated: {
    "claude-code": { calibrated: true, byConstruct: { toolErrorsNonCmd: true } },
    codex: { calibrated: true, byConstruct: { toolErrorsNonCmd: true } },
  },
  gNullSeq: [],
};

async function main(): Promise<void> {
  const o = JSON.parse(process.argv[2] ?? "{}") as RunOptions;
  process.env.WASITME_CLAUDE_DIR = o.claude;
  process.env.WASITME_CODEX_DIR = o.codex;
  const r = await runScan({
    home: o.home,
    userHome: o.userHome,
    env: { WASITME_CLAUDE_DIR: o.claude, WASITME_CODEX_DIR: o.codex },
    timeZone: o.tz,
    recordPermission: false,
    ...(o.now ? { now: new Date(o.now) } : {}),
    ...(o.calibrated ? { calibration: TEST_ONLY_CALIBRATION } : {}),
  });
  const exchanges = (r.snapshot?.agents ?? []).reduce((n, a) => n + a.n.exchanges, 0);
  // Eligible metrics in the tier each evaluation uses (from the in-memory attribution: a timeline-only snapshot
  // carries no metrics). 0 when the outputs were re-stamped.
  const eligible = (r.attributions ?? []).reduce((n, a) => {
    const ev = a.evaluation;
    const tier = ev.tiers.find((t) => t.tier === (ev.selectedTier ?? ev.progress.tier));
    return n + (tier ? tier.metrics.filter((m) => m.eligible).length : 0);
  }, 0);
  process.stdout.write(`${JSON.stringify({
    wallMs: performance.now(),
    scanMs: r.ms,
    timings: r.timings,
    maxRssMB: process.resourceUsage().maxRSS / 1024,
    sources: r.sources, parsed: r.parsed, unchanged: r.unchanged, reused: r.reused, busy: r.busy,
    exchanges,
    sandbox: r.snapshot?.health.sandbox ?? null,
    eligible,
    states: (r.snapshot?.agents ?? []).map((a) => `${a.agent}:${a.state}:${a.reason ?? ""}`),
    calibrated: (r.snapshot?.calibration.agents ?? []).map((c) => `${c.agent}:${c.calibrated ? "calibrated" : "not calibrated"}`),
    priorReads: priorDiskReads(),
  })}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`perf-run: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
