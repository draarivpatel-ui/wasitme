/**
 * WP-23 calibration runner. No CLI flags: configured by environment variables only. Synthetic data only.
 *
 * Plain ESM over the compiled engine (build first). It lives here, not in src/synth, because the synth sources must
 * never read the environment or the clock (test/synth-privacy.test.ts); this script does both, and nothing else.
 *
 * The full run is CPU-heavy and runs ONLY through scripts/dev/heavy.sh (one heavy job at a time, nice 10). It refuses
 * to start unless its parent process is the heavy.sh that holds the lock:
 *
 *   cd engine && npm run build && ../scripts/dev/heavy.sh env WASITME_CAL23=full node scripts/calibration-run.mjs
 *
 * Writes docs/calibration/<local date>.json (the dated artifact: aggregates of synthetic runs only) and a progress log
 * docs/calibration/<local date>.log. The 50-sequence smoke runs inside `npm test` (test/calibration/harness.test.ts).
 *
 * Environment:
 *   WASITME_CAL23            "full" (required to run)
 *   WASITME_CAL_WORKERS      worker threads (default 1, capped at 2: keep CPU low on a shared machine)
 *   WASITME_CAL_CANDIDATES   comma-separated candidate ids (default: all)
 *   WASITME_CAL_PROFILES     comma-separated profile ids (default: all)
 *   WASITME_CAL_NULL_PILOT / WASITME_CAL_NULL / WASITME_CAL_EFFECT_PILOT / WASITME_CAL_EFFECT /
 *   WASITME_CAL_SENS_NULL / WASITME_CAL_SENS_EFFECT / WASITME_CAL_ATTR / WASITME_CAL_MDE / WASITME_CAL_ETA /
 *   WASITME_CAL_SE           sequence counts (defaults: FULL_CONFIG)
 *   WASITME_CAL_EFFECT_SIZES comma-separated planted multipliers (default 1.5,2)
 *   WASITME_CAL_DECIDER      decider registry id (default "interim"; "wp21" = attribution/attributeAgent)
 *   WASITME_CAL_NOTE         a note recorded in the artifact (e.g. why a run is reduced)
 *   WASITME_CAL_SEED         run seed (default FULL_CONFIG.runSeed)
 *   WASITME_CAL_OUT / WASITME_CAL_LOG   output paths (default docs/calibration/<date>.json / .log)
 *   WASITME_CAL_DEADLINE_S   stop starting new jobs after this many seconds; the artifact is then marked partial (D58)
 *   WASITME_CAL_CACHE        JSONL file of finished sequences (synthetic aggregates). Re-running the same command with
 *                            the same cache skips every sequence already in it — that is how a stopped run resumes.
 *                            Entries are keyed by a digest of the compiled analysis + synth code, so a code change
 *                            never reuses stale results.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FULL_CONFIG, runCalibration } from "../dist/src/analysis/calibration/run.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** A path as logged: repo-relative inside the repo, else only its file name (logs are committed; no home paths). */
const shown = (p) => (resolve(p).startsWith(REPO + "/") ? relative(REPO, resolve(p)) : `<outside repo>/${p.split("/").pop()}`);

function heavyLockHeldByParent() {
  // The long lane (WASITME_HEAVY_LANE=long) has its own lock so a multi-hour run doesn't stall builds and tests.
  const lane = process.env.WASITME_HEAVY_LANE;
  const lock = join(process.env.TMPDIR || "/tmp", lane ? `wasitme-heavy-${lane}.lock` : "wasitme-heavy.lock");
  const pidFile = join(lock, "pid");
  if (!existsSync(pidFile)) return { ok: false, why: `no heavy.sh lock at ${lock}` };
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (pid !== process.ppid) return { ok: false, why: `the heavy.sh lock is held by pid ${pid}, not by this process's parent (${process.ppid})` };
  return { ok: true, why: "" };
}

