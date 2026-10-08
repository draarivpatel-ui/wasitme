/**
 * The calibration run (WP-23; METHOD.md §14 gates: null sequences, G-MDE, G-onset, G-attr; D23, D29): phases, worker pool,
 * aggregation and the dated artifact. Synthetic data only — the harness never reads a log, a config dir or the clock
 * (the runner script adds the date and the commit to the artifact it writes).
 *
 * Phases
 *  1. Pilot: every candidate on `nullPilot` null and `effectPilot` planted-regression sequences per profile (and per
 *     effect size).
 *  2. Screen + extend: a candidate whose pilot false-"changed" Clopper–Pearson LOWER bound already exceeds 6% on a
 *     Claude profile is out. Survivors are extended to `nullFull` null sequences per profile in order of pilot power
 *     (most powerful first); the first one whose false-"changed" CP upper bound is ≤ 6% on every Claude profile under
 *     both voting tool-error constructs is chosen — by construction the most powerful passing candidate (to within the
 *     pilot's power ranking, which the artifact reports). Its planted-regression runs are extended to `effectFull`.
 *  3. The chosen candidate: G-MDE probes, ETA probes, the analytic-vs-bootstrap SE check, the pseudo-count and Holm-MDE
 *     sensitivity runs, and the G-attr scenarios.
 * Flags: `calibrated` per agent = the chosen candidate passes that agent's profiles with ≥ `minNullForPass` null
 * sequences under the voting construct in force (D47(d): toolErrorsNonCmd). Codex is judged on its own profile only.
 */
import { Worker } from "node:worker_threads";
import { CANDIDATES, candidateOf, productionMethod, withHolmMde, withPseudo } from "./candidates.js";
import { deciderOf, runJob, type Job, type JobResult } from "./jobs.js";
import { MAX_FALSE_CHANGED, MIN_NULL_SEQUENCES, nullRow, powerRow, proportion, type NullRow, type PowerRow, type Proportion } from "./gates.js";
import { ERRORS_VOTES } from "./day.js";
import { INITIAL_GLANCE, PERSIST_NEW_SESSION_DAYS, PERSIST_NEW_SHARE } from "./persistence.js";
import { ATTR_NOT_EXPRESSIBLE, ATTR_SCENARIOS, attrSpec, effectSpec, nullSpec, ONSET_PLAN_DAY, regression } from "./scenarios.js";
import { EVAL_DAYS, PLAN_DAYS, PRE_DAYS, PROFILES, START_DAY, type ProfileId } from "./synth.js";
import type { EtaProbe, EtaSilence, MdeProbe, SeProbe } from "./probes.js";
import type { Candidate, SequenceResult } from "./sequence.js";
import { TIERS } from "../metrics/windows.js";
import { DEFAULT_MDC_OPTIMISM } from "../stats/mdc.js";

export interface RunConfig {
  mode: "smoke" | "full" | "custom";
  runSeed: string;
  /** Worker threads (0 = in-process). */
  workers: number;
  /** Sequences per job. */
  batch: number;
  candidates: string[];
  profiles: ProfileId[];
  nullPilot: number;
  nullFull: number;
  effectSizes: number[];
  effectPilot: number;
  effectFull: number;
  /** A candidate passes only with at least this many null sequences per profile (D23: 1,000). */
  minNullForPass: number;
  sensitivityNull: number;
  sensitivityEffect: number;
  attrPerScenario: number;
  mdeSequences: number;
  etaSequences: number;
  seSequences: number;
  decider: string;
  log?: (line: string) => void;
  /** Called with the artifact as it stands after each phase (status "pilot" / "extended" / …), so a stopped run keeps its results. */
  onCheckpoint?: (partial: CalibrationArtifact) => void;
  /** Extra notes recorded in the artifact (e.g. why a run is reduced). */
  notes?: string[];
  /**
   * Stop starting new jobs once this many seconds have passed since the run started (D58: runs are budgeted). Jobs in
   * flight finish; the remaining phases are skipped and the artifact's status says "partial". Absent: no limit.
   */
  deadlineSeconds?: number;
  /**
   * Finished sequences by key (`sequenceCacheKey`): results found here are not recomputed, and every newly finished one
   * is put. The runner script backs it with a JSONL file, so re-running the same command resumes a stopped run. The
   * caller keys the store by code version (a result is only valid for the code that produced it).
   */
  cache?: SequenceCache;
}

/** Finished sequence results, keyed by `sequenceCacheKey` (synthetic aggregates only). */
export interface SequenceCache {
  get(key: string): SequenceResult | undefined;
  put(key: string, result: SequenceResult): void;
}

/** A sequence's cache key: decider, result group, the candidates it was run under and its seed. */
export function sequenceCacheKey(decider: string, group: string, candidates: readonly Candidate[], seed: string): string {
  return [decider, group, candidates.map((c) => c.id).join("+"), seed].join("\u001f");
}

export const SMOKE_CONFIG: RunConfig = Object.freeze({
  mode: "smoke",
  runSeed: "wp23-smoke",
  workers: 0,
  batch: 2,
  candidates: ["d23-literal", "session-t95-cr2"],
  profiles: PROFILES.map((p) => p.id),
  nullPilot: 4,
  nullFull: 5,
  effectSizes: [2],
  effectPilot: 2,
  effectFull: 2,
  minNullForPass: 1,
  sensitivityNull: 1,
  sensitivityEffect: 0,
  attrPerScenario: 1,
  mdeSequences: 1,
  etaSequences: 1,
  seSequences: 1,
  decider: "interim",
}) as RunConfig;

