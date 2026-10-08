/**
 * "100% synthetic", proven rather than assumed: all prose comes from a closed bank; nothing from the
 * machine running the generator (home, user, host, cwd) appears in any output; no secret-shaped
 * strings or e-mail addresses in the scenario corpora; the generator's source cannot reach real logs,
 * the clock, the environment or the network. Plus: the planted pushback texts really are what the
 * shared heuristics call pushback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate, type Generated } from "../src/synth/generate.js";
import { generateHostile } from "../src/synth/hostile.js";
import { Rng } from "../src/synth/rng.js";
import { findScenario } from "../src/synth/scenarios.js";
import * as V from "../src/synth/vocab.js";
import { isPushback } from "../src/pushback.js";
import { isNearDuplicate } from "../src/similarity.js";

const SRC = fileURLToPath(new URL("../../src/synth/", import.meta.url));

const cache = new Map<string, Generated>();
function gen(name: string): Generated {
  let g = cache.get(name);
  if (!g) { g = generate(findScenario(name)!.build({}), name); cache.set(name, g); }
  return g;
}

function* walkStrings(v: unknown, key = ""): Generator<[string, string]> {
  if (typeof v === "string") {
    const t = v.trimStart();
    if (t.startsWith("{") || t.startsWith("[")) {
      try { yield* walkStrings(JSON.parse(v), key); return; } catch { /* plain text */ }
    }
    yield [key, v];
  } else if (Array.isArray(v)) for (const x of v) yield* walkStrings(x, key);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) yield* walkStrings(x, k);
}

const STRUCTURAL_KEYS = new Set(["osVersion"]);