/** HEAD commit of the repo, read from .git without running git (worktree-aware). */
function headCommit() {
  try {
    let gitDir = join(REPO, ".git");
    if (statSync(gitDir).isFile()) gitDir = resolve(REPO, readFileSync(gitDir, "utf8").replace(/^gitdir:\s*/, "").trim());
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head;
    const ref = head.slice(4).trim();
    const common = existsSync(join(gitDir, "commondir")) ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()) : gitDir;
    for (const dir of [gitDir, common]) if (existsSync(join(dir, ref))) return readFileSync(join(dir, ref), "utf8").trim();
    const packed = join(common, "packed-refs");
    if (existsSync(packed)) for (const line of readFileSync(packed, "utf8").split("\n")) if (line.endsWith(` ${ref}`)) return line.split(" ")[0];
  } catch {
    // fall through
  }
  return null;
}

/** Digest of the compiled code a sequence result depends on (dist/src/analysis + dist/src/synth + dist/src/types). */
function codeDigest() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/src");
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) files.push(p);
    }
  };
  for (const sub of ["analysis", "synth"]) walk(join(root, sub));
  for (const f of ["types.js", "util.js"]) if (existsSync(join(root, f))) files.push(join(root, f));
  const h = createHash("sha256");
  for (const f of files.sort()) h.update(relative(root, f)).update("\0").update(readFileSync(f)).update("\0");
  return h.digest("hex").slice(0, 16);
}

/** A JSONL-backed SequenceCache (see WASITME_CAL_CACHE). */
function fileCache(path, digest, log) {
  const map = new Map();
  let skipped = 0;
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.code === digest) map.set(e.key, e.result);
        else skipped++;
      } catch {
        skipped++;
      }
    }
  }
  log(`cache ${shown(path)}: ${map.size} sequences for code ${digest}${skipped ? `, ${skipped} entries of other code versions ignored` : ""}`);
  mkdirSync(dirname(path), { recursive: true });
  return {
    get: (key) => map.get(key),
    put: (key, result) => {
      map.set(key, result);
      appendFileSync(path, JSON.stringify({ code: digest, key, result }) + "\n");
    },
  };
}

function localDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function num(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`${name} must be a non-negative number (got ${v})`);
  return Math.floor(n);
}

