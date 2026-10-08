/**
 * Self-checks for the Codex acceptance fixtures (no reader involved):
 *  - the committed tree is exactly what generate.mjs produces (no hand edits, no drift);
 *  - the premises the acceptance expectations rest on actually hold in the files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanTime } from "../../src/util.js";
import { isPushback } from "../../src/pushback.js";
import { isNearDuplicate } from "../../src/similarity.js";

function fixtureDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "test", "fixtures", "acceptance", "codex");
    if (existsSync(join(candidate, "generate.mjs"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error("Codex acceptance fixtures not found");
}

const FIXTURE = fixtureDir();
const HOME = join(FIXTURE, "home");
const NOW = new Date("2026-10-04T12:00:00Z");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

const rollouts = () => walk(HOME).filter((p) => /\/rollout-[^/]*\.jsonl$/.test(p));
const read = (p: string) => readFileSync(p, "utf8");
const byThread = (n: number) => {
  const h = n.toString(16).padStart(4, "0");
  const hit = rollouts().find((p) => p.includes(`/sessions/`) && p.endsWith(`-0199f2c4-${h}-7a1e-8b3d-5c0d${h}0f1e.jsonl`));
  assert.ok(hit, `fixture thread ${n} missing`);
  return hit;
};

test("committed fixture tree matches generate.mjs byte for byte", async () => {
  const gen = (await import(pathToFileURL(join(FIXTURE, "generate.mjs")).href)) as { build(): Record<string, string> };
  const expected = gen.build();
  const actual = walk(HOME).map((p) => relative(HOME, p).split("\\").join("/")).sort();
  assert.deepEqual(actual, Object.keys(expected).sort(), "file set (run `node generate.mjs` in the fixture dir)");
  for (const [rel, text] of Object.entries(expected)) assert.equal(read(join(HOME, rel)), text, `${rel} is stale`);
});

test("every line is a JSON object except the planted malformed lines and the truncated tail", () => {
  for (const p of rollouts()) {
    const text = read(p);
    if (p.includes("-000e-")) { assert.equal(text, "", "empty rollout"); continue; }
    const lines = text.split("\n");
    const live = p.includes("-000c-");
    if (live) assert.ok(!text.endsWith("\n"), "live rollout ends mid-line");
    else assert.equal(lines.pop(), "", "file ends with a newline");
    let bad = 0;
    lines.forEach((l, i) => {
      try {
        const v: unknown = JSON.parse(l);
        if (!v || typeof v !== "object" || Array.isArray(v)) bad++;
      } catch {
        if (live && i === lines.length - 1) return; // truncated tail
        bad++;
      }
    });
    assert.equal(bad, p.includes("-000a-") ? 3 : 0, `malformed lines in ${relative(HOME, p)}`);
  }
});

test("raw U+2028/U+2029 sit inside JSON strings of the messy rollout (split-on-\\n only)", () => {
  const text = read(byThread(10));
  assert.ok(text.includes("\u2028") && text.includes("\u2029"));
  assert.equal(text.split("\n").filter((l) => l.includes("\u2028")).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), true);
});

test("timestamps: exactly two out of range (both in the messy rollout); the clock goes backward there", () => {
  let badCount = 0;
  for (const p of rollouts()) {
    for (const l of read(p).split("\n")) {
      let r: { timestamp?: unknown } | undefined;
      try { r = JSON.parse(l) as { timestamp?: unknown }; } catch { continue; }
      if (!r || typeof r !== "object" || Array.isArray(r)) continue;
      if (cleanTime(r.timestamp, NOW) === undefined) {
        badCount++;
        assert.ok(p.includes("-000a-"), `unexpected bad timestamp in ${relative(HOME, p)}`);
      }
    }
  }
  assert.equal(badCount, 2);
});

test("archived duplicate is byte-identical to the live copy; stray files exist to be ignored", () => {
  const live = byThread(8);
  const archived = join(HOME, "archived_sessions", live.split("/").pop()!);
  assert.equal(read(archived), read(live));
  assert.ok(existsSync(join(HOME, "history.jsonl")));
  assert.ok(existsSync(join(HOME, "sessions", "2026", "10", "01", "notes.txt")));
});

test("prompt premises: pushback phrases and near-duplicates are what the expectations assume", () => {
  // [previous real prompt in the session, prompt, expected pushback]
  const cases: Array<[string | undefined, string, 0 | 1]> = [
    [undefined, "Add input validation to the signup form PROMPT-CANARY-A1", 0],
    ["Add input validation to the signup form PROMPT-CANARY-A1", "No, the email check should also reject plus-addresses PROMPT-CANARY-A2", 1],
    ["No, the email check should also reject plus-addresses PROMPT-CANARY-A2", "Now add tests for the email rules PROMPT-CANARY-A3", 0],
    ["Now add tests for the email rules PROMPT-CANARY-A3", "Now add more tests for the email rules PROMPT-CANARY-A3", 1],
    ["Now add more tests for the email rules PROMPT-CANARY-A3", "Refactor the validators into a module PROMPT-CANARY-A5", 0],
    ["Refactor the validators into a module PROMPT-CANARY-A5", "Continue but keep the old exports PROMPT-CANARY-A6", 0],
    [undefined, "Fix the README build badge and lint errors PROMPT-CANARY-D1", 0],
    ["Fix the README build badge and lint errors PROMPT-CANARY-D1", "It still doesn't work when the list is empty PROMPT-CANARY-D2", 1],
    ["It still doesn't work when the list is empty PROMPT-CANARY-D2", "Also handle null entries PROMPT-CANARY-D3", 0],
    [undefined, "Try a different approach using a Set PROMPT-CANARY-E1", 0],
    ["It still doesn't work when the list is empty PROMPT-CANARY-D2", "Try a different approach using a Set PROMPT-CANARY-E1", 0],
    ["Explain the cache layer PROMPT-CANARY-F1", "Make the cache TTL configurable PROMPT-CANARY-F2", 0],
    ["Make the cache TTL configurable PROMPT-CANARY-F2", "Thanks, now update the README PROMPT-CANARY-F3", 0],
    ["Now wire the lint step into CI PROMPT-CANARY-IMPORT-3", "Pick up where the imported session left off PROMPT-CANARY-I4", 0],
    ["Rename the helper\u2028then update the docs\u2029PROMPT-CANARY-J1", "Why did you rename the public API PROMPT-CANARY-J2", 1],
    ["Why did you rename the public API PROMPT-CANARY-J2", "Thanks PROMPT-CANARY-J3 looks good", 0],
    [undefined, "Fix the failing lint job PROMPT-CANARY-K2", 0],
    ["Migrate the config loader to TOML PROMPT-CANARY-M1", "Add a deprecation warning for JSON configs PROMPT-CANARY-M2", 0],
    ["also keep JSON support for one release PROMPT-CANARY-M1-STEER", "Add a deprecation warning for JSON configs PROMPT-CANARY-M2", 0],
  ];
  for (const [prev, prompt, want] of cases) {
    const got = isPushback(prompt) || isNearDuplicate(prev, prompt) ? 1 : 0;
    assert.equal(got, want, `pushback premise for ${JSON.stringify(prompt)}`);
  }
  // The A4 case is pushback by similarity alone, not by phrase.
  assert.equal(isPushback("Now add more tests for the email rules PROMPT-CANARY-A3"), false);
});

test("every cwd and path in the fixtures is synthetic", () => {
  for (const p of walk(HOME)) {
    const text = read(p);
    for (const m of text.matchAll(/\/Users\/[^/"\s\\]+/g)) assert.equal(m[0], "/Users/synthetic-dev", `non-synthetic home in ${relative(HOME, p)}`);
  }
});