test("all prose in the scenario corpora is built from the closed text bank (vocab.ts)", () => {
  const vocab = V.vocabularyWords();
  const unknown = new Map<string, number>();
  let checked = 0;
  for (const name of ["tiny-both", "both-agents", "confounded-same-week"]) {
    for (const f of gen(name).files) {
      if (!f.path.endsWith(".jsonl") || f.path.startsWith("synth-")) continue;
      for (const line of String(f.data).split("\n")) {
        if (!line) continue;
        for (const [key, s] of walkStrings(JSON.parse(line))) {
          if (!/\s/.test(s) || STRUCTURAL_KEYS.has(key)) continue;
          checked++;
          const prose = s.replace(/\/Users\/syn-user\/[^\s"'<>,]*/g, " ").replace(/[A-Za-z0-9+/=_-]{40,}/g, " ");
          for (const w of prose.toLowerCase().match(/[a-z]+/g) ?? []) {
            if (/^[a-f]{1,8}$/.test(w)) continue; // fragments of hex ids (task ids, request ids) split by digits
            if (!vocab.has(w)) unknown.set(w, (unknown.get(w) ?? 0) + 1);
          }
        }
      }
    }
  }
  assert.ok(checked > 20_000, `${checked} prose strings checked`);
  assert.deepEqual([...unknown.entries()].slice(0, 20), [], "words outside the bank");
});

test("every path-like string points into the synthetic user's tree; nothing names a real machine", () => {
  const needles = new Set<string>();
  const add = (s: string | undefined): void => { if (s && s.length >= 4 && !["root", "user", "admin", "tmp", "private"].includes(s.toLowerCase())) needles.add(s); };
  add(homedir());
  add(userInfo().username);
  add(hostname());
  add(hostname().split(".")[0]);
  add(process.env.USER);
  add(process.env.LOGNAME);
  add(process.cwd());
  add(tmpdir());
  add(fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, ""));
  assert.ok(needles.size >= 3);

  const corpora: string[] = [];
  for (const name of ["tiny-both", "both-agents"]) for (const f of gen(name).files) corpora.push(String(f.data));
  const h = generateHostile("small");
  for (const f of h.files) corpora.push(Buffer.from(f.data).toString("utf8"));
  const big = corpora.join("\n");
  for (const n of needles) assert.ok(!big.includes(n), `output contains a machine-specific string: ${n.slice(0, 3)}...`);

  const roots = new Set<string>();
  for (const m of big.matchAll(/\/Users\/([^/"\\\s]+)/g)) roots.add(m[1]!);
  assert.deepEqual([...roots].sort(), ["syn-user"], "the only home directory that ever appears is the synthetic one");
  assert.doesNotMatch(big, /\/home\/|\/var\/folders|\/private\/|C:\\\\/, "no other path roots");
});

test("scenario corpora contain no secret-shaped strings, no e-mail addresses and no canaries", () => {
  const patterns = [/sk-ant-[A-Za-z0-9_-]{10,}/, /sk-proj-[A-Za-z0-9_-]{10,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/, /SYNTHCANARY/i];
  for (const name of ["tiny-both", "both-agents", "null-few-long"]) {
    for (const f of gen(name).files) {
      const text = String(f.data);
      for (const re of patterns) assert.doesNotMatch(text, re, `${name}/${f.path} matches ${re}`);
    }
  }
});

test("the generator's source cannot read real logs, the clock, the environment, other modules' contracts or the network", () => {
  const forbidden: [RegExp, string][] = [
    [/\bhomedir\b/, "home directory"], [/\buserInfo\b/, "user info"], [/\bprocess\.env\b/, "environment"], [/Math\.random/, "unseeded randomness"],
    [/Date\.now/, "the clock"], [/new Date\(\)/, "the clock"], [/randomUUID|randomBytes|randomInt|getRandomValues/, "OS randomness"],
    [/from "node:(http|https|http2|net|dns|tls|dgram|child_process|worker_threads|cluster|inspector)"/, "network or process APIs"],
    [/\bfetch\(|XMLHttpRequest|WebSocket/, "network"], [/process\.env|WASITME_CLAUDE_DIR|WASITME_CODEX_DIR/, "environment overrides for real-log locations"],
    [/~\/\.(claude|codex)/, "real-log paths"], [/\.(claude|codex)\/(projects|sessions)/, "real-log paths"],
    [/from "\.\.?\/types\.js"/, "the engine contract (the generator writes raw logs, not Exchanges)"],
  ];
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 15);
  for (const f of files) {
    // Comments may name what the code avoids ("no Math.random"); only code is checked.
    const text = readFileSync(join(SRC, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const [re, why] of forbidden) assert.doesNotMatch(text, re, `${f} references ${why}`);
  }
});

test("pushback prompts are exactly what the shared heuristics call pushback; ordinary and queued prompts never are", () => {
  const rng = new Rng(5, "heuristics");
  for (const t of V.PUSHBACKS) {
    for (let i = 0; i < 50; i++) {
      const cont = V.fill(rng.pick(V.PUSHBACK_CONTINUATIONS), rng);
      const text = V.fill(t, rng, { cont });
      assert.ok(isPushback(text), text);
    }
  }
  for (const t of V.PROMPTS) {
    for (let i = 0; i < 50; i++) {
      const text = V.fill(t, rng) + (rng.chance(0.4) ? " " + V.fill(rng.pick(V.PROMPT_TAILS), rng) : "");
      assert.ok(!isPushback(text), text);
      assert.ok(text.length >= 40, `prompt long enough for the near-duplicate guard: ${text}`);
    }
  }
  for (const t of V.QUEUED) for (let i = 0; i < 50; i++) assert.ok(!isPushback(V.fill(t, rng)));
  // Near-duplicate re-sends are near-duplicates; different templates are not (the planner never repeats a template back to back).
  let dup = 0;
  let falseDup = 0;
  for (let i = 0; i < 3000; i++) {
    const a = V.fill(V.PROMPTS[rng.int(0, V.PROMPTS.length - 1)]!, rng) + (rng.chance(0.4) ? " " + V.fill(rng.pick(V.PROMPT_TAILS), rng) : "");
    const resend = a.replace(/[.?!]+$/, "") + rng.pick(V.DUPLICATE_SUFFIXES);
    if (isNearDuplicate(a, resend)) dup++;
    const ia = rng.int(0, V.PROMPTS.length - 1);
    const ib = (ia + 1 + rng.int(0, V.PROMPTS.length - 2)) % V.PROMPTS.length;
    const x = V.fill(V.PROMPTS[ia]!, rng) + (rng.chance(0.4) ? " " + V.fill(rng.pick(V.PROMPT_TAILS), rng) : "");
    const y = V.fill(V.PROMPTS[ib]!, rng) + (rng.chance(0.4) ? " " + V.fill(rng.pick(V.PROMPT_TAILS), rng) : "");
    if (isNearDuplicate(x, y)) falseDup++;
  }
  assert.equal(dup, 3000, "every planted re-send is a near-duplicate");
  assert.equal(falseDup, 0, "different templates are never near-duplicates");
});
