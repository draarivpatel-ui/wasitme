/**
 * Estimator candidates (D29 + research/08 #1). Each is an `AnalysisMethod` the engine can run; the harness runs the
 * bootstrap-based ones through the analytic fast path (`estimator: "analytic"`, the closed-form SE of METHOD.md §6, checked
 * against the bootstrap by secheck.ts) and the wild cluster bootstrap as itself.
 *
 *   d23-literal          session-day clusters, 99% t, K/(K−1)          (D23's named method; D29's first candidate)
 *   session-day-t99-cr2  session-day clusters, 99% t, CR2 (Bell–McCaffrey)
 *   session-t95-cr2      session clusters, 95% t, CR2                  (the stats branch's default)
 *   two-level-t95-cr2    session → day two-level, 95% t, CR2
 *   wcb-session-t99      session clusters, null-imposed studentized wild cluster bootstrap, Webb weights, 99%
 *   wcb-session-t95      the same at 95%
 * All keep the larger-SE rule of METHOD.md §6 (with ≥ 5 sessions in each window, also the other scheme; keep the larger SE).
 */
import { D29_CANDIDATES, type AnalysisMethod } from "../gates/d23.js";
import type { Candidate } from "./sequence.js";

const analytic = (m: Readonly<AnalysisMethod>): AnalysisMethod => ({ ...m, estimator: "analytic" });

export const CANDIDATES: readonly Candidate[] = Object.freeze([
  { id: "d23-literal", method: analytic(D29_CANDIDATES["d23-literal"]!) },
  { id: "session-day-t99-cr2", method: analytic(D29_CANDIDATES["session-day-t99-cr2"]!) },
  { id: "session-t95-cr2", method: analytic(D29_CANDIDATES["session-t95-cr2"]!) },
  { id: "two-level-t95-cr2", method: analytic(D29_CANDIDATES["two-level-t95-cr2"]!) },
  { id: "wcb-session-t99", method: { id: "wcb-session-t99", clusters: "session", twoLevel: false, level: 0.99, smallSample: "count", keepLargerSe: true, estimator: "wild" } },
  { id: "wcb-session-t95", method: { id: "wcb-session-t95", clusters: "session", twoLevel: false, level: 0.95, smallSample: "count", keepLargerSe: true, estimator: "wild" } },
]);

export function candidateOf(id: string): Candidate {
  const c = CANDIDATES.find((x) => x.id === id);
  if (!c) throw new RangeError(`unknown candidate ${id}`);
  return c;
}

/** The production form of a candidate's method (the estimator the product would run). */
export function productionMethod(c: Candidate): AnalysisMethod {
  const { estimator, ...rest } = c.method;
  return estimator === "wild" ? { ...rest, estimator } : rest;
}

/** Sensitivity variants of a method (research/08 #5, #6). */
export function withPseudo(c: Candidate, pseudo: number): Candidate {
  return { id: `${c.id}+pseudo${pseudo}`, method: { ...c.method, id: `${c.method.id}+pseudo${pseudo}`, pseudo } };
}

export function withHolmMde(c: Candidate, metrics = 3): Candidate {
  const alpha = (1 - c.method.level) / metrics;
  return { id: `${c.id}+holmMde`, method: { ...c.method, id: `${c.method.id}+holmMde`, mdeAlpha: alpha } };
}
