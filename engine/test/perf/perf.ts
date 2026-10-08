#!/usr/bin/env node
/**
 * Performance harness for the store/scan against its budgets (D60, D63), on SYNTHETIC data only (dev tool under
 * engine/test: never shipped).
 *
 *   scripts/dev/heavy.sh node engine/dist/test/perf/perf.js --out <empty dir> [--gb 2.3] [--runs 5] [--no-sandbox]
 *                                                            [--json <file>] [--keep] [--calibrated]
 *
 * `--calibrated` runs every scan with a TEST-ONLY calibration artifact (perf-run.ts) that calibrates both agents; without
 * it the scans take the SHIPPED artifact (D69: both agents calibrated too). The report prints each agent's calibrated
 * flag and state as the snapshot records them, never an assumption.
 *
 * Corpus. The synthetic generator writes realistic RECORDS but small ones (~25 KB per exchange); real logs can be far
 * larger per exchange (large tool outputs, file reads, pastes) and run to gigabytes. So the harness generates
 * ordinary synth scenarios — two `null-few-long` Claude seeds (few, very long sessions: the D11 case) and one
 * `codex-only` seed — one seed in memory at a time, and pads tool OUTPUT strings (Claude tool_result content, Codex
 * command output) with neutral filler while streaming them to disk, until the corpus reaches the target size. The
 * largest Claude session is padded to ~211 MB (the "one changed big session" rows below). Padding never touches the
 * fields the readers count (ids, flags, statuses, usage, the first characters the error classifiers look at).
 *
 * Measurements, each scan in a fresh node process (perf-run.js):
 *   full scan, first run (empty store)       — "cold" here means an empty store; the OS page cache is NOT dropped
 *                                               (that needs root), so true cold-disk numbers are not measured;
 *   full scan, warm (empty store, again)     — × runs;
 *   nothing changed (populated store)        — × 2·runs, p95 of the scan's own time (and process wall time);
 *   one changed big session (one exchange appended to the ~211 MB file) — × runs, p95;
 *   one evaluation (all voting + support metrics, B = 2,000) — the scan's evaluate phase per agent;
 *   peak RSS of every run; the incremental rows again under `node --permission` (sandbox) unless --no-sandbox;
 *   one changed big session in a SINGLE-PROJECT layout (WP-12 review) — every Claude session moved into the big
 *   session's project folder and the big session made the newest, so re-parsing it needs every other session as a
 *   prior. Measured last: the move re-keys every source (one absorbing full scan first).
 */
// wasitme:allow-child_process -- dev-only harness under engine/test (never shipped); spawns this node on its own runner script
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probePermissionFlag } from "../../src/store/permission.js";
import { generate } from "../../src/synth/generate.js";
import { findScenario } from "../../src/synth/scenarios.js";
import { assertSafeOut } from "../../src/synth/write.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(HERE, "..", "..", "..");
const RUNNER = join(HERE, "perf-run.js");
const MB = 1 << 20;

// ------------------------------------------------------------------------------------------------ corpus

const FILLER_LINE = "synthetic output line: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor\n";

function filler(bytes: number): string {
  if (bytes <= 0) return "";
  return FILLER_LINE.repeat(Math.ceil(bytes / FILLER_LINE.length)).slice(0, bytes);
}

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** Pad tool output inside one record; returns how many fields were padded (0: untouched). */
function padRecord(r: Rec, pad: string): number {
  let n = 0;
  const msg = isObj(r.message) ? r.message : undefined;
  if (r.type === "user" && msg && Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (!isObj(b) || b.type !== "tool_result") continue;
      if (typeof b.content === "string") { b.content = `${b.content}\n${pad}`; n++; }
      else if (Array.isArray(b.content)) {
        const t = b.content.find((x): x is Rec => isObj(x) && x.type === "text" && typeof x.text === "string");
        if (t) { t.text = `${String(t.text)}\n${pad}`; n++; }
      }
    }
  }
  const p = isObj(r.payload) ? r.payload : undefined;
  if (p && r.type === "event_msg" && p.type === "item_completed" && isObj(p.item) && p.item.type === "CommandExecution") {
    for (const k of ["aggregated_output", "stdout"]) if (typeof p.item[k] === "string") { p.item[k] = `${String(p.item[k])}\n${pad}`; n++; }
  }
  if (p && r.type === "response_item" && p.type === "function_call_output" && typeof p.output === "string") { p.output = `${p.output}\n${pad}`; n++; }
  return n;
}