export const FULL_CONFIG: RunConfig = Object.freeze({
  mode: "full",
  runSeed: "wp23-2026-10-04",
  // One worker thread: calibration runs on a shared machine that must stay responsive; never more than 2.
  workers: 1,
  batch: 4,
  candidates: CANDIDATES.map((c) => c.id),
  profiles: PROFILES.map((p) => p.id),
  nullPilot: 150,
  nullFull: MIN_NULL_SEQUENCES,
  effectSizes: [1.5, 2],
  effectPilot: 60,
  effectFull: 150,
  minNullForPass: MIN_NULL_SEQUENCES,
  sensitivityNull: 250,
  sensitivityEffect: 60,
  attrPerScenario: 60,
  mdeSequences: 60,
  etaSequences: 60,
  seSequences: 40,
  decider: "interim",
}) as RunConfig;

// ───────────────────────────── worker pool ─────────────────────────────

export class JobPool {
  private workers: Worker[] = [];
  constructor(private size: number) {}

  /** Runs the jobs in order; once `stop()` is true no new job starts (those in flight finish). Returns the jobs finished. */
  async run(jobs: readonly Job[], onResult: (r: JobResult, done: number, total: number) => void, stop: () => boolean = () => false): Promise<number> {
    if (this.size <= 0) {
      let done = 0;
      for (const j of jobs) {
        if (stop()) break;
        onResult(runJob(j), ++done, jobs.length);
      }
      return done;
    }
    while (this.workers.length < this.size) this.workers.push(new Worker(new URL("./worker.js", import.meta.url)));
    let next = 0, done = 0, inFlight = 0;
    await new Promise<void>((resolve, reject) => {
      const feed = (w: Worker) => {
        if (next >= jobs.length || stop()) {
          if (inFlight === 0) resolve();
          return;
        }
        const id = next++;
        inFlight++;
        w.once("message", (msg: { id: number; result?: JobResult; error?: string }) => {
          inFlight--;
          if (msg.error !== undefined) return reject(new Error(`calibration job ${id} failed: ${msg.error}`));
          done++;
          onResult(msg.result!, done, jobs.length);
          feed(w);
        });
        w.postMessage({ id, job: jobs[id] });
      };
      for (const w of this.workers) feed(w);
    });
    return done;
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
  }
}

// ───────────────────────────── artifact types ─────────────────────────────

export interface CandidateSummary {
  id: string;
  method: Candidate["method"];
  /** What the product would run for this candidate (the bootstrap for D29's rows; the WCB itself). */
  production: Candidate["method"];
  pilotPowerClaude: number;
  screenedOut: boolean;
  extended: boolean;
  passesClaude: Record<string, boolean | null>;
  passesCodex: Record<string, boolean | null>;
}

export interface CalibrationArtifact {
  formatVersion: 1;
  kind: "wasitme-calibration";
  synthetic: true;
  mode: RunConfig["mode"];
  /** "complete", or the last finished phase of a run still going (checkpoints). */
  status: string;
  runSeed: string;
  decider: string;
  layout: Record<string, unknown>;
  persistence: Record<string, unknown>;
  profiles: { id: string; agent: string; description: string }[];
  candidates: CandidateSummary[];
  gNullSeq: NullRow[];
  power: PowerRow[];
  selection: {
    chosen: string | null;
    criterion: string;
    why: string;
    ranking: { candidate: string; pilotPowerClaude: number; fullPass: boolean | null }[];
    /** The candidate phase 3 probed: the chosen one, else the most powerful survivor (provisional, no flags). */
    probed: string | null;
  };
  calibrated: Record<string, { calibrated: boolean; byConstruct: Record<string, boolean>; profiles: string[]; falseAgentGate: "not_exercised" | "insufficient_sequences" | "pass" | "fail" }>;
  /** Planted-regression groups: raw row shares and decider diagnostics (e.g. D56's row 5 when a change is real). */
  effectRows: { profile: string; candidate: string; errorsVote: string; effect: string; sequences: number; rowDayShare: Record<string, number>; diag: NullRow["diag"] }[];
  gMde: Record<string, unknown>;
  eta: Record<string, unknown>;
  seCheck: Record<string, unknown>;
  sensitivity: Record<string, unknown>;
  gOnset: Record<string, unknown>;
  gAttr: Record<string, unknown>;
  runtime: { seconds: number; workers: number; sequences: number; probes: number; phases: { phase: string; seconds: number; jobs: number }[]; deadlineSeconds?: number; sequencesFromCache?: number };
  notes: string[];
}

// ───────────────────────────── helpers ─────────────────────────────

const CLAUDE = (cfg: RunConfig) => cfg.profiles.filter((p) => PROFILES.find((x) => x.id === p)!.agent === "claude-code");
const CODEX = (cfg: RunConfig) => cfg.profiles.filter((p) => PROFILES.find((x) => x.id === p)!.agent === "codex");
const r4 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);

function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += Math.max(1, n)) out.push(xs.slice(i, i + Math.max(1, n)));
  return out;
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Results store keyed by group ("null|<profile>", "effect<m>|<profile>", "attr|<scenario>"), seed-deduplicated. */
class Store {
  private by = new Map<string, Map<string, SequenceResult>>();
  add(group: string, rs: readonly SequenceResult[]): void {
    let g = this.by.get(group);
    if (!g) this.by.set(group, (g = new Map()));
    for (const r of rs) {
      const prev = g.get(r.seed);
      if (prev) prev.tracks.push(...r.tracks.filter((t) => !prev.tracks.some((p) => p.candidate === t.candidate && p.errorsVote === t.errorsVote)));
      else g.set(r.seed, { ...r, tracks: [...r.tracks] });
    }
  }
  /** Results of a group that have tracks for `candidate`, in seed order. */
  get(group: string, candidate?: string): SequenceResult[] {
    const g = [...(this.by.get(group)?.values() ?? [])].sort((a, b) => (a.seed < b.seed ? -1 : 1));
    return candidate === undefined ? g : g.filter((r) => r.tracks.some((t) => t.candidate === candidate)).map((r) => ({ ...r, tracks: r.tracks.filter((t) => t.candidate === candidate) }));
  }
  count(): number {
    let n = 0;
    for (const g of this.by.values()) n += g.size;
    return n;
  }
}

