/**
 * Store test helpers. Everything is synthetic and lives in temp directories: a fake user home, a fake wasitme home
 * and synthetic agent roots. The real ~/.claude, ~/.codex and ~/.wasitme are never read: the readers are pointed at
 * the temp roots through WASITME_CLAUDE_DIR / WASITME_CODEX_DIR, and the config collector gets an explicit home and env.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runScan, type ScanOptions, type ScanReport } from "../../src/store/scan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository root (engine/dist/test/store → up four). */
export const REPO = join(HERE, "..", "..", "..", "..");
export const TESTDATA = join(REPO, "testdata");

export interface TempEnv {
  root: string;
  /** Fake user home. */
  home: string;
  /** WASITME_HOME. */
  wh: string;
  claude: string;
  codex: string;
  cleanup(): void;
}

export function tempEnv(name = "store"): TempEnv {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `wasitme-${name}-`)));
  const env: TempEnv = {
    root,
    home: join(root, "home"),
    wh: join(root, "home", ".wasitme"),
    claude: join(root, "agents", "claude"),
    codex: join(root, "agents", "codex"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  for (const d of [env.home, env.claude, env.codex]) mkdirSync(d, { recursive: true });
  return env;
}

/** Copy a committed synthetic corpus (claude/ + codex/) into the env's agent roots. */
export function copyCorpus(env: TempEnv, corpus: string): void {
  if (existsSync(join(corpus, "claude"))) cpSync(join(corpus, "claude"), env.claude, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  if (existsSync(join(corpus, "codex"))) cpSync(join(corpus, "codex"), env.codex, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
}

const SAVED = ["WASITME_CLAUDE_DIR", "WASITME_CODEX_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "WASITME_HOME", "WASITME_TZ"] as const;

/** Run `fn` with the readers pointed at the env's roots (and every agent env var saved/restored). */
export async function inEnv<T>(env: TempEnv, fn: () => Promise<T>): Promise<T> {
  const prev = new Map(SAVED.map((k) => [k, process.env[k]]));
  process.env.WASITME_CLAUDE_DIR = env.claude;
  process.env.WASITME_CODEX_DIR = env.codex;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  process.env.WASITME_HOME = env.wh;
  try {
    return await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export const T0 = new Date("2026-07-08T12:00:00Z");

/**
 * A TEST-ONLY calibration artifact (never shipped): the shape WP-23 writes, saying both agents passed under the voting
 * construct in force with the `session-t95-cr2` estimator. Its rates are distinct and non-zero (the shipped artifact,
 * calflags.ts, has 1,000 sequences per profile and 0 false "changed"/"agent"), so tests that pass it as
 * `ScanOptions.calibration` can see the pooling arithmetic and tell it from the shipped one.
 */
export const TEST_CALIBRATION = Object.freeze({
  formatVersion: 1, kind: "wasitme-calibration", synthetic: true, status: "complete", date: "2026-10-01",
  selection: { chosen: "session-t95-cr2" },
  calibrated: {
    "claude-code": { calibrated: true, byConstruct: { toolErrorsNonCmd: true } },
    codex: { calibrated: true, byConstruct: { toolErrorsNonCmd: true } },
  },
  gNullSeq: [
    { profile: "p1", agent: "claude-code", candidate: "session-t95-cr2", errorsVote: "toolErrorsNonCmd", sequences: 1000, falseChanged: { k: 31, n: 1000 }, falseAgent: { k: 6, n: 1000 } },
    { profile: "p2", agent: "claude-code", candidate: "session-t95-cr2", errorsVote: "toolErrorsNonCmd", sequences: 1000, falseChanged: { k: 29, n: 1000 }, falseAgent: { k: 4, n: 1000 } },
    { profile: "cx", agent: "codex", candidate: "session-t95-cr2", errorsVote: "toolErrorsNonCmd", sequences: 1000, falseChanged: { k: 40, n: 1000 }, falseAgent: null },
  ],
});

/**
 * A TEST-ONLY calibration artifact that passed NO agent: a dated, complete record in which no estimator was chosen
 * (the reduced 20-sequence run that was shipped until 2026-10-05, D58). Passed as `ScanOptions.calibration` it puts every
 * agent on decision-table row 1 (`insufficient (calibration_pending)`, "Timeline only") — the uncalibrated path, which
 * the shipped artifact no longer takes. It stays the way to test that path through the scan.
 */
export const TEST_UNCALIBRATED = Object.freeze({
  formatVersion: 1, kind: "wasitme-calibration", synthetic: true, status: "complete", date: "2026-10-04",
  selection: { chosen: null },
  calibrated: {
    "claude-code": { calibrated: false, byConstruct: { toolErrorsNonCmd: false } },
    codex: { calibrated: false, byConstruct: { toolErrorsNonCmd: false } },
  },
  gNullSeq: [
    { profile: "p1", agent: "claude-code", candidate: "session-t95-cr2", errorsVote: "toolErrorsNonCmd", sequences: 20, falseChanged: { k: 0, n: 20 }, falseAgent: { k: 0, n: 20 } },
    { profile: "cx", agent: "codex", candidate: "session-t95-cr2", errorsVote: "toolErrorsNonCmd", sequences: 20, falseChanged: { k: 0, n: 20 }, falseAgent: { k: 0, n: 20 } },
  ],
});

/** One scan in the env (UTC, injected now, no permission probe, fast bootstrap). */
export function scanIn(env: TempEnv, o: ScanOptions = {}): Promise<ScanReport> {
  return inEnv(env, () => runScan({
    home: env.wh,
    userHome: env.home,
    env: { WASITME_CLAUDE_DIR: env.claude, WASITME_CODEX_DIR: env.codex },
    now: T0,
    timeZone: "UTC",
    recordPermission: false,
    resamples: 200,
    ...o,
  }));
}

/** relative path → sha256 of every file under `dir` (symlinks noted, never followed). */
export function treeDigest(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isSymbolicLink()) out.set(relative(dir, p), "symlink");
      else out.set(relative(dir, p), createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

export function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** All files of the wasitme home with their mode bits. */
export function modes(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (d: string): void => {
    out.set(relative(dir, d) || ".", lstatSync(d).mode & 0o777);
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(relative(dir, p), st.mode & 0o777);
    }
  };
  walk(dir);
  return out;
}
