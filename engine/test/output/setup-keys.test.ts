/**
 * D80: one set of setup keys. A real scan, `wasitme demo` and the shared contract goldens write each agent's `setup`
 * under exactly the keys in SETUP_KEYS, so the Setup page a user sees is the one the demo and the README show. Before
 * D80 the demo and the goldens wrote `agentVersion` / `instructionsKTokens` while a scan wrote `version` / `instructions`
 * / `instructionsBytes`, and a real Setup page lost its version link. The canvas side (every key labelled) is
 * ui/test/model.test.mjs. Synthetic data only (testdata/seed/tiny-both plus one-line instruction files written here).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SETUP_KEYS } from "../../src/contract/vocab.js";
import { DEMO_CASES, demoOutputs } from "../../src/demo/facts.js";
import { copyCorpus, readJson, REPO, scanIn, TESTDATA, tempEnv } from "../store/helpers.js";

type SetupMap = Record<string, string | number | boolean>;
type AgentDoc = { agent: "claude-code" | "codex"; setup: SetupMap; timeline: { kind: string; side: string; to: string }[] };

test("setup keys: a real scan writes every SETUP_KEYS key, in order; the demo and the contract goldens write the same keys", async () => {
  const env = tempEnv("setup-keys");
  try {
    copyCorpus(env, join(TESTDATA, "seed", "tiny-both"));
    // Synthetic instruction files, so the size key (written only when the file exists) is written too.
    writeFileSync(join(env.claude, "CLAUDE.md"), "# synthetic instructions\nbe brief\n");
    writeFileSync(join(env.codex, "AGENTS.md"), "# synthetic agents file\n");
    await scanIn(env);
    const real = readJson(join(env.wh, "snapshot.json")).agents as AgentDoc[];
    assert.deepEqual(real.map((a) => a.agent).sort(), ["claude-code", "codex"], "the seed has both agents");
    const scanned = new Map<string, string[]>();
    for (const a of real) {
      assert.deepEqual(Object.keys(a.setup), [...SETUP_KEYS[a.agent]], `${a.agent}: a scan writes every setup key, in SETUP_KEYS order`);
      assert.equal(a.setup.instructions, true, `${a.agent}: the instructions file is seen`);
      assert.equal(typeof a.setup.instructionsBytes, "number", `${a.agent}: its size in bytes`);
      scanned.set(a.agent, Object.keys(a.setup));
    }

    // The demo: the same keys as the real scan of the same agent, for every case.
    for (const name of DEMO_CASES) {
      const a = demoOutputs(name, { engine: "0.1.0" }).snapshot.agents[0]! as unknown as AgentDoc;
      assert.deepEqual(Object.keys(a.setup), scanned.get(a.agent), `demo ${name}: the setup keys a scan writes for ${a.agent}`);
    }

    // The shared goldens every surface is tested against (contract/fixtures/generate.mjs): the same keys again.
    for (const dir of ["snapshot", "tamper"]) {
      for (const f of readdirSync(join(REPO, "contract", "fixtures", dir)).filter((n) => n.endsWith(".json")).sort()) {
        const doc = readJson(join(REPO, "contract", "fixtures", dir, f));
        if (!Array.isArray(doc?.agents)) continue;
        for (const a of doc.agents as AgentDoc[]) {
          if (a?.setup === undefined) continue;
          assert.deepEqual(Object.keys(a.setup), scanned.get(a.agent), `${dir}/${f} ${a.agent}: the setup keys a scan writes`);
          const last = a.timeline.filter((e) => e.kind === "version" && e.side === "agent").at(-1);
          if (last) assert.equal(a.setup.version, last.to, `${dir}/${f} ${a.agent}: the version is the one the timeline last moved to`);
        }
      }
    }
  } finally {
    env.cleanup();
  }
});

test("setup values: what the demo timeline moved shows the value it moved to", () => {
  const kinds: [key: string, kind: string][] = [["version", "version"], ["model", "model"], ["effort", "effort"], ["mcpServers", "mcp"]];
  for (const name of DEMO_CASES) {
    const a = demoOutputs(name, { engine: "0.1.0" }).snapshot.agents[0]! as unknown as AgentDoc;
    for (const [key, kind] of kinds) {
      const last = a.timeline.filter((e) => e.kind === kind).at(-1);
      if (last) assert.equal(String(a.setup[key]), last.to, `${name}: Setup's ${key} is where the timeline's last ${kind} change ended`);
    }
  }
  // Spot checks against the demo data (design/system/demo-data.v3.json): Codex's effort went medium → high, its model to
  // gpt-6-luna; Claude Code's effort went high → medium and its MCP servers 5 → 6.
  const codex = demoOutputs("codex", { engine: "0.1.0" }).snapshot.agents[0]!.setup;
  assert.equal(codex.effort, "high");
  assert.equal(codex.model, "gpt-6-luna");
  const claude = demoOutputs("insufficient", { engine: "0.1.0" }).snapshot.agents[0]!.setup;
  assert.equal(claude.effort, "medium");
  assert.equal(claude.mcpServers, 6);
});