// ───────────────────────────── the run ─────────────────────────────

export async function runCalibration(cfg: RunConfig): Promise<CalibrationArtifact> {
  const log = cfg.log ?? (() => {});
  const t0 = performance.now();
  const decider = deciderOf(cfg.decider);
  /** The voting tool-error constructs this decider is judged under (WP-21: the D47(d) fallback only). */
  const votes = decider.errorsVotes ?? ERRORS_VOTES;
  const pool = new JobPool(cfg.workers);
  const store = new Store();
  const phases: CalibrationArtifact["runtime"]["phases"] = [];
  let probesCount = 0;
  const mde: MdeProbe[] = [], eta: EtaProbe[] = [], se: SeProbe[] = [];
  const silence: EtaSilence[] = [];

  const deadline = cfg.deadlineSeconds !== undefined && cfg.deadlineSeconds > 0 ? t0 + cfg.deadlineSeconds * 1000 : Infinity;
  const pastDeadline = () => performance.now() >= deadline;
  /** Set when the deadline stopped a phase: later phases are skipped, the artifact is partial. */
  let stoppedIn: string | null = null;
  let cachedSequences = 0;

  const exec = async (phase: string, jobs0: Job[]): Promise<void> => {
    if (stoppedIn !== null) {
      log(`[${new Date().toISOString()}] phase ${phase}: skipped (deadline reached in ${stoppedIn})`);
      phases.push({ phase: `${phase} (skipped: deadline)`, seconds: 0, jobs: 0 });
      return;
    }
    // Sequences already in the cache are taken from it; a job keeps only its uncached specs.
    const jobs: Job[] = [];
    let fromCache = 0;
    for (const j of jobs0) {
      if (j.kind !== "seq" || !cfg.cache) {
        jobs.push(j);
        continue;
      }
      const todo: typeof j.specs = [];
      const hits: SequenceResult[] = [];
      for (const spec of j.specs) {
        const hit = cfg.cache.get(sequenceCacheKey(j.decider, j.group, j.candidates, spec.seed));
        if (hit) hits.push(hit);
        else todo.push(spec);
      }
      if (hits.length) store.add(j.group, hits);
      fromCache += hits.length;
      if (todo.length) jobs.push({ ...j, specs: todo });
    }
    cachedSequences += fromCache;
    const p0 = performance.now();
    let lastLog = 0;
    log(`[${new Date().toISOString()}] phase ${phase}: ${jobs.length} jobs${fromCache ? ` (${fromCache} sequences from the cache)` : ""}`);
    const finished = await pool.run(jobs, (r, done, total) => {
      if (r.kind === "seq") {
        store.add(r.group, r.results);
        const job = jobs.find((j) => j.kind === "seq" && j.group === r.group && j.specs.some((x) => x.seed === r.results[0]?.seed));
        if (cfg.cache && job && job.kind === "seq") for (const res of r.results) cfg.cache.put(sequenceCacheKey(job.decider, r.group, job.candidates, res.seed), res);
      } else if (r.kind === "mde") mde.push(...r.probes);
      else if (r.kind === "eta") {
        eta.push(...r.probes);
        silence.push(...r.silence);
      }
      else se.push(...r.probes);
      if (r.kind !== "seq") probesCount += r.probes.length;
      const now = performance.now();
      if (done === total || now - lastLog > 15_000) {
        lastLog = now;
        const el = (now - p0) / 1000;
        log(`[${new Date().toISOString()}] ${phase}: ${done}/${total} jobs, ${el.toFixed(0)} s, eta ${((el / done) * (total - done)).toFixed(0)} s, total ${((now - t0) / 1000).toFixed(0)} s`);
      }
    }, pastDeadline);
    if (finished < jobs.length) {
      stoppedIn = phase;
      log(`[${new Date().toISOString()}] phase ${phase}: deadline reached after ${finished}/${jobs.length} jobs`);
    }
    phases.push({ phase: finished < jobs.length ? `${phase} (stopped by the deadline: ${finished}/${jobs.length} jobs)` : phase, seconds: Math.round((performance.now() - p0) / 100) / 10, jobs: finished });
  };

  const seqJobs = (group: string, specs: ReturnType<typeof nullSpec>[], candidates: Candidate[]): Job[] =>
    chunk(specs, cfg.batch).map((s) => ({ kind: "seq", group, specs: s, candidates, decider: cfg.decider }));
  const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
  /** Round-robin merge of job lists, so a run stopped early has covered every profile (and effect size) evenly. */
  const interleave = (lists: Job[][]): Job[] => {
    const out: Job[] = [];
    for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]!);
    return out;
  };
  const nullLists = (cands: Candidate[], from: number, to: number) =>
    cfg.profiles.map((p) => seqJobs(`null|${p}`, range(from, to).map((i) => nullSpec(cfg.runSeed, p, i)), cands));
  const effectLists = (cands: Candidate[], from: number, to: number) =>
    cfg.effectSizes.flatMap((m) => cfg.profiles.map((p) => seqJobs(`effect${m}|${p}`, range(from, to).map((i) => effectSpec(cfg.runSeed, p, i, m)), cands)));
  const nullJobs = (cands: Candidate[], from: number, to: number) => interleave(nullLists(cands, from, to));
  const effectJobs = (cands: Candidate[], from: number, to: number) => interleave(effectLists(cands, from, to));

  try {
    // ── Phase 1: pilot, every candidate.
    const all = cfg.candidates.map(candidateOf);
    await exec("pilot", interleave([...nullLists(all, 0, cfg.nullPilot), ...effectLists(all, 0, cfg.effectPilot)]));

    const rowsFor = (c: string, v: string, profiles: readonly string[]) =>
      profiles.map((p) => nullRow(store.get(`null|${p}`, c), c, v, decider !== deciderOf("interim")));
    const powerOf = (c: string, profiles: readonly string[], v = votes[0]!) => {
      const xs = profiles.flatMap((p) => cfg.effectSizes.map((m) => powerRow(store.get(`effect${m}|${p}`, c), c, v, `x${m}`).detected.rate));
      const ok = xs.filter((x) => Number.isFinite(x));
      return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 0;
    };
    const passOn = (c: string, v: string, profiles: readonly string[]): boolean | null => {
      if (profiles.length === 0) return null;
      const rows = rowsFor(c, v, profiles);
      return rows.every((r) => r.sequences >= cfg.minNullForPass && r.passFalseChanged && r.passFalseAgent !== false);
    };

    const summaries = new Map<string, CandidateSummary>();
    for (const c of all) {
      const screenedOut = votes.some((v) => rowsFor(c.id, v, CLAUDE(cfg)).some((r) => r.falseChanged.lo > MAX_FALSE_CHANGED));
      summaries.set(c.id, {
        id: c.id, method: c.method, production: productionMethod(c), pilotPowerClaude: r4(powerOf(c.id, CLAUDE(cfg))),
        screenedOut, extended: false, passesClaude: {}, passesCodex: {},
      });
    }
    log(`pilot: ${[...summaries.values()].map((s) => `${s.id} power ${s.pilotPowerClaude}${s.screenedOut ? " (screened out)" : ""}`).join("; ")}`);
    cfg.onCheckpoint?.(assembleArtifact({
      cfg, votes, status: "pilot", decider, store, summaries, order: [], chosen: null, criterion: "", probed: null, passOn, fullPass: () => false,
      gMde: {}, etaOut: {}, sens: {}, attr: {}, onset: {}, se, t0, probesCount, phases, cachedSequences,
    }));

    // ── Phase 2: extend survivors, most powerful first, until one passes.
    const order = [...summaries.values()].filter((s) => !s.screenedOut).sort((a, b) => b.pilotPowerClaude - a.pilotPowerClaude || a.id.localeCompare(b.id));
    let chosen: string | null = null;
    let criterion = votes.length > 1
      ? "false 'changed' CP upper bound <= 6% on every Claude profile under both voting tool-error constructs"
      : `false 'changed' CP upper bound <= 6% on every Claude profile under ${votes[0]} (the construct the decider is judged under)`;
    const fullPass = (id: string) => votes.every((v) => passOn(id, v, CLAUDE(cfg)) === true);
    // With fewer null sequences than the gate needs nothing can pass: only the most powerful survivor is extended
    // (provisional) instead of every survivor.
    const canPass = cfg.nullFull >= cfg.minNullForPass;
    for (const s of order) {
      if (cfg.nullFull > cfg.nullPilot) await exec(`extend ${s.id}`, nullJobs([candidateOf(s.id)], cfg.nullPilot, cfg.nullFull));
      s.extended = true;
      if (fullPass(s.id)) {
        chosen = s.id;
        break;
      }
      log(`extend ${s.id}: ${canPass ? "fails the gate" : `cannot pass with ${cfg.nullFull} < ${cfg.minNullForPass} null sequences per profile (provisional)`}`);
      if (!canPass) break;
    }
    if (chosen === null) {
      // Fallback: the D47(d) construct alone.
      const alt = order.find((s) => s.extended && passOn(s.id, votes[0]!, CLAUDE(cfg)) === true);
      if (alt) {
        chosen = alt.id;
        criterion = `false 'changed' CP upper bound <= 6% on every Claude profile under ${votes[0]} only (no candidate passed under both constructs)`;
      }
    }
    for (const s of summaries.values()) {
      for (const v of votes) {
        s.passesClaude[v] = s.extended ? passOn(s.id, v, CLAUDE(cfg)) : null;
        s.passesCodex[v] = s.extended ? passOn(s.id, v, CODEX(cfg)) : null;
      }
    }
    log(`chosen: ${chosen ?? "none"}`);

    // ── Phase 3: the chosen candidate (or, when none passes, the most powerful survivor, marked provisional — its
    // probes still show what fails; no flag is set from it).
    const probed = chosen ?? order[0]?.id ?? null;
    const gMde: Record<string, unknown> = {}, etaOut: Record<string, unknown> = {}, sens: Record<string, unknown> = {}, attr: Record<string, unknown> = {};
    let onset: Record<string, unknown> = {};
    let sensitivitySize = { nullPerProfile: cfg.sensitivityNull, effectPerProfile: cfg.sensitivityEffect };
    const assemble = (status: string): CalibrationArtifact => assembleArtifact({
      cfg, votes, status, decider, store, summaries, order, chosen, criterion, probed, passOn, fullPass,
      gMde, etaOut, sens, attr, onset, se, t0, probesCount, phases, cachedSequences,
    });
    cfg.onCheckpoint?.(assemble("extended"));
    if (probed !== null) {
      const c = candidateOf(probed);
      if (cfg.effectFull > cfg.effectPilot) await exec(`power ${probed}`, effectJobs([c], cfg.effectPilot, cfg.effectFull));
      const variants = [withPseudo(c, 0.25), withPseudo(c, 1), withHolmMde(c)];
      const probeJobs: Job[] = [];
      for (const p of cfg.profiles) {
        for (const ch of chunk(range(0, cfg.mdeSequences).map((i) => ({ profile: p, seed: `${cfg.runSeed}|mde|${p}|${i}` })), cfg.batch)) {
          probeJobs.push({ kind: "mde", group: `mde|${p}`, specs: ch, candidate: c, errorsVote: votes[0]! });
        }
        for (const ch of chunk(range(0, cfg.etaSequences).map((i) => ({ profile: p, seed: `${cfg.runSeed}|eta|${p}|${i}` })), cfg.batch)) {
          probeJobs.push({ kind: "eta", group: `eta|${p}`, specs: ch, candidate: c, errorsVote: votes[0]! });
        }
        for (const ch of chunk(range(0, cfg.seSequences).map((i) => ({ profile: p, seed: `${cfg.runSeed}|se|${p}|${i}` })), cfg.batch)) {
          probeJobs.push({ kind: "se", group: `se|${p}`, specs: ch, methods: CANDIDATES.filter((x) => x.method.estimator === "analytic").map((x) => x.method) });
        }
      }
      const attrJobs: Job[] = ATTR_SCENARIOS.flatMap((sc) =>
        seqJobs(`attr|${sc.id}`, range(0, cfg.attrPerScenario).map((i) => attrSpec(cfg.runSeed, cfg.profiles[i % cfg.profiles.length]!, i, sc)), [c]),
      );
      // The wild bootstrap costs ~4x an analytic candidate per sequence: its sensitivity runs use half the sequences.
      const scale = c.method.estimator === "wild" ? 0.5 : 1;
      sensitivitySize = { nullPerProfile: Math.ceil(cfg.sensitivityNull * scale), effectPerProfile: Math.ceil(cfg.sensitivityEffect * scale) };
      await exec("chosen: probes, sensitivity, G-attr", [
        ...probeJobs,
        ...nullJobs(variants, 0, sensitivitySize.nullPerProfile),
        ...effectJobs(variants, 0, sensitivitySize.effectPerProfile),
        ...attrJobs,
      ]);
      Object.assign(gMde, summariseMde(mde, cfg));
      Object.assign(etaOut, summariseEta(eta, silence, cfg));
      Object.assign(sens, summariseSensitivity(store, cfg, c, variants, decider !== deciderOf("interim")), { sequences: sensitivitySize });
      Object.assign(attr, summariseAttr(store, cfg, probed));
      onset = summariseOnset(store, cfg, probed);
    }
    void assemble;

    return assemble(stoppedIn === null ? "complete" : `partial: the ${cfg.deadlineSeconds} s deadline stopped phase "${stoppedIn}"; later phases skipped`);
  } finally {
    await pool.close();
  }
}

