/**
 * Shared harness for the black-box Claude Code reader acceptance tests (engine/test/acceptance/claude*.test.ts).
 *
 * IMPORT THIS BEFORE the reader module: evaluating it points every plausible Claude root at the synthetic
 * fixture tree (WASITME_CLAUDE_DIR, CLAUDE_CONFIG_DIR) and HOME at an empty temp dir, so a reader that
 * resolves its root at module load — or ignores the env vars — can never touch the real ~/.claude.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exchange, ParseContext, ParseResult, Reader, Source } from "../../../../src/types.js";
import { makeHash } from "../../../../src/util.js";
import { FIXTURE_DIR, SCENARIOS, type ScenarioName } from "./build-fixtures.js";

export { FIXTURE_DIR };
export const CLAUDE_HOME = join(FIXTURE_DIR, "home");
export const PROJECTS_DIR = join(CLAUDE_HOME, "projects");

const fakeHome = mkdtempSync(join(tmpdir(), "wasitme-acceptance-home-"));
process.env.WASITME_CLAUDE_DIR = CLAUDE_HOME;
process.env.CLAUDE_CONFIG_DIR = CLAUDE_HOME;
process.env.HOME = fakeHome;
process.on("exit", () => { try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Fixed scan time for every test. */
export const NOW = new Date("2026-10-04T12:00:00Z");

export function makeCtx(o: { salt?: string; timeZone?: string } = {}): ParseContext {
  return { hash: makeHash(o.salt ?? "test-salt"), now: NOW, timeZone: o.timeZone ?? "UTC" };
}

export function mainPath(name: ScenarioName): string {
  const s = SCENARIOS[name];
  return join(PROJECTS_DIR, s.project, `${s.session}.jsonl`);
}

export function real(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** The one listed source that contains `name`'s main session file (no assumption about files[0] or list order). */
export function findSource(sources: Source[], name: ScenarioName): Source {
  const want = real(mainPath(name));
  const hits = sources.filter((s) => s.files.some((f) => real(f.path) === want));
  assert.equal(hits.length, 1, `expected exactly one listed source containing ${name}'s main file, found ${hits.length}`);
  return hits[0]!;
}

const memo = new Map<ScenarioName, Promise<ParseResult>>();

/**
 * Parse a scenario once per test process with the default ctx. Tests share this so that a reader with
 * hidden cross-call state shows up as one clearly-named idempotence failure, not a cascade.
 */
export function parseScenario(reader: Reader, name: ScenarioName): Promise<ParseResult> {
  let p = memo.get(name);
  if (!p) {
    p = reader.parse(findSource(reader.list(), name), makeCtx());
    memo.set(name, p);
  }
  return p;
}

/** Exchanges ordered by `seq` (file order per the contract). */
export function bySeq(r: ParseResult): Exchange[] {
  return [...r.exchanges].sort((a, b) => a.seq - b.seq);
}

/** Assert several fields at once; reports every mismatch with the exchange label. */
export function expectFields(actual: object, expected: Record<string, unknown>, label: string): void {
  const got = actual as Record<string, unknown>;
  const bad: string[] = [];
  for (const [k, v] of Object.entries(expected)) {
    try { assert.deepStrictEqual(got[k], v); } catch { bad.push(`${label}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got[k])}`); }
  }
  assert.equal(bad.length, 0, bad.join("\n"));
}

export function oneOf(actual: unknown, allowed: unknown[], label: string): void {
  assert.ok(allowed.some((a) => Object.is(a, actual)), `${label}: expected one of ${JSON.stringify(allowed)}, got ${JSON.stringify(actual)}`);
}

export function total(xs: Exchange[], k: keyof Exchange): number {
  return xs.reduce((n, x) => n + (x[k] as number), 0);
}

/** Every field of the Exchange contract (engine/src/types.ts), in declaration order. */
export const EXCHANGE_KEYS = [
  "v", "agent", "id", "session", "project", "t", "day", "version", "model", "servedModel", "effort", "mode", "entrypoint",
  "interactiveClass", "seq", "afterCompaction", "promptChars", "humanPrompt", "promptEnglish", "interrupted", "pushback", "queuedMidTurn", "steps", "toolCalls",
  "toolErrors", "toolErrorsEdit", "toolErrorsCmd", "cmdCalls", "rejections", "blocked", "reads", "edits", "blindEdits", "churned", "outTok", "inTok", "cacheRead",
  "cacheWrite", "apiErrors", "apiRetries", "compactions", "thinkBlocks", "thinkRedacted", "thinkSigMedian", "subToolCalls",
  "subTokens", "subReads", "subEdits", "subBlindEdits", "durationMs",
] as const;

/** Salted-HMAC id as produced by HashFn: short lowercase prefix + 12 hex chars ("s-", "p-", "x-", …). */
export const HASH_ID = /^[a-z]{1,3}-[0-9a-f]{12}$/;

/** Parse every line of a fixture file that is a JSON object (skips damaged lines). */
export function fixtureRecords(path: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const v: unknown = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch { /* damaged or truncated on purpose */ }
  }
  return out;
}
