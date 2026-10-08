import { test, after } from "node:test";
import assert from "node:assert/strict";
import { collectConfig } from "../../src/extract/configsnap/index.js";
import type { CollectOptions, CollectResult } from "../../src/extract/configsnap/index.js";
import { shortHash } from "../../src/extract/configsnap/labels.js";
import { resolveCodexDir } from "../../src/extract/configsnap/paths.js";
import { Fixture, NOW, hash, opts } from "./helpers.js";

const fixtures: Fixture[] = [];
function fx(): Fixture {
  const f = new Fixture();
  fixtures.push(f);
  return f;
}
after(() => fixtures.forEach((f) => f.cleanup()));

const codex = (f: Fixture, extra: Partial<CollectOptions> = {}): CollectResult => collectConfig("codex", opts(f, extra));
const states = (r: CollectResult): Record<string, string> => Object.fromEntries(r.diagnostics.map((d) => [d.source, d.state]));
const h = (v: string): string => shortHash(hash, v);

const CONFIG = `
model = "gpt-6-luna"            # default
model_reasoning_effort = "high"
model_provider = "openai"
approval_policy = "never"
sandbox_mode = "danger-full-access"
notify = ["/usr/local/bin/notifier", "--quiet"]

[mcp_servers.github]
command = "npx"
args = ["-y", "@scope/server"]

[mcp_servers.github.env]
TOKEN = "not-a-real-token"

[mcp_servers."second server"]
url = "https://example.invalid/mcp"

[plugins."alpha@market"]
enabled = true

[plugins."beta@market"]
enabled = false

[plugins."gamma@market"]

[projects."/some/project"]
trust_level = "trusted"
`;

test("full tree: exact values", () => {
  const f = fx();
  f.write(".codex/config.toml", CONFIG);
  f.write(".codex/AGENTS.md", "# agents\nrule\n");
  f.write(".codex/skills/one/SKILL.md", "x");
  f.write(".codex/skills/.system/builtin/SKILL.md", "x");
  f.write(".codex/skills/.system/SKILL.md", "x");
  const r = codex(f);
  assert.equal(r.found, true);
  assert.equal(r.snapshot.agent, "codex");
  assert.equal(r.snapshot.t, NOW.toISOString());
  const i = r.snapshot.items;

  assert.equal(i["instructions.present"], true);
  assert.equal(i["instructions.bytes"], 14);
  assert.equal(i["instructions.lines"], 2);
  assert.match(String(i["instructions.hash"]), /^h:[0-9a-f]{8}$/);

  assert.equal(i["config.model"], "gpt-6-luna");
  assert.equal(i["config.effort"], "high");
  assert.equal(i["config.provider"], "openai");
  assert.equal(i["config.approval"], "never");
  assert.equal(i["config.sandbox"], "danger-full-access");
  assert.equal(i["config.profile"], "unset");
  assert.equal(i["config.notify.present"], true);

  assert.equal(i["config.mcp.count"], 2);
  assert.equal(i[`config.mcp.name.${h("github")}`], true);
  assert.equal(i[`config.mcp.name.${h("second server")}`], true);
  assert.match(String(i["config.mcp.hash"]), /^h:[0-9a-f]{8}$/);

  assert.equal(i["config.plugins.count"], 2, "enabled = false is excluded; a table with no flag counts as enabled");
  assert.equal(i[`config.plugins.name.${h("alpha@market")}`], true);
  assert.equal(i[`config.plugins.name.${h("beta@market")}`], undefined);

  assert.equal(i["skills.count"], 1, "dot-directories (.system) are Codex's own, not the user's");

  assert.deepEqual(states(r), { instructions: "ok", "config-toml": "ok", skills: "ok" });
});

test("[projects.*] (paths) are never read into anything", () => {
  const f = fx();
  f.write(".codex/config.toml", CONFIG);
  const out = JSON.stringify(codex(f));
  assert.equal(out.includes("some/project"), false);
  assert.equal(out.includes("trusted"), false);
});

test("a changed MCP server definition changes the hash but not the count", () => {
  const f = fx();
  f.write(".codex/config.toml", CONFIG);
  const a = codex(f).snapshot.items;
  f.write(".codex/config.toml", CONFIG.replace('"@scope/server"', '"@scope/server@2"'));
  const b = codex(f).snapshot.items;
  assert.equal(b["config.mcp.count"], a["config.mcp.count"]);
  assert.notEqual(b["config.mcp.hash"], a["config.mcp.hash"]);
});

test("inline-table and dotted-key MCP servers are counted", () => {
  const f = fx();
  f.write(".codex/config.toml", `
[mcp_servers]
a = { command = "x", args = ["1"], env = { K = "v" } }
b = { url = "https://x.invalid" }
c.command = "y"
`);
  const i = codex(f).snapshot.items;
  assert.equal(i["config.mcp.count"], 3);
});