interface AssembleInput {
  cfg: RunConfig;
  votes?: readonly string[];
  status: string;
  decider: ReturnType<typeof deciderOf>;
  store: Store;
  summaries: Map<string, CandidateSummary>;
  order: CandidateSummary[];
  chosen: string | null;
  criterion: string;
  probed: string | null;
  passOn: (c: string, v: string, profiles: readonly string[]) => boolean | null;
  fullPass: (id: string) => boolean;
  gMde: Record<string, unknown>;
  etaOut: Record<string, unknown>;
  sens: Record<string, unknown>;
  attr: Record<string, unknown>;
  onset: Record<string, unknown>;
  se: readonly SeProbe[];
  t0: number;
  probesCount: number;
  phases: CalibrationArtifact["runtime"]["phases"];
  cachedSequences?: number;
}

function assembleArtifact(a: AssembleInput): CalibrationArtifact {
  const { cfg, decider, store, summaries, order, chosen, criterion, probed, passOn, fullPass } = a;
  const interim = decider === deciderOf("interim");
  const votes = a.votes ?? ERRORS_VOTES;
  const gNullSeq: NullRow[] = [];
  const power: PowerRow[] = [];
  const effectRows: { profile: string; candidate: string; errorsVote: string; effect: string; sequences: number; rowDayShare: Record<string, number>; diag: NullRow["diag"] }[] = [];
  for (const s of summaries.values()) {
    for (const p of cfg.profiles) {
      for (const v of votes) {
        const rs = store.get(`null|${p}`, s.id);
        if (rs.length) gNullSeq.push(nullRow(rs, s.id, v, !interim));
        for (const m of cfg.effectSizes) {
          const es = store.get(`effect${m}|${p}`, s.id);
          if (!es.length) continue;
          power.push(powerRow(es, s.id, v, `x${m}`));
          const er = nullRow(es, s.id, v, !interim);
          effectRows.push({ profile: p, candidate: s.id, errorsVote: v, effect: `x${m}`, sequences: er.sequences, rowDayShare: er.rowDayShare, diag: er.diag });
        }
      }
    }
  }
  const calibrated: CalibrationArtifact["calibrated"] = {};
  for (const [agent, profiles] of [["claude-code", CLAUDE(cfg)], ["codex", CODEX(cfg)]] as const) {
    if (profiles.length === 0) continue;
    const by: Record<string, boolean> = {};
    for (const v of votes) by[v] = chosen !== null && passOn(chosen, v, profiles) === true;
    const judged = probed ?? chosen;
    const agentRows = judged === null ? [] : profiles.flatMap((p) => votes.map((v) => nullRow(store.get(`null|${p}`, judged), judged, v, true)));
    calibrated[agent] = {
      calibrated: by[votes[0]!]!,
      byConstruct: by,
      profiles: [...profiles],
      falseAgentGate: interim
        ? "not_exercised"
        : agentRows.length === 0 || agentRows.some((r) => r.sequences < cfg.minNullForPass)
          ? "insufficient_sequences"
          : agentRows.every((r) => r.passFalseAgent === true) ? "pass" : "fail",
    };
  }
  const ranking = order.map((s) => ({ candidate: s.id, pilotPowerClaude: s.pilotPowerClaude, fullPass: s.extended ? fullPass(s.id) : null }));
  const why = chosen === null
    ? cfg.nullFull < cfg.minNullForPass
      ? `No candidate can pass: the gate needs >= ${cfg.minNullForPass} null sequences per profile and this run has ${cfg.nullFull}. ${probed ?? "-"} (highest pilot power) was probed provisionally; no flag is set.`
      : "No candidate passed the false-'changed' gate with the required number of null sequences."
    : `${chosen} had the highest pilot power (mean detection of the planted regressions over the Claude profiles and effect sizes, ${votes[0]}) among the candidates that pass: ${criterion}.`;
  return {
    formatVersion: 1,
    kind: "wasitme-calibration",
    synthetic: true,
    mode: cfg.mode,
    status: a.status,
    runSeed: cfg.runSeed,
    decider: decider.id,
    layout: {
      startDay: START_DAY, preDays: PRE_DAYS, evalDays: EVAL_DAYS, planDays: PLAN_DAYS,
      evaluation: "daily, today = plan day preDays+1 … preDays+evalDays (today's data excluded), UTC",
      tierFirstEvalDay: Object.fromEntries(TIERS.map((t) => [String(t.tier), t.historyDays - PRE_DAYS])),
      plantedOnsetPlanDay: ONSET_PLAN_DAY, plantedOnsetFirstEvalDay: ONSET_PLAN_DAY + 1 - PRE_DAYS,
      plantedRegression: Object.fromEntries(cfg.effectSizes.map((m) => [`x${m}`, regression(m)])),
      nullBackground: "no-effect version bumps every ~3 days (synth); a no-effect you·strong effort change (p 0.5) and a no-effect unknown·weak model change (p 0.3) at random evaluation days",
      estimatorInSimulation: "analytic sandwich for the bootstrap-based candidates (METHOD.md §6); the wild cluster bootstrap runs as itself",
      mdeOptimism: DEFAULT_MDC_OPTIMISM,
      sizes: {
        nullPilot: cfg.nullPilot, nullFull: cfg.nullFull, minNullForPass: cfg.minNullForPass, effectPilot: cfg.effectPilot, effectFull: cfg.effectFull,
        effectSizes: cfg.effectSizes, sensitivityNull: cfg.sensitivityNull, sensitivityEffect: cfg.sensitivityEffect, attrPerScenario: cfg.attrPerScenario,
        mdeSequences: cfg.mdeSequences, etaSequences: cfg.etaSequences, seSequences: cfg.seSequences,
      },
    },
    persistence: {
      rule: "METHOD.md §12 Persistence",
      initial: INITIAL_GLANCE,
      key: "state + reason",
      newDenominatorShare: PERSIST_NEW_SHARE,
      newSessionDays: PERSIST_NEW_SESSION_DAYS,
      denominator: "the voting tool-error construct's denominator (tool calls that ran), selected tier's recent window (tier 1's when none)",
      newData: "days [max(t1, second window's first day), t2-1]",
      disagreeing: "a different key resets the pending change; an agreeing evaluation without enough new data keeps the first one pending",
    },
    profiles: cfg.profiles.map((id) => {
      const p = PROFILES.find((x) => x.id === id)!;
      return { id, agent: p.agent, description: p.description };
    }),
    candidates: [...summaries.values()],
    gNullSeq,
    power,
    effectRows,
    selection: { chosen, criterion, why, ranking, probed },
    calibrated,
    gMde: a.gMde,
    eta: a.etaOut,
    seCheck: summariseSe(a.se),
    sensitivity: a.sens,
    gOnset: a.onset,
    gAttr: a.attr,
    runtime: {
      seconds: Math.round((performance.now() - a.t0) / 100) / 10, workers: cfg.workers, sequences: store.count(), probes: a.probesCount, phases: [...a.phases],
      ...(cfg.deadlineSeconds !== undefined ? { deadlineSeconds: cfg.deadlineSeconds } : {}),
      ...(a.cachedSequences ? { sequencesFromCache: a.cachedSequences } : {}),
    },
    notes: [
      "Synthetic data only (src/synth); no real log, config or path is read or written.",
      "false 'changed': share of null sequences whose PERSISTED glance claimed a change (rows 4-11) on any of the 90 daily evaluations; CP = two-sided 95% Clopper-Pearson interval, gate on its upper end.",
      interim
        ? "The interim decider has no attribution: false 'agent' / 'you' are 0 by construction and are reported as not exercised, never as a pass. WP-21 must re-run the harness with its decider (DECIDERS registry) before the flags cover attribution."
        : "Decider supplied through the DECIDERS registry.",
      "Power: planted regression (tool errors and blind edits x m, read weight / m) on a version bump at plan day 75; detected = the persisted glance claims a change on or after the onset.",
      ...(cfg.notes ?? []),
    ],
  };
}