function countPaddable(data: string): number {
  let n = 0;
  for (const line of data.split("\n")) {
    if (!line) continue;
    try { n += padRecord(JSON.parse(line) as Rec, ""); } catch { /* not a record */ }
  }
  return n;
}

/** Stream one generated file to disk with every tool output padded by `padBytes`. Returns bytes written. */
function writePadded(path: string, data: string, padBytes: number, mtimeMs: number | undefined): number {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx");
  const pad = filler(padBytes);
  let buf: string[] = [];
  let pending = 0, written = 0;
  const flush = () => {
    if (!buf.length) return;
    const b = Buffer.from(buf.join(""), "utf8");
    writeSync(fd, b);
    written += b.length;
    buf = [];
    pending = 0;
  };
  try {
    const lines = data.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const last = i === lines.length - 1;
      let out = line;
      if (line && padBytes > 0) {
        try {
          const r = JSON.parse(line) as Rec;
          if (padRecord(r, pad) > 0) out = JSON.stringify(r);
        } catch { /* keep damaged lines as generated */ }
      }
      buf.push(last ? out : `${out}\n`);
      pending += out.length + 1;
      if (pending > 4 * MB) flush();
    }
    flush();
  } finally {
    closeSync(fd);
  }
  if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return written;
}

export interface CorpusInfo { root: string; claude: string; codex: string; bytes: number; files: number; bigSession: string; bigBytes: number; collisions: number; /** End of the synthetic run (ms): scans are evaluated as of the next day, so the windows hold data. */ endMs: number }

const SEEDS: readonly { scenario: string; seed: number; share: number }[] = [
  { scenario: "null-few-long", seed: 101, share: 0.45 },
  { scenario: "null-few-long", seed: 202, share: 0.45 },
  { scenario: "codex-only", seed: 107, share: 0.10 },
];

