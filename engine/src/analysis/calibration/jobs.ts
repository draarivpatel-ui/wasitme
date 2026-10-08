/**
 * Units of harness work, runnable in-process or in a worker thread (structured-clone-safe in and out).
 *
 * Deciders are referenced by registry id (`DECIDERS`), never by a module path: the engine's no-network tripwire
 * rejects dynamic imports, and a registry keeps the plug-in point static. WP-21 adds its decider to `DECIDERS`.
 */
import type { AnalysisMethod } from "../gates/d23.js";
import type { ToolErrorVariant } from "../metrics/defs.js";
import { interimDecider, type Decider } from "./decider.js";
import { attributionDecider } from "./wp21.js";
import { etaCheck, mdeProbes, seProbes, type EtaProbe, type EtaSilence, type MdeProbe, type SeProbe } from "./probes.js";
import { runSequence, type Candidate, type SequenceResult } from "./sequence.js";
import type { SequenceSpec } from "./synth.js";

/**
 * Decider registry (WASITME_CAL_DECIDER). "wp21" is the real decision layer (attribution/attributeAgent, wp21.ts);
 * "interim" the pre-WP-21 rows 1-4 / 12-14 stand-in. Variants carry their knobs in their id.
 */
export const DECIDERS: Readonly<Record<string, Decider>> = Object.freeze({
  interim: interimDecider,
  wp21: attributionDecider(),
  /** The same decider on raw exchanges (the reference the label-row fast path is tested against). */
  "wp21-raw": attributionDecider({ rows: false }),
  "wp21-observed-none": attributionDecider({ fullyObserved: "none" }),
});

export function deciderOf(id: string): Decider {
  const d = DECIDERS[id];
  if (!d) throw new RangeError(`unknown decider ${id} (registered: ${Object.keys(DECIDERS).join(", ")})`);
  return d;
}

export type Job =
  | { kind: "seq"; group: string; specs: SequenceSpec[]; candidates: Candidate[]; decider: string; errorsVotes?: ToolErrorVariant[] }
  | { kind: "mde"; group: string; specs: SequenceSpec[]; candidate: Candidate; errorsVote: ToolErrorVariant }
  | { kind: "eta"; group: string; specs: SequenceSpec[]; candidate: Candidate; errorsVote: ToolErrorVariant }
  | { kind: "se"; group: string; specs: SequenceSpec[]; methods: AnalysisMethod[] };

export type JobResult =
  | { kind: "seq"; group: string; results: SequenceResult[]; ms: number }
  | { kind: "mde"; group: string; probes: MdeProbe[]; ms: number }
  | { kind: "eta"; group: string; probes: EtaProbe[]; silence: EtaSilence[]; ms: number }
  | { kind: "se"; group: string; probes: SeProbe[]; ms: number };

export function runJob(job: Job): JobResult {
  const t0 = performance.now();
  switch (job.kind) {
    case "seq": {
      const decider = deciderOf(job.decider);
      const results = job.specs.map((s) => runSequence(s, { candidates: job.candidates, decider, ...(job.errorsVotes ? { errorsVotes: job.errorsVotes } : {}) }));
      return { kind: "seq", group: job.group, results, ms: performance.now() - t0 };
    }
    case "mde":
      return { kind: "mde", group: job.group, probes: job.specs.flatMap((s) => mdeProbes(s, job.candidate, job.errorsVote)), ms: performance.now() - t0 };
    case "eta": {
      const checks = job.specs.map((s) => etaCheck(s, job.candidate, job.errorsVote));
      return { kind: "eta", group: job.group, probes: checks.flatMap((c) => c.probes), silence: checks.map((c) => c.silence), ms: performance.now() - t0 };
    }
    case "se":
      return { kind: "se", group: job.group, probes: job.specs.flatMap((s) => seProbes(s, job.methods)), ms: performance.now() - t0 };
  }
}