// ───────────────────────────── summaries ─────────────────────────────

function summariseMde(probes: readonly MdeProbe[], cfg: RunConfig): Record<string, unknown> {
  const rows: Record<string, unknown>[] = [];
  for (const p of cfg.profiles) {
    for (const metric of ["toolErrorsNonCmd", "readsPerEdit", "blindEdits"]) {
      const xs = probes.filter((x) => x.profile === p && x.metric === metric);
      if (xs.length === 0) continue;
      const det = proportion(xs.filter((x) => x.detected).length, xs.length);
      const realisedRatio = xs.filter((x) => x.realised !== null && x.realised > 0).map((x) => Math.log(x.realised!) / Math.log(x.factor));
      rows.push({
        profile: p, metric, probes: xs.length, detected: det, material: proportion(xs.filter((x) => x.material).length, xs.length),
        medianMde: r4(median(xs.map((x) => x.mde)) ?? NaN),
        /** Median ln(realised) / ln(planted): 1 = the planted factor moved the metric fully. */
        medianRealisedShare: r4(median(realisedRatio) ?? NaN),
        inBand: det.rate >= 0.6 && det.rate <= 0.95,
      });
    }
  }
  const all = proportion(probes.filter((x) => x.detected).length, probes.length);
  const direct = probes.filter((x) => x.metric !== "readsPerEdit");
  return {
    rule: "G-MDE: an effect planted at the reported MDE is detected 60-95% of the time (detected = range excludes 1x in the planted direction)",
    rows,
    overall: all,
    overallDirectRateMetrics: proportion(direct.filter((x) => x.detected).length, direct.length),
    pass: probes.length > 0 && all.rate >= 0.6 && all.rate <= 0.95,
    note: "readsPerEdit is planted through the read weight, which the planner damps (a read precedes most edits); medianRealisedShare shows how much of the factor reached the metric, so its row understates detection at the true MDE.",
  };
}