export function buildCorpus(root: string, targetBytes: number, bigTarget = 211 * MB, log: (s: string) => void = () => {}): CorpusInfo {
  const info: CorpusInfo = { root, claude: join(root, "claude"), codex: join(root, "codex"), bytes: 0, files: 0, bigSession: "", bigBytes: 0, collisions: 0, endMs: 0 };
  let bigDone = false;
  for (const s of SEEDS) {
    const sc = findScenario(s.scenario);
    if (!sc) throw new Error(`unknown scenario ${s.scenario}`);
    const g = generate(sc.build({ seed: s.seed }), sc.name);
    info.endMs = Math.max(info.endMs, Date.parse(`${g.truth.startDay}T00:00:00Z`) + g.truth.days * 86_400_000);
    const files = g.files.filter((f) => /^(claude|codex)\//.test(f.path) && f.path.endsWith(".jsonl"));
    const datas = files.map((f) => (typeof f.data === "string" ? f.data : f.data.toString("utf8")));
    const unpadded = datas.reduce((n, d) => n + Buffer.byteLength(d), 0);
    const paddable = datas.map(countPaddable);
    let budget = targetBytes * s.share;
    // The big session: the largest Claude main transcript of the first seed, padded to ~bigTarget on its own.
    let bigIdx = -1;
    if (!bigDone && s.scenario !== "codex-only") {
      let best = -1;
      files.forEach((f, i) => {
        if (/^claude\/projects\/[^/]+\/[^/]+\.jsonl$/.test(f.path) && paddable[i]! > 0 && Buffer.byteLength(datas[i]!) > best) { best = Buffer.byteLength(datas[i]!); bigIdx = i; }
      });
    }
    const totalPaddable = paddable.reduce((a, b, i) => a + (i === bigIdx ? 0 : b), 0);
    if (bigIdx >= 0) budget -= bigTarget;
    const pad = totalPaddable > 0 ? Math.max(0, Math.floor((budget - unpadded) / totalPaddable)) : 0;
    files.forEach((f, i) => {
      const path = join(root, f.path);
      if (existsSync(path)) { info.collisions++; return; }
      const p = i === bigIdx ? Math.max(0, Math.floor((bigTarget - Buffer.byteLength(datas[i]!)) / Math.max(1, paddable[i]!))) : pad;
      const n = writePadded(path, datas[i]!, p, f.mtimeMs);
      info.bytes += n;
      info.files++;
      if (i === bigIdx) { info.bigSession = path; info.bigBytes = n; bigDone = true; }
    });
    log(`  ${s.scenario} seed ${s.seed}: ${files.length} files, pad ${pad} B per tool output, corpus now ${(info.bytes / MB).toFixed(0)} MB`);
  }
  return info;
}

/** Append one fresh human exchange (prompt + one response) to a Claude session file. */
export function appendExchange(path: string, n: number): void {
  const head = readFileSync(path, { encoding: "utf8" }).slice(0, 64 * 1024).split("\n")[0] ?? "{}";
  let first: Rec = {};
  try { first = JSON.parse(head) as Rec; } catch { /* defaults */ }
  const t = new Date(Date.parse("2026-08-01T12:00:00Z") + n * 60_000).toISOString();
  const base = { parentUuid: null, isSidechain: false, userType: "external", cwd: first.cwd ?? "/synthetic/project", sessionId: first.sessionId ?? "s", version: first.version ?? "2.1.250", entrypoint: "cli", gitBranch: "main" };
  const user = { ...base, type: "user", uuid: `perf-u-${n}-${Date.now()}`, timestamp: t, message: { role: "user", content: `perf follow-up ${n}` }, origin: { kind: "human" }, promptSource: "typed", permissionMode: "default" };
  const asst = { ...base, type: "assistant", uuid: `perf-a-${n}-${Date.now()}`, timestamp: t, requestId: `req_perf_${n}_${Date.now()}`, message: { id: `msg_perf_${n}`, type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
  appendFileSync(path, `${JSON.stringify(user)}\n${JSON.stringify(asst)}\n`);
}

/**
 * Move every Claude session (main transcript and its subagent folder) into the big session's project folder, then
 * re-create the big session file so it is the newest (creation order is by birth time). Returns the bytes of the
 * earlier sessions it now has as priors.
 */
export function singleProject(corpus: CorpusInfo): { moved: number; priorsMB: number } {
  const projects = join(corpus.claude, "projects");
  const target = dirname(corpus.bigSession);
  let moved = 0;
  for (const p of readdirSync(projects)) {
    const dir = join(projects, p);
    if (dir === target || !statSync(dir).isDirectory()) continue;
    for (const n of readdirSync(dir)) {
      if (existsSync(join(target, n))) continue;
      renameSync(join(dir, n), join(target, n));
      moved++;
    }
  }
  const tmp = `${corpus.bigSession}.new`;
  copyFileSync(corpus.bigSession, tmp);
  renameSync(tmp, corpus.bigSession);
  let priors = 0;
  for (const n of readdirSync(target)) {
    const f = join(target, n);
    if (n.endsWith(".jsonl") && f !== corpus.bigSession) priors += statSync(f).size;
  }
  return { moved, priorsMB: priors / MB };
}

// ------------------------------------------------------------------------------------------------ measuring

export interface RunResult { wallMs: number; procWallMs: number; scanMs: number; maxRssMB: number; timings: Record<string, number>; parsed: number; unchanged: number; reused: boolean; sources: number; exchanges: number; sandbox: boolean | null; eligible: number; priorReads: number; states?: string[]; calibrated?: string[] }

export interface MeasureEnv { corpus: CorpusInfo; home: string; userHome: string; tz: string; flag: string | null; calibrated?: boolean }

export function runOnce(m: MeasureEnv, sandbox: boolean): RunResult {
  const opts = { home: m.home, userHome: m.userHome, claude: m.corpus.claude, codex: m.corpus.codex, tz: m.tz, now: new Date(m.corpus.endMs + 12 * 3_600_000).toISOString(), ...(m.calibrated ? { calibrated: true } : {}) };
  const flags = sandbox && m.flag ? [
    m.flag, `--allow-fs-read=${ENGINE}`, `--allow-fs-read=${m.corpus.claude}`, `--allow-fs-read=${m.corpus.codex}`,
    `--allow-fs-read=${m.home}/*`, `--allow-fs-write=${m.home}/*`,
  ] : [];
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [...flags, RUNNER, JSON.stringify(opts)], { encoding: "utf8", env: { HOME: m.userHome, PATH: "/usr/bin:/bin" }, maxBuffer: 16 * MB });
  const wallMs = performance.now() - t0;
  if (r.status !== 0) throw new Error(`perf-run failed: ${r.stderr.trim()}`);
  const j = JSON.parse(r.stdout.trim().split("\n").pop()!) as Omit<RunResult, "wallMs" | "procWallMs"> & { wallMs: number };
  return { ...j, procWallMs: j.wallMs, wallMs };
}

const p95 = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)] ?? NaN;
};
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN;
};