async function main() {
  if (process.env.WASITME_CAL23 !== "full") {
    console.error("calibration-run: set WASITME_CAL23=full and run through scripts/dev/heavy.sh (the smoke runs in npm test).");
    process.exit(2);
  }
  const guard = heavyLockHeldByParent();
  if (!guard.ok) {
    console.error(`calibration-run: refusing to run outside scripts/dev/heavy.sh (${guard.why}).`);
    console.error("  cd engine && ../scripts/dev/heavy.sh env WASITME_CAL23=full node scripts/calibration-run.mjs");
    process.exit(2);
  }
  const started = new Date();
  const date = localDate(started);
  const out = process.env.WASITME_CAL_OUT || join(REPO, "docs", "calibration", `${date}.json`);
  const logPath = process.env.WASITME_CAL_LOG || out.replace(/\.json$/, "") + ".log";
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, "");
  const log = (line) => {
    appendFileSync(logPath, line + "\n");
    console.log(line);
  };
  const cfg = {
    ...FULL_CONFIG,
    runSeed: process.env.WASITME_CAL_SEED || FULL_CONFIG.runSeed,
    // One worker by default, never more than two unless WASITME_CAL_MAX_WORKERS says so: calibration runs on a shared machine.
    workers: Math.min(Number(process.env.WASITME_CAL_MAX_WORKERS) || 2, num("WASITME_CAL_WORKERS", 1)),
    candidates: process.env.WASITME_CAL_CANDIDATES ? process.env.WASITME_CAL_CANDIDATES.split(",").map((s) => s.trim()).filter(Boolean) : FULL_CONFIG.candidates,
    profiles: process.env.WASITME_CAL_PROFILES ? process.env.WASITME_CAL_PROFILES.split(",").map((s) => s.trim()).filter(Boolean) : FULL_CONFIG.profiles,
    nullPilot: num("WASITME_CAL_NULL_PILOT", FULL_CONFIG.nullPilot),
    nullFull: num("WASITME_CAL_NULL", FULL_CONFIG.nullFull),
    effectPilot: num("WASITME_CAL_EFFECT_PILOT", FULL_CONFIG.effectPilot),
    effectFull: num("WASITME_CAL_EFFECT", FULL_CONFIG.effectFull),
    sensitivityNull: num("WASITME_CAL_SENS_NULL", FULL_CONFIG.sensitivityNull),
    sensitivityEffect: num("WASITME_CAL_SENS_EFFECT", FULL_CONFIG.sensitivityEffect),
    attrPerScenario: num("WASITME_CAL_ATTR", FULL_CONFIG.attrPerScenario),
    mdeSequences: num("WASITME_CAL_MDE", FULL_CONFIG.mdeSequences),
    etaSequences: num("WASITME_CAL_ETA", FULL_CONFIG.etaSequences),
    seSequences: num("WASITME_CAL_SE", FULL_CONFIG.seSequences),
    decider: process.env.WASITME_CAL_DECIDER || FULL_CONFIG.decider,
    effectSizes: process.env.WASITME_CAL_EFFECT_SIZES ? process.env.WASITME_CAL_EFFECT_SIZES.split(",").map(Number).filter((x) => x > 0) : FULL_CONFIG.effectSizes,
    notes: process.env.WASITME_CAL_NOTE ? [process.env.WASITME_CAL_NOTE] : [],
    ...(process.env.WASITME_CAL_DEADLINE_S ? { deadlineSeconds: num("WASITME_CAL_DEADLINE_S", 0) } : {}),
    // A stopped run keeps what it finished: the artifact is rewritten after every phase (status = the last phase).
    onCheckpoint: (partial) => {
      writeFileSync(out, JSON.stringify({ ...partial, date, commit: headCommit(), startedAt: started.toISOString(), finishedAt: null, resume }, null, 2) + "\n");
      log(`checkpoint (${partial.status}) written`);
    },
    log,
  };
  const cachePath = process.env.WASITME_CAL_CACHE ? resolve(process.env.WASITME_CAL_CACHE) : null;
  if (cachePath) cfg.cache = fileCache(cachePath, codeDigest(), log);
  // The command that resumes (or completes) this run: the same settings without the deadline; with the same cache,
  // every finished sequence is reused.
  const vars = Object.keys(process.env).filter((k) => k.startsWith("WASITME_CAL") && k !== "WASITME_CAL_DEADLINE_S" && k !== "WASITME_CAL_WORKERS").sort();
  const resume = `cd engine && npm run build && ../scripts/dev/heavy.sh env ${vars.map((k) => `${k}=${JSON.stringify(process.env[k])}`).join(" ")} node scripts/calibration-run.mjs`;
  const changed = (["profiles", "effectSizes", "decider", "nullPilot", "nullFull", "effectPilot", "effectFull", "sensitivityNull", "sensitivityEffect", "attrPerScenario", "mdeSequences", "etaSequences", "seSequences", "candidates", "runSeed"])
    .some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(FULL_CONFIG[k]));
  if (changed) cfg.mode = "custom";
  log(`[${started.toISOString()}] WP-23 calibration (${cfg.mode}) workers=${cfg.workers} out=${shown(out)}`);
  log(`config ${JSON.stringify({ ...cfg, log: undefined })}`);
  const artifact = await runCalibration(cfg);
  const finished = new Date();
  const doc = { ...artifact, date, commit: headCommit(), startedAt: started.toISOString(), finishedAt: finished.toISOString(), resume };
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  log(`[${finished.toISOString()}] done in ${artifact.runtime.seconds} s; chosen ${artifact.selection.chosen ?? "none"}; calibrated ${JSON.stringify(Object.fromEntries(Object.entries(artifact.calibrated).map(([k, v]) => [k, v.calibrated])))}`);
  log(`artifact: ${shown(out)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