test("profile overrides top-level values, as Codex applies them", () => {
  const f = fx();
  f.write(".codex/config.toml", `
profile = "fast"
model = "base-model"
approval_policy = "never"
[profiles.fast]
model = "fast-model"
model_reasoning_effort = "low"
[profiles.other]
model = "other-model"
`);
  const i = codex(f).snapshot.items;
  assert.equal(i["config.profile"], h("fast"), "profile names are user-invented: hash only");
  assert.equal(i["config.model"], "fast-model");
  assert.equal(i["config.effort"], "low");
  assert.equal(i["config.approval"], "never", "not overridden by the profile");

  f.write(".codex/config.toml", `profile = "missing"\nmodel = "base-model"\n`);
  assert.equal(codex(f).snapshot.items["config.model"], "base-model");
});

test("profile name is never exported as text, yet a switch between profiles is still visible", () => {
  const name = "client-acme-payroll"; // passes cleanLabel on its own: only hashing keeps it out
  const f = fx();
  f.write(".codex/config.toml", `profile = "${name}"\nmodel = "m"\n[profiles.${name}]\nmodel = "pm"\n`);
  const r = codex(f);
  const i = r.snapshot.items;
  assert.equal(i["config.profile"], h(name));
  assert.equal(i["config.model"], "pm", "the profile still drives the effective model");
  assert.equal(JSON.stringify(r).includes("acme"), false);

  f.write(".codex/config.toml", `profile = "client-other"\nmodel = "m"\n[profiles.client-other]\nmodel = "pm"\n`);
  assert.notEqual(codex(f).snapshot.items["config.profile"], h(name));
  f.write(".codex/config.toml", `model = "m"\n`);
  assert.equal(codex(f).snapshot.items["config.profile"], "unset");
  f.write(".codex/config.toml", `profile = 7\n`);
  assert.equal(codex(f).snapshot.items["config.profile"], h("7"), "a non-string profile is hashed too");
});

test("approval, sandbox and provider: fixed vocabularies are shown, anything user-chosen is hashed", () => {
  const f = fx();
  const items = (toml: string): Record<string, unknown> => {
    f.write(".codex/config.toml", toml);
    return codex(f).snapshot.items;
  };
  for (const a of ["untrusted", "on-failure", "on-request", "never"]) assert.equal(items(`approval_policy = "${a}"\n`)["config.approval"], a);
  for (const s of ["read-only", "workspace-write", "danger-full-access"]) assert.equal(items(`sandbox_mode = "${s}"\n`)["config.sandbox"], s);
  for (const p of ["openai", "azure", "ollama", "lmstudio", "oss"]) assert.equal(items(`model_provider = "${p}"\n`)["config.provider"], p);

  // label-safe and harmless-looking, but not on the list: a client or project name would pass a charset check
  const i = items('approval_policy = "AcmeClient"\nsandbox_mode = "acme-project"\nmodel_provider = "acme-gateway"\n');
  assert.equal(i["config.approval"], h("AcmeClient"));
  assert.equal(i["config.sandbox"], h("acme-project"));
  assert.equal(i["config.provider"], h("acme-gateway"));
  assert.equal(items('approval_policy = "never "\n')["config.approval"], "never", "surrounding spaces do not matter");
  assert.equal(items('approval_policy = "Never"\n')["config.approval"], h("Never"), "the list is exact, not case-insensitive");
});

test("missing config.toml: defaults are a real, definitive state", () => {
  const f = fx();
  f.mkdir(".codex");
  const r = codex(f);
  const i = r.snapshot.items;
  assert.equal(r.found, true);
  assert.equal(i["instructions.present"], false);
  assert.equal(i["config.model"], "unset");
  assert.equal(i["config.notify.present"], false);
  assert.equal(i["config.mcp.count"], 0);
  assert.equal(i["config.mcp.hash"], undefined);
  assert.equal(i["config.plugins.count"], 0);
  assert.equal(i["skills.count"], 0);
  assert.deepEqual(Object.values(states(r)), ["missing", "missing", "missing"]);
});

test("config dir missing: nothing to snapshot", () => {
  const f = fx();
  const r = codex(f);
  assert.equal(r.found, false);
  assert.deepEqual(r.snapshot.items, {});
  assert.deepEqual(r.diagnostics, [{ agent: "codex", source: "config-dir", state: "missing" }]);
});

test("malformed config.toml: that source is unknown; AGENTS.md and skills still collected", () => {
  const f = fx();
  f.write(".codex/config.toml", 'model = "unterminated\n[mcp_servers.x]\ncommand = ');
  f.write(".codex/AGENTS.md", "rules");
  f.write(".codex/skills/s/SKILL.md", "x");
  const r = codex(f);
  assert.equal(states(r)["config-toml"], "malformed");
  assert.equal(r.snapshot.items["config.model"], undefined);
  assert.equal(r.snapshot.items["config.mcp.count"], undefined, "a partial parse must not report zero servers");
  assert.equal(r.snapshot.items["instructions.bytes"], 5);
  assert.equal(r.snapshot.items["skills.count"], 1);
});