export interface Row { what: string; measured: string; budget: string; pass: boolean | null }

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const outArg = arg("--out");
  if (!outArg) throw new Error("--out <empty dir> is required");
  const out = assertSafeOut(outArg);
  if (existsSync(out) && readdirSync(out).length) throw new Error("--out must be a new or empty directory");
  const gb = Number(arg("--gb") ?? "2.3");
  const runs = Math.max(1, Number(arg("--runs") ?? "5"));
  const sandbox = !argv.includes("--no-sandbox");
  const log = (s: string) => process.stdout.write(`${s}\n`);

  mkdirSync(out, { recursive: true });
  log(`building a ${gb} GB synthetic corpus in ${out} …`);
  const t0 = performance.now();
  const corpus = buildCorpus(join(out, "corpus"), gb * 1024 * MB, 211 * MB, log);
  log(`  ${corpus.files} files, ${(corpus.bytes / MB).toFixed(0)} MB (big session ${(corpus.bigBytes / MB).toFixed(0)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)} s; ${corpus.collisions} path collisions skipped`);
  const userHome = join(out, "home");
  mkdirSync(userHome, { recursive: true });
  const m: MeasureEnv = { corpus, home: join(userHome, ".wasitme"), userHome, tz: "UTC", flag: sandbox ? probePermissionFlag() : null, calibrated: argv.includes("--calibrated") };

  const results: Record<string, RunResult[]> = {};
  const rec = (k: string, r: RunResult) => { (results[k] ??= []).push(r); log(`  ${k}: wall ${r.wallMs.toFixed(0)} ms, scan ${r.scanMs.toFixed(0)} ms, rss ${r.maxRssMB.toFixed(0)} MB, parsed ${r.parsed}/${r.sources}${r.reused ? " (reused)" : ""}`); };
  const fresh = () => { rmSync(m.home, { recursive: true, force: true }); mkdirSync(m.home, { recursive: true, mode: 0o700 }); };

  log("full scan, first run (empty store):");
  fresh();
  rec("fullFirst", runOnce(m, false));
  log("full scan, warm (empty store each time):");
  for (let i = 0; i < runs; i++) { fresh(); rec("fullWarm", runOnce(m, false)); }
  log("nothing changed:");
  for (let i = 0; i < runs * 2; i++) rec("nothing", runOnce(m, false));
  log("one changed big session:");
  for (let i = 0; i < runs; i++) { appendExchange(corpus.bigSession, i); rec("oneChanged", runOnce(m, false)); }
  if (sandbox && m.flag) {
    log(`under node ${m.flag}:`);
    for (let i = 0; i < runs * 2; i++) rec("nothingSandbox", runOnce(m, true));
    for (let i = 0; i < runs; i++) { appendExchange(corpus.bigSession, 100 + i); rec("oneChangedSandbox", runOnce(m, true)); }
    fresh();
    rec("fullSandbox", runOnce(m, true));
  }
  log("one changed big session, single-project layout:");
  const single = singleProject(corpus);
  log(`  moved ${single.moved} sessions; the big session has ${single.priorsMB.toFixed(0)} MB of earlier sessions as priors`);
  rec("singleAbsorb", runOnce(m, false));
  for (let i = 0; i < runs; i++) { appendExchange(corpus.bigSession, 200 + i); rec("oneChangedSingle", runOnce(m, false)); }

  const R = (k: string) => results[k] ?? [];
  const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`);
  const warmMax = Math.max(...R("fullWarm").map((r) => r.wallMs));
  const rssMax = Math.max(...Object.values(results).flat().map((r) => r.maxRssMB));
  // The whole evaluation phase (every agent), not phase / agents: agents differ (one may stop at an early row), so an
  // average would understate the slowest; the phase total bounds every agent's own evaluation.
  const evalPhase = Math.max(...[...R("fullWarm"), ...R("fullFirst")].map((r) => r.timings.evaluate!));
  const rows: Row[] = [
    { what: `Full scan, ${(corpus.bytes / 1024 / MB).toFixed(2)} GB, warm (max of ${R("fullWarm").length}, process wall)`, measured: `${fmt(warmMax)} (median ${fmt(median(R("fullWarm").map((r) => r.wallMs)))})`, budget: "≤ 10 s", pass: warmMax <= 10_000 },
    { what: "Full scan, first run (empty store; page cache NOT dropped)", measured: fmt(R("fullFirst")[0]!.wallMs), budget: "≤ 30 s cold [cold disk not measured]", pass: null },
    { what: "Peak RSS, any run", measured: `${rssMax.toFixed(0)} MB`, budget: "≤ 400 MB", pass: rssMax <= 400 },
    { what: `Incremental: one changed ${(corpus.bigBytes / MB).toFixed(0)} MB session, p95 scan time (${R("oneChanged").length} runs)`, measured: `${fmt(p95(R("oneChanged").map((r) => r.scanMs)))} (process wall p95 ${fmt(p95(R("oneChanged").map((r) => r.wallMs)))})`, budget: "≤ 1.5 s p95", pass: p95(R("oneChanged").map((r) => r.scanMs)) <= 1500 },
    { what: `Incremental, single-project layout (${single.priorsMB.toFixed(0)} MB of earlier sessions in the same project, each scan a fresh process), p95 scan time (${R("oneChangedSingle").length} runs; prior files read: max ${Math.max(...R("oneChangedSingle").map((r) => r.priorReads))})`, measured: fmt(p95(R("oneChangedSingle").map((r) => r.scanMs))), budget: "≤ 1.5 s p95", pass: p95(R("oneChangedSingle").map((r) => r.scanMs)) <= 1500 },
    { what: `Nothing changed, p95 scan time (${R("nothing").length} runs)`, measured: `${fmt(p95(R("nothing").map((r) => r.scanMs)))} (process wall p95 ${fmt(p95(R("nothing").map((r) => r.wallMs)))})`, budget: "≤ 300 ms", pass: p95(R("nothing").map((r) => r.scanMs)) <= 300 },
    { what: `Evaluation phase, all agents together (voting + support metrics, B = 2,000; ${R("fullWarm")[0]?.eligible ?? 0} eligible metrics in the chosen tiers, evaluated as of the corpus end; bounds each agent's one evaluation)`, measured: fmt(evalPhase), budget: "≤ 500 ms per agent", pass: evalPhase <= 500 },
  ];
  if (R("nothingSandbox").length) {
    rows.push(
      { what: `Sandbox (${m.flag}): nothing changed, p95 scan time`, measured: fmt(p95(R("nothingSandbox").map((r) => r.scanMs))), budget: "≤ 300 ms", pass: p95(R("nothingSandbox").map((r) => r.scanMs)) <= 300 },
      { what: `Sandbox (${m.flag}): one changed session, p95 scan time`, measured: fmt(p95(R("oneChangedSandbox").map((r) => r.scanMs))), budget: "≤ 1.5 s p95", pass: p95(R("oneChangedSandbox").map((r) => r.scanMs)) <= 1500 },
      { what: `Sandbox (${m.flag}): full scan (empty store, process wall)`, measured: fmt(R("fullSandbox")[0]!.wallMs), budget: "≤ 10 s warm", pass: R("fullSandbox")[0]!.wallMs <= 10_000 },
    );
  }
  log("");
  log(`| Operation | Measured | Budget | Pass |`);
  log(`|---|---|---|---|`);
  for (const r of rows) log(`| ${r.what} | ${r.measured} | ${r.budget} | ${r.pass === null ? "n/a" : r.pass ? "yes" : "NO"} |`);
  log(`node ${process.version}, ${corpus.files} files, exchanges counted ${R("fullWarm")[0]?.exchanges ?? "?"}; phase timings of a warm full scan: ${JSON.stringify(Object.fromEntries(Object.entries(R("fullWarm")[0]?.timings ?? {}).map(([k, v]) => [k, Math.round(v)])))}`);
  log(`calibration: ${m.calibrated ? "TEST-ONLY artifact" : "shipped artifact"}; per agent ${JSON.stringify(R("fullWarm")[0]?.calibrated ?? [])}; states ${JSON.stringify(R("fullWarm")[0]?.states ?? [])}`);
  const json = arg("--json");
  if (json) writeFileSync(json, `${JSON.stringify({ node: process.version, gb, runs, corpus: { ...corpus, root: undefined, claude: undefined, codex: undefined, bigSession: undefined }, rows, results }, null, 2)}\n`);
  if (!argv.includes("--keep")) rmSync(out, { recursive: true, force: true });
  if (rows.some((r) => r.pass === false)) process.exitCode = 1;
}

if (/perf\.js$/.test(process.argv[1] ?? "")) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`perf: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}

/** Size of a file in MB (for the smoke test). */
export function sizeMB(p: string): number {
  return statSync(p).size / MB;
}