/** D64(c) G-ETA band and gate, over SHOWN dates only. */
export const G_ETA = Object.freeze({ band: 0.3, maxMedianRelError: 0.3, minWithinBand: 0.8 });

function summariseEta(probes: readonly EtaProbe[], silence: readonly EtaSilence[], cfg: RunConfig): Record<string, unknown> {
  const sum = (xs: readonly EtaSilence[], f: (q: EtaSilence) => number) => xs.reduce((a, q) => a + f(q), 0);
  const per = (xs: readonly EtaProbe[], quiet: readonly EtaSilence[]) => {
    const known = xs.filter((x) => !x.censored);
    const rel = known.map((x) => (x.actualDays === null ? Infinity : Math.abs(x.actualDays - x.etaDays) / x.etaDays));
    const within = proportion(rel.filter((r) => r <= G_ETA.band).length, known.length);
    const med = median(rel.map((r) => (Number.isFinite(r) ? r : 10)));
    const projected = sum(quiet, (q) => q.projectedDays), shown = sum(quiet, (q) => q.shownDays);
    const days = sum(quiet, (q) => q.days);
    return {
      sequences: quiet.length,
      shownAnchors: xs.length,
      censored: xs.length - known.length,
      neverReady: known.filter((x) => x.actualDays === null).length,
      withinPlusMinus30: within,
      medianAbsRelError: med === null ? null : r4(med),
      medianSignedRelError: r4(median(known.filter((x) => x.actualDays !== null).map((x) => (x.actualDays! - x.etaDays) / x.etaDays)) ?? NaN),
      /** null: no scored shown date (nothing to judge — never read as a pass). */
      pass: known.length === 0 ? null : med !== null && med <= G_ETA.maxMedianRelError && within.rate !== null && within.rate >= G_ETA.minWithinBand,
      suppression: {
        projectedDays: projected,
        shownDays: shown,
        share: proportion(projected - shown, projected),
        byReason: {
          unstable: sum(quiet, (q) => q.withheld.unstable),
          dominant_session: sum(quiet, (q) => q.withheld.dominant_session),
          no_measured_anchor: sum(quiet, (q) => q.withheld.no_measured_anchor),
        },
      },
      notAtCurrentPace: {
        projectedDays: sum(quiet, (q) => q.notAtPaceProjected),
        shownDays: sum(quiet, (q) => q.notAtPaceShown),
        days,
        readyWithin30Days: proportion(sum(quiet, (q) => q.readyWithin30), days),
      },
    };
  };
  const byProfile: Record<string, ReturnType<typeof per>> = {};
  for (const p of cfg.profiles) byProfile[p] = per(probes.filter((x) => x.profile === p), silence.filter((x) => x.profile === p));
  const scored = Object.entries(byProfile).filter(([, r]) => r.pass !== null);
  return {
    rule: "G-ETA (D64(c)), over SHOWN dates only: the evaluation runs daily under the D64 rule (ready = gate + sensitivity held on 2 consecutive daily evaluations; a date is shown only when the projection is stable - same tier, target dates within +/-20% of the remaining days on 3 consecutive evaluations - and its largest-session share is < 0.35; Codex only with a measured anchor). Every 10th evaluation day from the first shown date (not ready) is an anchor; the outcome is the first later held-ready evaluation. Per profile with a scored anchor: median |relative error| <= 0.30 (a never-ready anchor counts as error 10) AND >= 80% within +/-30%. suppression.share: not-ready days whose projection had a date but showed none. notAtCurrentPace: days the claim was projected / shown (it is shown only after 3 consecutive evaluations said so), and the shown claims followed by a ready evaluation within 30 days (>= 30 evaluation days left).",
    byProfile,
    profilesScored: scored.map(([p]) => p),
    pass: scored.length > 0 && scored.every(([, r]) => r.pass === true),
  };
}

