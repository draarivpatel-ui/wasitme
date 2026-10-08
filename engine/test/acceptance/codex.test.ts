/**
 * Black-box acceptance tests for the Codex reader.
 *
 * Written from the contract (src/types.ts) and docs/research/05–07 only — never from the reader's
 * implementation. Fixtures are 100% synthetic (see test/fixtures/acceptance/codex/README.md, which
 * also lists the expected values below with the contract line or research item each one rests on).
 */
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { codexReader } from "../../src/readers/codex.js";
import { cleanLabel, makeHash } from "../../src/util.js";
import type { ChangeEvent, Exchange, ParseContext, ParseResult, Source } from "../../src/types.js";

// -------------------------------------------------------------------------------------------------
// Fixture location + environment. The root guard below runs before ANY list()/parse() call, so a
// reader that ignores WASITME_CODEX_DIR can never scan the developer's real ~/.codex.
// -------------------------------------------------------------------------------------------------

function fixtureDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "test", "fixtures", "acceptance", "codex");
    if (existsSync(join(candidate, "home", "sessions"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error("Codex acceptance fixtures not found (expected engine/test/fixtures/acceptance/codex/home)");
}

const HOME = join(fixtureDir(), "home");
process.env.WASITME_CODEX_DIR = HOME;

const CTX: ParseContext = { hash: makeHash("test-salt"), now: new Date("2026-10-04T12:00:00Z"), timeZone: "UTC" };

/** Fixture rollouts by scenario (basenames; the tree is documented in the fixture README). */
const F = {
  main: "rollout-2026-09-27T14-00-00-0199f2c4-0001-7a1e-8b3d-5c0d00010f1e.jsonl",
  sub: "rollout-2026-09-27T14-05-31-0199f2c4-0002-7a1e-8b3d-5c0d00020f1e.jsonl",
  subFork: "rollout-2026-09-27T14-25-00-0199f2c4-0003-7a1e-8b3d-5c0d00030f1e.jsonl",
  legacy: "rollout-2026-09-28T10-00-00-0199f2c4-0004-7a1e-8b3d-5c0d00040f1e.jsonl",
  legacyFork: "rollout-2026-09-28T11-00-00-0199f2c4-0005-7a1e-8b3d-5c0d00050f1e.jsonl",
  migrated: "rollout-2026-09-29T16-00-00-0199f2c4-0006-7a1e-8b3d-5c0d00060f1e.jsonl",
  historyBase: "rollout-2026-09-30T09-00-00-0199f2c4-0007-7a1e-8b3d-5c0d00070f1e.jsonl",
  exec: "rollout-2026-10-01T06-00-00-0199f2c4-0008-7a1e-8b3d-5c0d00080f1e.jsonl",
  imported: "rollout-2026-10-01T08-00-00-0199f2c4-0009-7a1e-8b3d-5c0d00090f1e.jsonl",
  messy: "rollout-2026-10-02T14-59-50-0199f2c4-000a-7a1e-8b3d-5c0d000a0f1e.jsonl",
  automation: "rollout-2026-10-03T07-00-00-0199f2c4-000b-7a1e-8b3d-5c0d000b0f1e.jsonl",
  steering: "rollout-2026-10-03T13-00-00-0199f2c4-000f-7a1e-8b3d-5c0d000f0f1e.jsonl",
  relative: "rollout-2026-10-03T16-00-00-0199f2c4-0010-7a1e-8b3d-5c0d00100f1e.jsonl",
  live: "rollout-2026-10-04T11-00-00-0199f2c4-000c-7a1e-8b3d-5c0d000c0f1e.jsonl",
  empty: "rollout-2026-10-04T11-30-00-0199f2c4-000e-7a1e-8b3d-5c0d000e0f1e.jsonl",
  archivedOnly: "rollout-2026-09-20T18-00-00-0199f2c4-000d-7a1e-8b3d-5c0d000d0f1e.jsonl",
} as const;
type Scenario = keyof typeof F;

let SOURCES: Source[] = [];
const RESULTS = new Map<Scenario, ParseResult>();
const FAILURES = new Map<Scenario, unknown>();

before(async () => {
  assert.equal(
    resolve(codexReader.root()),
    resolve(HOME),
    "codexReader.root() must honour WASITME_CODEX_DIR at call time; aborting before list()/parse() so real logs are never read",
  );
  assert.equal(codexReader.agent, "codex");
  SOURCES = codexReader.list();
  // root() alone is not enough: list() is what walks the disk. Abort (message without paths) before
  // anything outside the fixture tree can be parsed or printed in a failure diff.
  assert.ok(
    SOURCES.every((s) => s.files.every((f) => resolve(f.path).startsWith(resolve(HOME) + sep))),
    "list() returned files outside WASITME_CODEX_DIR; aborting before anything is parsed or printed",
  );
  // Parse each scenario independently so one failure is reported where it belongs.
  for (const name of Object.keys(F) as Scenario[]) {
    try {
      RESULTS.set(name, await codexReader.parse(sourceOf(name), CTX));
    } catch (err) {
      FAILURES.set(name, err);
    }
  }
});

function sourceOf(name: Scenario): Source {
  const hits = SOURCES.filter((s) => s.files.some((f) => basename(f.path) === F[name]));
  assert.equal(hits.length, 1, `exactly one Source must hold ${name} (${F[name]}); found ${hits.length}`);
  return hits[0]!;
}

function result(name: Scenario): ParseResult {
  if (FAILURES.has(name)) throw FAILURES.get(name);
  const r = RESULTS.get(name);
  assert.ok(r, `no parse result for ${name}`);
  return r;
}

function exchanges(name: Scenario): Exchange[] {
  return [...result(name).exchanges].sort((a, b) => a.seq - b.seq);
}

function allExchanges(): Exchange[] {
  return [...RESULTS.values()].flatMap((r) => r.exchanges);
}

const chars = (s: string) => s.length;

/** Compare only the listed fields, so a failure prints a focused diff. */
function expectFields(e: Exchange | undefined, expected: Partial<Exchange>, label: string): void {
  assert.ok(e, `${label}: exchange missing`);
  const actual: Record<string, unknown> = {};
  for (const k of Object.keys(expected)) actual[k] = (e as unknown as Record<string, unknown>)[k];
  assert.deepEqual(actual, expected, label);
}

/** Every Codex exchange in these fixtures: no rejections/blocks/API errors exist in any fixture. */
const QUIET: Partial<Exchange> = { rejections: 0, blocked: 0, apiErrors: 0, apiRetries: 0 };
/** Every exchange outside the steering fixture: no prompt arrived mid-turn. A duplicate prompt that is
 *  not deduped must not hide as a "queued" prompt either. */
const UNQUEUED: Partial<Exchange> = { ...QUIET, queuedMidTurn: 0 };

// -------------------------------------------------------------------------------------------------
// Discovery
// -------------------------------------------------------------------------------------------------

describe("list()", () => {
  test("one Source per unique rollout basename across sessions/ and archived_sessions/", () => {
    const expected = new Set<string>(Object.values(F));
    const seen = new Map<string, number>();
    for (const s of SOURCES) {
      const names = new Set(s.files.map((f) => basename(f.path)));
      for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
    }
    assert.deepEqual([...seen.keys()].sort(), [...expected].sort(), "listed rollouts (stray notes.txt and root history.jsonl must be ignored)");
    for (const [n, count] of seen) assert.equal(count, 1, `${n} appears in ${count} Sources (archived duplicate must be deduped by basename)`);
    assert.equal(SOURCES.length, 16);
  });

  test("Sources are well-formed: agent, unique relative keys, rollout-*.jsonl files with stamps", () => {
    assert.ok(SOURCES.length > 0, "no sources listed");
    const keys = new Set<string>();
    for (const s of SOURCES) {
      assert.equal(s.agent, "codex");
      assert.ok(s.key && !isAbsolute(s.key), `key must be relative to the agent root: ${s.key}`);
      assert.ok(!keys.has(s.key), `duplicate key ${s.key}`);
      keys.add(s.key);
      assert.ok(s.files.length >= 1);
      for (const f of s.files) {
        assert.match(basename(f.path), /^rollout-.*\.jsonl$/);
        assert.ok(Number.isFinite(f.mtimeMs) && f.size >= 0);
      }
    }
  });

  test("list() is stable across calls", () => {
    assert.ok(SOURCES.length > 0, "no sources listed");
    const again = codexReader.list();
    const norm = (xs: Source[]) => xs.map((s) => s.key).sort();
    assert.deepEqual(norm(again), norm(SOURCES));
  });
});

// -------------------------------------------------------------------------------------------------
// Paginated history (item_completed)
// -------------------------------------------------------------------------------------------------

describe("paginated main session", () => {
  const common = { agent: "codex", humanPrompt: 1, version: "0.160.0", entrypoint: "vscode", mode: "never", queuedMidTurn: 0, ...UNQUEUED } as const;

  test("six exchanges in file order", () => {
    const xs = exchanges("main");
    assert.equal(xs.length, 6);
    assert.deepEqual(xs.map((e) => e.seq), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(xs.map((e) => e.t), [
      "2026-09-27T14:00:05.000Z", "2026-09-27T14:05:00.000Z", "2026-09-27T14:10:00.000Z",
      "2026-09-27T14:20:00.000Z", "2026-09-27T14:30:00.000Z", "2026-09-27T14:32:00.000Z",
    ]);
    for (const e of xs) assert.equal(e.day, "2026-09-27");
  });

  test("A1: reads (read + search), failed command, two edits after a read, deduped token_count", () => {
    expectFields(exchanges("main")[0], {
      ...common, model: "gpt-6-luna", servedModel: "gpt-6-luna", effort: "high",
      promptChars: chars("Add input validation to the signup form PROMPT-CANARY-A1"),
      pushback: 0, interrupted: 0, steps: 7, toolCalls: 6, toolErrors: 1, reads: 2, edits: 2, blindEdits: 0, churned: 0,
      outTok: 2320, inTok: 7600, cacheRead: 89000, cacheWrite: 0, compactions: 0, afterCompaction: false,
    }, "A1");
  });

  test("A2: pushback phrase, MCP ok + failed, blind edit, spawn_agent + wait count as tool calls", () => {
    expectFields(exchanges("main")[1], {
      ...common, model: "gpt-6-luna", effort: "high",
      promptChars: chars("No, the email check should also reject plus-addresses PROMPT-CANARY-A2"),
      pushback: 1, interrupted: 0, steps: 6, toolCalls: 5, toolErrors: 1, reads: 0, edits: 1, blindEdits: 1, churned: 0,
      outTok: 1530, inTok: 3100, cacheRead: 100600, cacheWrite: 0, compactions: 0, afterCompaction: false,
    }, "A2");
  });

  test("A3: compacted + ContextCompaction count once; compaction does not mark its own exchange", () => {
    expectFields(exchanges("main")[2], {
      ...common, model: "gpt-6-luna", effort: "high",
      promptChars: chars("Now add tests for the email rules PROMPT-CANARY-A3"),
      pushback: 0, steps: 4, toolCalls: 3, toolErrors: 0, reads: 1, edits: 1, blindEdits: 0, churned: 0,
      outTok: 1090, inTok: 5400, cacheRead: 33400, cacheWrite: 0, compactions: 1, afterCompaction: false,
    }, "A3");
  });

  test("A4: near-duplicate prompt, new model/effort, churn, read in the previous 10 tool calls, streaming snapshot kept last", () => {
    const e = exchanges("main")[3];
    expectFields(e, {
      ...common, model: "gpt-6.1-sol", servedModel: "gpt-6.1-sol", effort: "xhigh",
      promptChars: chars("Now add more tests for the email rules PROMPT-CANARY-A3"),
      pushback: 1, steps: 4, toolCalls: 3, toolErrors: 0, reads: 0, edits: 3, blindEdits: 0, churned: 1,
      outTok: 1500, cacheRead: 32800, cacheWrite: 1000, compactions: 0, afterCompaction: true,
    }, "A4");
    // input_tokens includes cached tokens (research 05 #16); whether it also includes cache writes is
    // not documented, so both readings are accepted.
    assert.ok([2500, 1500].includes(e!.inTok), `A4 inTok ${e!.inTok} ∉ {2500, 1500}`);
  });

  test("A5: turn_aborted(interrupted) marks the exchange; the injected <turn_aborted> message is not a prompt", () => {
    expectFields(exchanges("main")[4], {
      ...common, model: "gpt-6.1-sol", effort: "xhigh",
      promptChars: chars("Refactor the validators into a module PROMPT-CANARY-A5"),
      pushback: 0, interrupted: 1, steps: 1, toolCalls: 1, toolErrors: 0, reads: 1, edits: 0, blindEdits: 0,
      outTok: 120, inTok: 500, cacheRead: 9500, cacheWrite: 0, afterCompaction: true,
    }, "A5");
  });

  test("A6: plain follow-up after an interrupt; duration is the wall-clock span", () => {
    expectFields(exchanges("main")[5], {
      ...common, model: "gpt-6.1-sol", effort: "xhigh",
      promptChars: chars("Continue but keep the old exports PROMPT-CANARY-A6"),
      pushback: 0, interrupted: 0, steps: 1, toolCalls: 0, outTok: 80, inTok: 500, cacheRead: 10000,
      afterCompaction: true, durationMs: 10000,
    }, "A6");
  });

  test("durations are bounded by the turn and the next prompt", () => {
    const xs = exchanges("main");
    // [turn span, gap to next prompt]: either attribution of the next turn's leading records is fine.
    const bounds: Array<[number, number]> = [[55000, 295000], [120000, 300000], [120000, 600000], [60000, 600000], [20000, 120000]];
    bounds.forEach(([lo, hi], i) => {
      const d = xs[i]!.durationMs;
      assert.ok(d >= lo && d <= hi, `exchange ${i} durationMs ${d} ∉ [${lo}, ${hi}]`);
    });
  });

  test("model and effort changes are events (once each, with labels and time)", () => {
    const evs = result("main").events;
    const model = evs.filter((e) => e.kind === "model");
    const effort = evs.filter((e) => e.kind === "effort");
    assert.equal(model.length, 1, "one model change");
    assert.equal(effort.length, 1, "one effort change");
    const pick = (e: ChangeEvent) => ({ agent: e.agent, from: e.from, to: e.to, t: e.t, day: e.day, evidence: e.evidence });
    assert.deepEqual(pick(model[0]!), { agent: "codex", from: "gpt-6-luna", to: "gpt-6.1-sol", t: "2026-09-27T14:20:00.000Z", day: "2026-09-27", evidence: "log" });
    assert.deepEqual(pick(effort[0]!), { agent: "codex", from: "high", to: "xhigh", t: "2026-09-27T14:20:00.000Z", day: "2026-09-27", evidence: "log" });
    for (const e of evs) {
      assert.notEqual(e.from, e.to, `event ${e.kind} must be a change`);
      assert.ok(["you", "agent", "unknown", "meta"].includes(e.side));
    }
  });
});

// -------------------------------------------------------------------------------------------------
// Subagents and forks
// -------------------------------------------------------------------------------------------------

describe("subagents and forks", () => {
  test("a subagent thread (parent_thread_id) never creates exchanges", () => {
    assert.equal(result("sub").exchanges.length, 0);
  });

  test("a forked subagent (copied parent session_meta + history, subagent_history_start_ordinal) never creates exchanges", () => {
    assert.equal(result("subFork").exchanges.length, 0);
  });

  test("subagent work does not leak into the parent's main-thread counts", () => {
    const xs = exchanges("main");
    assert.equal(xs.reduce((n, e) => n + e.steps, 0), 23);
    assert.equal(xs.reduce((n, e) => n + e.outTok, 0), 6640);
    for (const e of allExchanges()) {
      if (e === xs[1]) continue; // A2 spawned the subagent: sub* may carry context there
      assert.equal(e.subToolCalls, 0, "subToolCalls outside the spawning exchange");
      assert.equal(e.subTokens, 0, "subTokens outside the spawning exchange");
    }
  });

  test("legacy fork with copied history: only the fork's own turn counts", () => {
    const xs = exchanges("legacyFork");
    assert.equal(xs.length, 1, "copied parent turns (D1, D2) must not be re-counted");
    expectFields(xs[0], {
      agent: "codex", seq: 0, t: "2026-09-28T11:05:00.000Z", day: "2026-09-28", humanPrompt: 1,
      promptChars: chars("Try a different approach using a Set PROMPT-CANARY-E1"),
      version: "0.98.0", model: "gpt-5.6-luna", effort: "medium", mode: "on-request", entrypoint: "cli",
      pushback: 0, interrupted: 0, steps: 3, toolCalls: 2, toolErrors: 0, reads: 1, edits: 1, blindEdits: 0,
      outTok: 640, inTok: 1800, cacheRead: 41500, cacheWrite: 0, durationMs: 60000, ...UNQUEUED,
    }, "E1");
    assert.notEqual(xs[0]!.session, exchanges("legacy")[0]!.session, "a fork is its own session");
    assert.equal(xs[0]!.project, exchanges("legacy")[0]!.project, "same cwd → same project");
  });

  test("history_base child (no copies): its own turn counts once, same project as the parent", () => {
    const xs = exchanges("historyBase");
    assert.equal(xs.length, 1);
    expectFields(xs[0], {
      seq: 0, t: "2026-09-30T09:00:05.000Z", humanPrompt: 1,
      promptChars: chars("Summarize what changed on this branch PROMPT-CANARY-G1"),
      steps: 2, toolCalls: 1, toolErrors: 0, reads: 0, edits: 0, outTok: 700, inTok: 5500, cacheRead: 35000,
      afterCompaction: false, durationMs: 55000, ...UNQUEUED,
    }, "G1");
    assert.equal(xs[0]!.project, exchanges("main")[0]!.project);
    assert.notEqual(xs[0]!.session, exchanges("main")[0]!.session);
  });
});

// -------------------------------------------------------------------------------------------------
// Legacy history and migration
// -------------------------------------------------------------------------------------------------

describe("legacy history (exec_command_end / patch_apply_end / mcp_tool_call_end)", () => {
  const common = { agent: "codex", humanPrompt: 1, version: "0.98.0", model: "gpt-5.6-luna", effort: "medium", mode: "on-request", entrypoint: "cli", ...UNQUEUED } as const;

  test("three exchanges; null-info token_count is not a step; repeated token_count deduped", () => {
    const xs = exchanges("legacy");
    assert.equal(xs.length, 3);
    expectFields(xs[0], {
      ...common, seq: 0, t: "2026-09-28T10:00:05.000Z", promptChars: chars("Fix the README build badge and lint errors PROMPT-CANARY-D1"),
      pushback: 0, interrupted: 0, steps: 6, toolCalls: 5, toolErrors: 2, reads: 1, edits: 1, blindEdits: 0, churned: 0,
      outTok: 1220, inTok: 7200, cacheRead: 54500, cacheWrite: 0,
    }, "D1");
    expectFields(xs[1], {
      ...common, seq: 1, t: "2026-09-28T10:10:00.000Z", promptChars: chars("It still doesn't work when the list is empty PROMPT-CANARY-D2"),
      pushback: 1, interrupted: 0, steps: 4, toolCalls: 3, toolErrors: 1, reads: 1, edits: 1, blindEdits: 0,
      outTok: 1030, inTok: 2000, cacheRead: 48200, cacheWrite: 0,
    }, "D2");
    expectFields(xs[2], {
      ...common, seq: 2, t: "2026-09-28T10:20:00.000Z", promptChars: chars("Also handle null entries PROMPT-CANARY-D3"),
      pushback: 0, interrupted: 1, steps: 1, toolCalls: 1, toolErrors: 0, reads: 1, edits: 0,
      outTok: 80, inTok: 300, cacheRead: 13200, cacheWrite: 0,
    }, "D3");
  });
});

describe("mixed migration duplicates", () => {
  const common = { agent: "codex", humanPrompt: 1, version: "0.150.0", model: "gpt-6-luna", effort: "medium", mode: "never", entrypoint: "vscode", ...UNQUEUED } as const;

  test("legacy-only, doubled and canonical-only turns each count once", () => {
    const xs = exchanges("migrated");
    assert.equal(xs.length, 3, "the doubled user message (item + user_message event) is one prompt");
    expectFields(xs[0], {
      ...common, seq: 0, t: "2026-09-29T16:00:05.000Z", promptChars: chars("Explain the cache layer PROMPT-CANARY-F1"),
      steps: 2, toolCalls: 1, toolErrors: 0, reads: 1, edits: 0, outTok: 500, inTok: 4400, cacheRead: 10000,
    }, "F1 (legacy events, token_count only)");
    expectFields(xs[1], {
      ...common, seq: 1, t: "2026-09-29T16:10:00.000Z", promptChars: chars("Make the cache TTL configurable PROMPT-CANARY-F2"),
      steps: 4, toolCalls: 3, toolErrors: 1, reads: 1, edits: 1, blindEdits: 0, outTok: 930, inTok: 1600, cacheRead: 32700,
    }, "F2 (every record twice)");
    expectFields(xs[2], {
      ...common, seq: 2, t: "2026-09-29T16:20:00.000Z", promptChars: chars("Thanks, now update the README PROMPT-CANARY-F3"),
      pushback: 0, steps: 2, toolCalls: 1, toolErrors: 0, edits: 1, blindEdits: 1, outTok: 500, inTok: 700, cacheRead: 18500,
      durationMs: 40000,
    }, "F3 (canonical only)");
  });

  test("skipped twins are reported as duplicates", () => {
    assert.ok(result("migrated").stats.duplicates >= 1, "ParseStats.duplicates must count skipped migration twins");
  });
});

// -------------------------------------------------------------------------------------------------
// Entry points, imports, automation
// -------------------------------------------------------------------------------------------------

describe("entry points and non-human turns", () => {
  test("codex exec session: one exchange, entrypoint 'exec'; its archived twin is not re-counted", () => {
    const xs = exchanges("exec");
    assert.equal(xs.length, 1);
    expectFields(xs[0], {
      agent: "codex", seq: 0, t: "2026-10-01T06:00:01.000Z", humanPrompt: 1, entrypoint: "exec", model: "gpt-6-luna", effort: "low",
      promptChars: chars("Write a haiku about rust lifetimes PROMPT-CANARY-H1"),
      steps: 1, toolCalls: 0, outTok: 60, inTok: 3000, cacheRead: 0, cacheWrite: 0, durationMs: 9000, ...UNQUEUED,
    }, "H1");
  });

  test("imported external-import-turn-N history (one moment, no turn_context/tokens) creates no exchanges", () => {
    const xs = exchanges("imported");
    assert.equal(xs.length, 1, "only the real turn after the import counts");
    expectFields(xs[0], {
      seq: 0, t: "2026-10-01T08:05:00.000Z", day: "2026-10-01", humanPrompt: 1,
      promptChars: chars("Pick up where the imported session left off PROMPT-CANARY-I4"),
      pushback: 0, steps: 2, toolCalls: 1, reads: 1, outTok: 350, inTok: 9400, cacheRead: 9000, durationMs: 40000, ...UNQUEUED,
    }, "I4");
  });

  test("heartbeat-started session: agent-initiated exchange first; task-notification and scheduled-task turns are absorbed", () => {
    const xs = exchanges("automation");
    assert.equal(xs.length, 2, "<heartbeat>, <task-notification> and <scheduled-task> are not human prompts");
    expectFields(xs[0], {
      seq: 0, t: "2026-10-03T07:00:01.000Z", humanPrompt: 0, promptChars: 0, pushback: 0,
      steps: 2, toolCalls: 1, toolErrors: 0, outTok: 300, inTok: 4300, cacheRead: 4000, ...UNQUEUED,
    }, "K heartbeat stretch");
    expectFields(xs[1], {
      seq: 1, t: "2026-10-03T07:05:00.000Z", humanPrompt: 1, promptChars: chars("Fix the failing lint job PROMPT-CANARY-K2"), pushback: 0,
      steps: 6, toolCalls: 3, toolErrors: 1, reads: 1, edits: 1, blindEdits: 1, outTok: 670, inTok: 1700, cacheRead: 31100,
      durationMs: 1510000, ...UNQUEUED,
    }, "K2 + absorbed K3, K4");
  });

  test("archived-only session is read; list_files counts as a read", () => {
    const xs = exchanges("archivedOnly");
    assert.equal(xs.length, 1);
    expectFields(xs[0], {
      seq: 0, t: "2026-09-20T18:00:05.000Z", version: "0.142.0", humanPrompt: 1,
      steps: 2, toolCalls: 1, reads: 1, outTok: 400, inTok: 2800, cacheRead: 2500, durationMs: 25000, ...UNQUEUED,
    }, "N1");
  });

  test("empty rollout parses to nothing without failing", () => {
    const r = result("empty");
    assert.equal(r.exchanges.length, 0);
    assert.deepEqual(
      { files: r.stats.files, filesFailed: r.stats.filesFailed, badLines: r.stats.badLines, truncatedTail: r.stats.truncatedTail },
      { files: 1, filesFailed: 0, badLines: 0, truncatedTail: 0 },
    );
  });
});

// -------------------------------------------------------------------------------------------------
// Damaged / hostile input
// -------------------------------------------------------------------------------------------------

describe("damaged input", () => {
  test("rollout ending mid-turn with a truncated final line", () => {
    const xs = exchanges("live");
    assert.equal(xs.length, 2);
    expectFields(xs[0], { seq: 0, t: "2026-10-04T11:00:05.000Z", steps: 2, toolCalls: 1, edits: 1, blindEdits: 1, outTok: 600, inTok: 3600, cacheRead: 3000, ...UNQUEUED }, "L1");
    expectFields(xs[1], {
      seq: 1, t: "2026-10-04T11:10:00.000Z", day: "2026-10-04", humanPrompt: 1, interrupted: 0,
      steps: 1, toolCalls: 1, reads: 1, outTok: 90, inTok: 400, cacheRead: 3600, durationMs: 9000, ...UNQUEUED,
    }, "L2 (still running)");
    const s = result("live").stats;
    assert.deepEqual({ truncatedTail: s.truncatedTail, badLines: s.badLines, filesFailed: s.filesFailed }, { truncatedTail: 1, badLines: 0, filesFailed: 0 });
  });

  test("U+2028/U+2029 inside strings, malformed lines, unknown types, out-of-range timestamps", () => {
    const xs = exchanges("messy");
    assert.equal(xs.length, 3);
    expectFields(xs[0], {
      seq: 0, t: "2026-10-02T15:00:00.000Z", model: "gpt-6-luna",
      promptChars: chars("Rename the helper\u2028then update the docs\u2029PROMPT-CANARY-J1"),
      steps: 2, toolCalls: 1, reads: 1, outTok: 250, inTok: 4300, cacheRead: 6000, ...UNQUEUED,
    }, "J1");
    const s = result("messy").stats;
    assert.deepEqual(
      { files: s.files, filesFailed: s.filesFailed, badLines: s.badLines, truncatedTail: s.truncatedTail, badTimestamps: s.badTimestamps },
      { files: 1, filesFailed: 0, badLines: 3, truncatedTail: 0, badTimestamps: 2 },
    );
    // Keys are namespaced by family: "codex:<envelope>" for an unknown envelope, "codex:event_msg:<sub>"
    // for an unknown event sub-kind; a name that is not a clean label collapses to "codex:unrecognised".
    assert.equal(s.unknownTypes["codex:future_record_kind"], 1, "unknown envelope type is counted under its namespaced name");
    assert.equal(s.unknownTypes["codex:event_msg:future_event_kind"], 1, "unknown event_msg sub-kind is counted under its namespaced name");
    assert.equal(s.unknownTypes["codex:unrecognised"], 1, "the path-like envelope type is counted without its raw name");
  });

  test("clock reset backward: seq follows file order, t/day come from each prompt, durations never negative", () => {
    const xs = exchanges("messy");
    assert.deepEqual(xs.map((e) => [e.seq, e.t, e.day]), [
      [0, "2026-10-02T15:00:00.000Z", "2026-10-02"],
      [1, "2026-10-02T09:00:00.000Z", "2026-10-02"],
      [2, "2026-10-02T09:10:00.000Z", "2026-10-02"],
    ]);
    expectFields(xs[1], {
      pushback: 1, promptChars: chars("Why did you rename the public API PROMPT-CANARY-J2"),
      steps: 2, toolCalls: 1, edits: 1, blindEdits: 1, outTok: 210, inTok: 900, cacheRead: 11300,
    }, "J2");
    expectFields(xs[2], { pushback: 0, steps: 1, toolCalls: 0, outTok: 50, inTok: 200, cacheRead: 6200, durationMs: 5000 }, "J3");
    for (const e of xs) assert.ok(e.durationMs >= 0, `durationMs ${e.durationMs} < 0`);
  });

  test("an unsafe model label (ANSI + path) never becomes a label", () => {
    const xs = exchanges("messy");
    for (const e of [xs[1]!, xs[2]!]) {
      assert.ok(["unknown", "other"].includes(e.model), `model label ${JSON.stringify(e.model)}`);
      assert.ok(["unknown", "other"].includes(e.servedModel), `servedModel label ${JSON.stringify(e.servedModel)}`);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// Off the enumerated list, isolated so a disagreement is easy to adjudicate
// -------------------------------------------------------------------------------------------------

describe("steering (a second user message inside a running turn)", () => {
  test("counts as queuedMidTurn, not as a new exchange", () => {
    const xs = exchanges("steering");
    assert.equal(xs.length, 2);
    expectFields(xs[0], {
      seq: 0, humanPrompt: 1, queuedMidTurn: 1, promptChars: chars("Migrate the config loader to TOML PROMPT-CANARY-M1"),
      steps: 3, toolCalls: 2, reads: 1, edits: 1, blindEdits: 0, outTok: 870, inTok: 6000, cacheRead: 16600,
    }, "M1 + steer");
    expectFields(xs[1], {
      seq: 1, humanPrompt: 1, queuedMidTurn: 0, pushback: 0, steps: 2, toolCalls: 1, edits: 1, blindEdits: 0,
      outTok: 390, inTok: 800, cacheRead: 16500,
    }, "M2");
  });
});

describe("relative read paths (92% of real parsed_cmd read paths are relative)", () => {
  test("a read of src/routes.ts covers an edit of <cwd>/src/routes.ts", () => {
    const xs = exchanges("relative");
    assert.equal(xs.length, 1);
    expectFields(xs[0], {
      steps: 4, toolCalls: 3, reads: 1, edits: 2, blindEdits: 1, churned: 0, outTok: 1220, inTok: 5300, cacheRead: 21500,
    }, "R1");
  });
});

// -------------------------------------------------------------------------------------------------
// Cross-cutting invariants
// -------------------------------------------------------------------------------------------------

describe("invariants across every exchange", () => {
  test("every scenario parsed; 27 exchanges in total", () => {
    assert.deepEqual([...FAILURES.keys()], [], "parse() threw for these scenarios");
    assert.equal(allExchanges().length, 27);
  });

  test("shape: labels are clean, counters are non-negative integers, flags are 0/1, day matches t", () => {
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const ints: Array<keyof Exchange> = [
      "seq", "promptChars", "queuedMidTurn", "steps", "toolCalls", "toolErrors", "rejections", "blocked", "reads", "edits",
      "blindEdits", "outTok", "inTok", "cacheRead", "cacheWrite", "apiErrors", "apiRetries", "compactions", "thinkBlocks",
      "thinkRedacted", "subToolCalls", "subTokens", "subReads", "subEdits", "subBlindEdits", "durationMs",
    ];
    assert.ok(allExchanges().length > 0, "no exchanges to check");
    for (const e of allExchanges()) {
      assert.equal(e.v, 1);
      assert.equal(e.agent, "codex");
      assert.match(e.t, ISO);
      assert.equal(e.day, e.t.slice(0, 10), "day in UTC");
      for (const k of ["version", "model", "servedModel", "effort", "mode", "entrypoint"] as const) {
        const v = e[k];
        assert.ok(v === "unknown" || v === "other" || cleanLabel(v) === v, `${k}=${JSON.stringify(v)} is not a clean label`);
      }
      for (const k of ints) {
        const v = e[k] as number;
        assert.ok(Number.isInteger(v) && v >= 0, `${k}=${v}`);
      }
      assert.ok(Number.isFinite(e.thinkSigMedian) && e.thinkSigMedian >= 0);
      for (const k of ["humanPrompt", "interrupted", "pushback", "churned"] as const) assert.ok(e[k] === 0 || e[k] === 1, `${k}=${e[k]}`);
      assert.equal(typeof e.afterCompaction, "boolean");
      assert.ok(e.thinkRedacted <= e.thinkBlocks);
      assert.ok(e.toolErrors <= e.toolCalls && e.reads <= e.toolCalls && e.edits <= e.toolCalls && e.blindEdits <= e.edits);
      assert.equal(e.servedModel, e.model, "Codex logs do not distinguish a served model");
      expectFields(e, QUIET, "no rejections/blocks/API errors in these fixtures");
    }
  });

  test("ids: hashed, unique per exchange, one session per rollout, projects follow cwd", () => {
    const HASHED = /^[a-z]*-?[0-9a-f]{12}$/;
    const all = allExchanges();
    const ids = new Set(all.map((e) => e.id));
    assert.equal(ids.size, all.length, "exchange ids must be unique");
    const sessions = new Set<string>();
    for (const [name, r] of RESULTS) {
      const s = new Set(r.exchanges.map((e) => e.session));
      assert.ok(s.size <= 1, `${name}: one session per rollout`);
      for (const x of s) {
        assert.ok(!sessions.has(x), `${name}: session hash shared with another rollout`);
        sessions.add(x);
      }
    }
    for (const e of all) for (const v of [e.id, e.session, e.project]) assert.match(v, HASHED);
    const project = (n: Scenario) => exchanges(n)[0]!.project;
    const groups: Scenario[][] = [["main", "historyBase"], ["legacy", "legacyFork"], ["migrated", "steering", "archivedOnly"], ["exec", "automation"], ["imported", "live"], ["messy", "relative"]];
    for (const g of groups) for (const n of g) assert.equal(project(n), project(g[0]!), `${n} shares ${g[0]}'s cwd`);
    assert.equal(new Set(groups.map((g) => project(g[0]!))).size, groups.length, "different cwd → different project");
  });

  test("re-parsing gives identical results (ids stable across rescans)", async () => {
    for (const name of Object.keys(F) as Scenario[]) {
      const again = await codexReader.parse(sourceOf(name), CTX);
      assert.deepEqual(again, result(name), `${name} differs on rescan`);
    }
  });

  test("ParseStats are sane for every source", () => {
    assert.equal(RESULTS.size, Object.keys(F).length, "every scenario must have parsed");
    for (const [name, r] of RESULTS) {
      const s = r.stats;
      assert.ok(s.files >= 1, `${name}: files`);
      assert.equal(s.filesFailed, 0, `${name}: filesFailed`);
      for (const k of ["badLines", "truncatedTail", "duplicates", "badTimestamps"] as const) assert.ok(Number.isInteger(s[k]) && s[k] >= 0, `${name}: ${k}`);
      if (name !== "messy") assert.equal(s.badLines, 0, `${name}: badLines`);
      if (name !== "live") assert.equal(s.truncatedTail, 0, `${name}: truncatedTail`);
      if (name !== "messy") assert.equal(s.badTimestamps, 0, `${name}: badTimestamps`);
      const documented = ["session_meta", "turn_context", "event_msg", "response_item", "token_usage_record", "compacted", "world_state", "inter_agent_communication_metadata"];
      for (const k of Object.keys(s.unknownTypes)) {
        assert.ok(k.startsWith("codex:"), `${name}: unknownTypes key is not namespaced: ${JSON.stringify(k)}`);
        assert.equal(cleanLabel(k), k, `${name}: unknownTypes key is not a clean label: ${JSON.stringify(k)}`);
        assert.ok(!documented.some((d) => k === d || k === `codex:${d}`), `${name}: documented type ${k} reported as unknown`);
        assert.ok(!k.includes("/") && !/canary/i.test(k), `${name}: unknownTypes key leaks raw content: ${JSON.stringify(k)}`);
        assert.ok(Number.isInteger(s.unknownTypes[k]) && s.unknownTypes[k]! > 0);
      }
    }
  });
});

// -------------------------------------------------------------------------------------------------
// Privacy
// -------------------------------------------------------------------------------------------------

describe("privacy", () => {
  test("no prompt text, paths, cwd, commands, outputs, secrets or raw ids reach any ParseResult", () => {
    assert.equal(RESULTS.size, Object.keys(F).length, "every scenario must have parsed (a privacy pass on nothing proves nothing)");
    assert.ok(allExchanges().length > 0);
    const out = JSON.stringify([...RESULTS.values()]);
    const forbidden: Array<[string, RegExp]> = [
      ["any planted canary (prompts, outputs, diffs, ids, nicknames, branches, instructions)", /canary/i],
      ["raw thread/turn uuid", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
      ["home directory path", /\/Users\/|synthetic-dev/],
      ["secret: OpenAI key", /sk-live/],
      ["secret: AWS key", /AKIA/],
      ["secret: GitHub token", /ghp_/],
      ["command text", /sed -n|rg -n|npm (test|run)|git diff|gh run/],
      ["file path", /src\/|\.github|README|eslintrc|\.ts\b|\.md\b/],
      ["imported turn id", /external-import/],
      ["ANSI escape", /\u001b|\\u001b/],
      ["line/paragraph separator", /\u2028|\u2029|\\u2028|\\u2029/],
      ["prompt marker", /PROMPT-/],
      ["prompt words", /signup|plus-addresses|haiku|lifetimes|TOML|validators/],
    ];
    for (const [what, re] of forbidden) assert.doesNotMatch(out, re, `ParseResult leaks ${what}`);
  });

  test("events carry only labels or short hashes", () => {
    assert.ok(result("main").events.length > 0, "the main session has model/effort changes");
    for (const [name, r] of RESULTS) {
      for (const e of r.events) {
        for (const v of [e.from, e.to]) {
          assert.ok(v === "unknown" || v === "other" || /^h:[0-9a-f]{8}$/.test(v) || cleanLabel(v) === v, `${name}: event value ${JSON.stringify(v)}`);
        }
        assert.match(e.t, /^\d{4}-\d{2}-\d{2}T/);
      }
    }
  });
});