test("huge config.toml (over the cap): unknown", () => {
  const f = fx();
  f.write(".codex/config.toml", `model = "m"\n# ${"x".repeat(2 * 1024 * 1024)}\n`);
  const r = codex(f);
  assert.equal(states(r)["config-toml"], "capped");
  assert.equal(r.snapshot.items["config.model"], undefined);
});

test("AGENTS.override.md takes precedence; an empty override does not", () => {
  const f = fx();
  f.write(".codex/AGENTS.md", "base rules");
  assert.equal(codex(f).snapshot.items["instructions.bytes"], 10);
  f.write(".codex/AGENTS.override.md", "override");
  assert.equal(codex(f).snapshot.items["instructions.bytes"], 8);
  f.write(".codex/AGENTS.override.md", "");
  assert.equal(codex(f).snapshot.items["instructions.bytes"], 10);
});

test("a broken override file makes instructions unknown rather than silently using AGENTS.md", () => {
  const f = fx();
  f.write(".codex/AGENTS.md", "base rules");
  f.mkdir(".codex/AGENTS.override.md");
  const r = codex(f);
  assert.equal(states(r).instructions, "not-file");
  assert.equal(r.snapshot.items["instructions.present"], undefined);
});

test("huge AGENTS.md: real size, prefix hash, flagged", () => {
  const f = fx();
  f.write(".codex/AGENTS.md", Buffer.alloc(2 * 1024 * 1024, "z"));
  const r = codex(f);
  assert.equal(r.snapshot.items["instructions.bytes"], 2 * 1024 * 1024);
  assert.equal(r.snapshot.items["instructions.capped"], true);
  assert.equal(states(r).instructions, "capped");
});

test("directory override precedence: WASITME_CODEX_DIR > CODEX_HOME > ~/.codex", () => {
  const f = fx();
  f.write(".codex/AGENTS.md", "d");
  f.write("a/AGENTS.md", "aa");
  f.write("b/AGENTS.md", "bbb");
  const bytes = (env: Record<string, string>): unknown => codex(f, { env }).snapshot.items["instructions.bytes"];
  assert.equal(bytes({}), 1);
  assert.equal(bytes({ CODEX_HOME: f.path("b") }), 3);
  assert.equal(bytes({ CODEX_HOME: f.path("b"), WASITME_CODEX_DIR: f.path("a") }), 2);
  assert.equal(bytes({ CODEX_HOME: f.path("b"), WASITME_CODEX_DIR: "  " }), 3);
  assert.equal(resolveCodexDir({}, f.home), f.path(".codex"));
  assert.equal(resolveCodexDir({ CODEX_HOME: "~/b" }, f.home), f.path("b"));
});

test("hostile values: non-label models and odd types become hashes, never text", () => {
  const f = fx();
  f.write(".codex/config.toml", `
model = "/opt/secret/model path"
model_reasoning_effort = 5
approval_policy = ["a", "b"]
sandbox_mode = { x = "y" }
model_provider = "sk-live-0123456789abcdef0123456789abcdef"
notify = []
`);
  const i = codex(f).snapshot.items;
  assert.match(String(i["config.model"]), /^h:[0-9a-f]{8}$/);
  assert.equal(i["config.effort"], "5");
  assert.match(String(i["config.approval"]), /^h:[0-9a-f]{8}$/);
  assert.match(String(i["config.sandbox"]), /^h:[0-9a-f]{8}$/);
  assert.match(String(i["config.provider"]), /^h:[0-9a-f]{8}$/);
  assert.equal(i["config.notify.present"], false, "notify = [] disables the notifier");
});

test("hostile TOML: __proto__ tables and keys are plain keys", () => {
  const f = fx();
  f.write(".codex/config.toml", `
[mcp_servers.__proto__]
command = "x"
[plugins.__proto__]
enabled = true
[__proto__]
model = "polluted"
`);
  const r = codex(f);
  assert.equal(states(r)["config-toml"], "ok");
  assert.equal(r.snapshot.items["config.mcp.count"], 1);
  assert.equal(r.snapshot.items["config.plugins.count"], 1);
  assert.equal(r.snapshot.items["config.model"], "unset");
  assert.equal(({} as Record<string, unknown>).model, undefined);
});

test("symlinked config.toml and AGENTS.md are followed; ones into an avoided folder are not", () => {
  const f = fx();
  f.write("dotfiles/config.toml", 'model = "linked-model"\n');
  f.write("Documents/dot/AGENTS.md", "SECRET CONTENT");
  f.mkdir(".codex");
  f.link(".codex/config.toml", f.path("dotfiles", "config.toml"));
  f.link(".codex/AGENTS.md", f.path("Documents", "dot", "AGENTS.md"));
  const r = codex(f, { avoid: [f.path("Documents")] });
  assert.equal(r.snapshot.items["config.model"], "linked-model");
  assert.equal(states(r).instructions, "protected");
  assert.equal(JSON.stringify(r).includes("SECRET"), false);
});