function summariseSe(probes: readonly SeProbe[]): Record<string, unknown> {
  const configs = [...new Set(probes.map((p) => p.config))].sort();
  const rows = configs.map((config) => {
    const xs = probes.filter((p) => p.config === config);
    const abs = xs.map((x) => Math.abs(x.logSeRatio));
    const byProfile: Record<string, number | null> = {};
    for (const pr of [...new Set(xs.map((x) => x.profile))].sort()) byProfile[pr] = r4(median(xs.filter((x) => x.profile === pr).map((x) => Math.abs(x.logSeRatio))) ?? NaN);
    return {
      config, comparisons: xs.length,
      medianAbsLogSeRatio: r4(median(abs) ?? NaN),
      medianLogSeRatio: r4(median(xs.map((x) => x.logSeRatio)) ?? NaN),
      p90AbsLogSeRatio: r4([...abs].sort((a, b) => a - b)[Math.floor(abs.length * 0.9)] ?? NaN),
      medianAbsByProfile: byProfile,
      pass: xs.length >= 200 && (median(abs) ?? Infinity) <= 0.05,
    };
  });
  return {
    rule: "METHOD.md §6: analytic SE vs the B = 2,000 bootstrap on >= 200 evaluations; median |ln(SE ratio)| <= 5% per configuration",
    rows,
    pass: rows.length > 0 && rows.every((r) => r.pass),
  };
}

function summariseSensitivity(store: Store, cfg: RunConfig, c: Candidate, variants: readonly Candidate[], agentExercised: boolean): Record<string, unknown> {
  const v0 = ERRORS_VOTES[0]!;
  const rows = [c, ...variants].map((cand) => {
    const per = cfg.profiles.map((p) => {
      // Same seeds for every row: the ones the variants ran on.
      const nullSeeds = new Set(store.get(`null|${p}`, variants[0]!.id).map((r) => r.seed));
      const rs = store.get(`null|${p}`, cand.id).filter((r) => nullSeeds.has(r.seed));
      const row = nullRow(rs, cand.id, v0, agentExercised);
      const pw = cfg.effectSizes.map((m) => {
        const seeds = new Set(store.get(`effect${m}|${p}`, variants[0]!.id).map((r) => r.seed));
        return powerRow(store.get(`effect${m}|${p}`, cand.id).filter((r) => seeds.has(r.seed)), cand.id, v0, `x${m}`);
      });
      return {
        profile: p, sequences: row.sequences, falseChanged: row.falseChanged, everNone: row.everNone,
        noneDayShare: r4(row.displayedDayShare["none"] ?? 0), singleIndicator: row.singleIndicator,
        power: Object.fromEntries(pw.map((x) => [x.effect, x.detected])),
      };
    });
    return { candidate: cand.id, pseudo: cand.method.pseudo ?? 0.5, mdeAlpha: cand.method.mdeAlpha ?? r4(1 - cand.method.level), profiles: per };
  });
  return {
    rule: "research/08 #5-#6: pseudo-count 0.25 / 0.5 / 1.0 and the Holm-adjusted MDE critical value (alpha/3), same seeds, under " + v0,
    nullSequencesPerProfile: cfg.sensitivityNull,
    effectSequencesPerProfile: cfg.sensitivityEffect,
    rows,
  };
}

function summariseAttr(store: Store, cfg: RunConfig, chosen: string): Record<string, unknown> {
  const v0 = ERRORS_VOTES[0]!;
  const scenarios = ATTR_SCENARIOS.map((sc) => {
    const rs = store.get(`attr|${sc.id}`, chosen);
    const matrix: Record<string, number> = {};
    for (const r of rs) {
      const t = r.tracks.find((x) => x.errorsVote === v0)!;
      // The first persisted claim on or after the onset (its key), else "no_claim".
      const i = r.onsetEvalDay === null ? -1 : t.changedStarts.findIndex((d) => d >= r.onsetEvalDay!);
      const claimed = i < 0 ? "no_claim" : t.changedStartKeys[i]!;
      matrix[claimed] = (matrix[claimed] ?? 0) + 1;
    }
    const n = rs.length;
    const conditions = sc.conditions.map((cond) => {
      const k = rs.filter((r) => {
        const t = r.tracks.find((x) => x.errorsVote === v0)!;
        return cond.state === "agent" ? t.everAgent : cond.state === "you" ? t.everYou : false;
      }).length;
      const p = proportion(k, n);
      return { state: cond.state, max: cond.max, rate: p, pass: cond.max === null ? null : p.hi <= cond.max };
    });
    return { id: sc.id, row: sc.row, truth: sc.truth, sequences: n, firstClaim: matrix, conditions };
  });
  return {
    rule: "G-attr (METHOD.md §14). Confusion matrix = the first persisted changed-class glance key on or after the onset, per scenario (truth = what the synth planted).",
    status: "scaffolding: the interim decider has no attribution states, so every claim is changed_unattributed / unclear:workload; the conditions are evaluated but cannot fail until WP-21's decider runs here",
    errorsVote: v0,
    scenarios,
    notExpressible: ATTR_NOT_EXPRESSIBLE,
  };
}

function summariseOnset(store: Store, cfg: RunConfig, chosen: string): Record<string, unknown> {
  const v0 = ERRORS_VOTES[0]!;
  let detected = 0, withOnset = 0, covered = 0;
  const errors: number[] = [];
  for (const m of cfg.effectSizes) {
    for (const p of cfg.profiles) {
      for (const r of store.get(`effect${m}|${p}`, chosen)) {
        const t = r.tracks.find((x) => x.errorsVote === v0)!;
        const i = t.changedStarts.findIndex((d) => r.onsetEvalDay !== null && d >= r.onsetEvalDay);
        if (i < 0 || r.onsetDay === null) continue;
        detected++;
        const o = t.onsetAtStarts[i];
        if (!o) continue;
        withOnset++;
        if (o.from <= r.onsetDay && r.onsetDay <= o.to) covered++;
        const mid = (Date.parse(o.from) + Date.parse(o.to)) / 2;
        errors.push(Math.abs(mid - Date.parse(r.onsetDay)) / 86_400_000);
      }
    }
  }
  return {
    rule: "G-onset: I covers the true onset at least 80% of the time",
    detectedSequences: detected,
    withOnsetInterval: withOnset,
    coverage: withOnset > 0 ? proportion(covered, withOnset) : null,
    medianAbsCentreErrorDays: median(errors),
    status: withOnset === 0 ? "not_evaluable: the decider supplies no onset interval (onset is WP-21's output, METHOD.md §10)" : covered / withOnset >= 0.8 ? "pass" : "fail",
  };
}

export type { Proportion };
