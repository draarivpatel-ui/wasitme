import { test, after } from "node:test";
import assert from "node:assert/strict";
import { collectConfig, diffSnapshots, mergeSnapshots } from "../../src/extract/configsnap/index.js";
import type { AgentId, ChangeEvent, ConfigSnapshot } from "../../src/types.js";
import { shortHash } from "../../src/extract/configsnap/labels.js";
import { makeHash } from "../../src/util.js";
import { Fixture, hash, opts } from "./helpers.js";

const fixtures: Fixture[] = [];
function fx(): Fixture {
  const f = new Fixture();
  fixtures.push(f);
  return f;
}
after(() => fixtures.forEach((f) => f.cleanup()));

const h = (v: string): string => shortHash(hash, v);
const HASH = /^h:[0-9a-f]{8}$/;

const snap = (f: Fixture, agent: AgentId = "claude-code"): ConfigSnapshot => collectConfig(agent, opts(f)).snapshot;
const diff = (a: ConfigSnapshot, b: ConfigSnapshot): ChangeEvent[] => diffSnapshots(a, b, { hash, timeZone: "UTC" });

interface ClaudeShape {
  claudeMd?: string | null;
  settings?: Record<string, unknown> | null;
  mcp?: Record<string, unknown>;
  installed?: Record<string, unknown>;
  skills?: string[];
}

const BASE_SETTINGS: Record<string, unknown> = {
  model: "opus",
  effortLevel: "high",
  alwaysThinkingEnabled: true,
  statusLine: { type: "command", command: "s" },
  hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "a" }] }] },
  permissions: { allow: ["Read", "Edit"], deny: [], defaultMode: "default" },
  env: { A: "1" },
  enabledPlugins: { "p1@m": true },
  theme: "dark",
};

const BASE: Required<ClaudeShape> = {
  claudeMd: "v1\n",
  settings: BASE_SETTINGS,
  mcp: { a: { command: "x" } },
  installed: { "p1@m": [] },
  skills: ["one"],
};

function writeClaude(f: Fixture, shape: ClaudeShape = {}): void {
  const s = { ...BASE, ...shape };
  f.mkdir(".claude");
  if (s.claudeMd !== null) f.write(".claude/CLAUDE.md", s.claudeMd);
  if (s.settings !== null) f.json(".claude/settings.json", s.settings);
  f.json(".claude.json", { mcpServers: s.mcp });
  f.json(".claude/plugins/installed_plugins.json", { plugins: s.installed });
  for (const k of s.skills) f.write(`.claude/skills/${k}/SKILL.md`, "x");
}

/** Snapshot before/after changing the tree. Fresh fixture each time keeps cases independent. */
function claudeChange(after: ClaudeShape, before: ClaudeShape = {}): ChangeEvent[] {
  const a = fx();
  writeClaude(a, before);
  const b = fx();
  writeClaude(b, after);
  return diff(snap(a), snap(b));
}

const withSettings = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...BASE_SETTINGS, ...patch });

test("no change, no events", () => {
  assert.deepEqual(claudeChange({}), []);
});

test("every event is side you, evidence snapshot, with the contract's shape", () => {
  const evs = claudeChange({
    claudeMd: "v2\nmore\n",
    settings: withSettings({ model: "sonnet", theme: "light" }),
    mcp: { a: { command: "x" }, b: {} },
    skills: ["one", "two"],
  });
  assert.ok(evs.length >= 4);
  const kinds = new Set(["config", "instructions", "mcp", "skills", "plugins", "hooks", "model", "effort"]);
  for (const e of evs) {
    assert.equal(e.side, "you");
    assert.equal(e.evidence, "snapshot");
    assert.equal(e.agent, "claude-code");
    assert.ok(kinds.has(e.kind), e.kind);
    assert.equal(e.t, "2026-10-04T12:00:00.000Z");
    assert.equal(e.day, "2026-10-04");
    assert.match(e.id, /^c-[0-9a-f]{12}$/);
    assert.ok(e.from.length > 0 && e.to.length > 0);
    assert.equal(e.userInitiated, undefined);
  }
});

test("model and effort", () => {
  const [m] = claudeChange({ settings: withSettings({ model: "sonnet" }) });
  assert.deepEqual({ kind: m!.kind, from: m!.from, to: m!.to, note: m!.note }, { kind: "model", from: "opus", to: "sonnet", note: "configured default model" });

  const evs = claudeChange({ settings: withSettings({ effortLevel: "low", alwaysThinkingEnabled: false }) });
  assert.deepEqual(evs.map((e) => [e.kind, e.from, e.to, e.note]), [
    ["effort", "high", "low", "configured effort level"],
    ["effort", "on", "off", "always-on thinking setting"],
  ]);

  const unset = claudeChange({ settings: (() => { const s = { ...BASE_SETTINGS }; delete s.model; return s; })() });
  assert.deepEqual(unset.map((e) => [e.kind, e.from, e.to]), [["model", "opus", "unset"]]);
});

test("instructions: edited, added, removed", () => {
  const [edit] = claudeChange({ claudeMd: "v1\nmore\n" });
  assert.equal(edit!.kind, "instructions");
  assert.match(edit!.from, HASH);
  assert.match(edit!.to, HASH);
  assert.notEqual(edit!.from, edit!.to);
  assert.equal(edit!.note, "edited, bytes 3 to 8, lines 1 to 2");

  const [removed] = claudeChange({ claudeMd: null });
  assert.equal(removed!.to, "absent");
  assert.match(removed!.from, HASH);
  assert.equal(removed!.note, "removed, bytes 3 to 0");

  const [added] = claudeChange({}, { claudeMd: null });
  assert.equal(added!.from, "absent");
  assert.match(added!.to, HASH);
  assert.equal(added!.note, "added, bytes 0 to 3");
});

test("MCP servers: added, removed, swapped, edited", () => {
  const [add] = claudeChange({ mcp: { a: { command: "x" }, b: {} } });
  assert.deepEqual([add!.kind, add!.from, add!.to], ["mcp", "1", "2"]);
  assert.equal(add!.note, `MCP servers: added 1 (${h("b")})`);

  const [rm] = claudeChange({ mcp: {} });
  assert.deepEqual([rm!.from, rm!.to], ["1", "0"]);
  assert.equal(rm!.note, `MCP servers: removed 1 (${h("a")})`);

  const [swap] = claudeChange({ mcp: { z: { command: "x" } } });
  assert.deepEqual([swap!.from, swap!.to], ["1", "1"]);
  assert.equal(swap!.note, `MCP servers: added 1 (${h("z")}); removed 1 (${h("a")})`);

  const [edit] = claudeChange({ mcp: { a: { command: "x", args: ["--new"] } } });
  assert.equal(edit!.note, "MCP servers edited");
  assert.match(edit!.from, HASH);
  assert.match(edit!.to, HASH);
});

test("skills and plugins", () => {
  const [sk] = claudeChange({ skills: ["one", "two", "three"] });
  assert.deepEqual([sk!.kind, sk!.from, sk!.to], ["skills", "1", "3"]);
  assert.equal(sk!.note, `skills: added 2 (${[h("two"), h("three")].sort().join(", ")})`);

  const [en] = claudeChange({ settings: withSettings({ enabledPlugins: { "p1@m": true, "p2@m": true } }) });
  assert.deepEqual([en!.kind, en!.from, en!.to], ["plugins", "1", "2"]);
  assert.equal(en!.note, `enabled plugins: added 1 (${h("p2@m")})`);

  const [dis] = claudeChange({ settings: withSettings({ enabledPlugins: { "p1@m": false } }) });
  assert.deepEqual([dis!.from, dis!.to], ["1", "0"]);
  assert.equal(dis!.note, `enabled plugins: removed 1 (${h("p1@m")})`);

  const [inst] = claudeChange({ installed: { "p1@m": [], "p2@m": [] } });
  assert.deepEqual([inst!.kind, inst!.from, inst!.to], ["plugins", "1", "2"]);
  assert.equal(inst!.note, `installed plugins: added 1 (${h("p2@m")})`);
});

test("hooks: handler added, new event, edited command", () => {
  const two = { PreToolUse: [{ hooks: [{ type: "command", command: "a" }, { type: "command", command: "b" }] }] };
  const [more] = claudeChange({ settings: withSettings({ hooks: two }) });
  assert.deepEqual([more!.kind, more!.from, more!.to, more!.note], ["hooks", "1", "2", "hooks: PreToolUse 1 to 2"]);

  const stop = { ...(BASE_SETTINGS.hooks as object), Stop: [{ hooks: [{ type: "command", command: "z" }] }] };
  const [ev] = claudeChange({ settings: withSettings({ hooks: stop }) });
  assert.equal(ev!.note, "hooks: Stop 0 to 1");

  const edited = { PreToolUse: [{ hooks: [{ type: "command", command: "a --changed" }] }] };
  const [ed] = claudeChange({ settings: withSettings({ hooks: edited }) });
  assert.equal(ed!.note, "hooks edited");
  assert.match(ed!.from, HASH);

  const [none] = claudeChange({ settings: (() => { const s = { ...BASE_SETTINGS }; delete s.hooks; return s; })() });
  assert.deepEqual([none!.from, none!.to, none!.note], ["1", "0", "hooks: PreToolUse 1 to 0"]);
});

test("hooks: an event name outside Claude Code's list is a hash in the note, never text", () => {
  const custom = { ...(BASE_SETTINGS.hooks as object), AcmeClientSecretProj: [{ hooks: [{ type: "command", command: "z" }] }] };
  const [ev] = claudeChange({ settings: withSettings({ hooks: custom }) });
  assert.equal(ev!.note, `hooks: ${h("AcmeClientSecretProj")} 0 to 1`);
  assert.equal(JSON.stringify(ev).includes("Acme"), false);
});

test("permissions, permission mode, env, status line, other settings", () => {
  const [add] = claudeChange({ settings: withSettings({ permissions: { allow: ["Read", "Edit", "Write"], deny: [], defaultMode: "default" } }) });
  assert.deepEqual([add!.kind, add!.from, add!.to, add!.note], ["config", "2", "3", "permission rules: allow 2 to 3"]);

  const [moved] = claudeChange({ settings: withSettings({ permissions: { allow: ["Read"], deny: ["Edit"], defaultMode: "default" } }) });
  assert.deepEqual([moved!.from, moved!.to, moved!.note], ["2", "2", "permission rules: allow 2 to 1; deny 0 to 1"]);

  const [replaced] = claudeChange({ settings: withSettings({ permissions: { allow: ["Read", "Write"], deny: [], defaultMode: "default" } }) });
  assert.equal(replaced!.note, "permission rules edited");

  const [mode] = claudeChange({ settings: withSettings({ permissions: { allow: ["Read", "Edit"], deny: [], defaultMode: "bypassPermissions" } }) });
  assert.deepEqual([mode!.kind, mode!.from, mode!.to, mode!.note], ["config", "default", "bypassPermissions", "default permission mode"]);

  const [envAdd] = claudeChange({ settings: withSettings({ env: { A: "1", B: "2" } }) });
  assert.deepEqual([envAdd!.from, envAdd!.to, envAdd!.note], ["1", "2", "environment variables in settings"]);
  // env VALUES are never read into a snapshot, so changing one is invisible by design; renaming a key is not.
  assert.deepEqual(claudeChange({ settings: withSettings({ env: { A: "CHANGED" } }) }), []);
  const [envKey] = claudeChange({ settings: withSettings({ env: { RENAMED: "1" } }) });
  assert.equal(envKey!.note, "environment variables in settings edited");
  assert.match(envKey!.from, HASH);

  const [sl] = claudeChange({ settings: (() => { const s = { ...BASE_SETTINGS }; delete s.statusLine; return s; })() });
  assert.deepEqual([sl!.kind, sl!.from, sl!.to, sl!.note], ["config", "present", "absent", "status line"]);
  const [sle] = claudeChange({ settings: withSettings({ statusLine: { type: "command", command: "s2" } }) });
  assert.equal(sle!.note, "status line edited");

  const [other] = claudeChange({ settings: withSettings({ theme: "light" }) });
  assert.deepEqual([other!.kind, other!.note], ["config", "other settings"]);
  assert.match(other!.from, HASH);
});

test("settings.json deleted: everything it held reads as changed to unset/zero", () => {
  const evs = claudeChange({ settings: null });
  const kinds = evs.map((e) => e.kind);
  for (const k of ["model", "effort", "hooks", "config", "plugins"]) assert.ok(kinds.includes(k as ChangeEvent["kind"]), k);
});

test("a source unreadable on either side is unknown, not changed", () => {
  const f = fx();
  writeClaude(f);
  const good = snap(f);
  f.write(".claude/settings.json", "{broken");
  const broken = snap(f);
  assert.equal(broken.items["settings.model"], undefined);
  assert.deepEqual(diff(good, broken), []);
  assert.deepEqual(diff(broken, good), []);
});

test("mergeSnapshots keeps the last known state across an unreadable gap, so the change is not lost", () => {
  const f = fx();
  writeClaude(f);
  const day1 = snap(f);

  f.write(".claude/settings.json", "{broken");
  const day2 = { ...snap(f), t: "2026-10-05T12:00:00.000Z" };
  assert.equal(diff(day1, day2).length, 0);
  const baseline = mergeSnapshots(day1, day2);
  assert.equal(baseline.items["settings.model"], "opus", "carried forward");
  assert.equal(baseline.t, day2.t);

  f.json(".claude/settings.json", withSettings({ model: "sonnet" }));
  const day3 = { ...snap(f), t: "2026-10-06T12:00:00.000Z" };
  assert.equal(diff(day2, day3).length, 0, "naive diff against the gap sees nothing");
  const evs = diff(baseline, day3);
  assert.deepEqual(evs.map((e) => [e.kind, e.from, e.to]), [["model", "opus", "sonnet"]]);
  assert.equal(evs[0]!.t, "2026-10-06T12:00:00.000Z");

  // sources next could read replace prev's wholesale (no stale name keys left behind)
  const merged = mergeSnapshots(
    { t: "x", agent: "claude-code", items: { "skills.count": 2, [`skills.name.${h("a")}`]: true, [`skills.name.${h("b")}`]: true, "settings.model": "opus" } },
    { t: "y", agent: "claude-code", items: { "skills.count": 1, [`skills.name.${h("c")}`]: true } },
  );
  assert.deepEqual(merged.items, { "settings.model": "opus", "skills.count": 1, [`skills.name.${h("c")}`]: true });
  assert.equal(mergeSnapshots(undefined, day1), day1);
  assert.equal(mergeSnapshots({ ...day1, agent: "codex" }, day1), day1);
});

test("one event per facet: two things changing at once stay distinct", () => {
  const evs = claudeChange({
    settings: withSettings({ model: "sonnet", effortLevel: "low" }),
    mcp: { a: { command: "x" }, b: {} },
    skills: ["one", "two"],
  });
  assert.deepEqual(evs.map((e) => e.kind), ["model", "effort", "mcp", "skills"], "stable facet order");
  assert.equal(new Set(evs.map((e) => e.id)).size, evs.length);
  // mcp and skills both went 1 -> 2 at the same instant: ids still differ
  const mcp = evs.find((e) => e.kind === "mcp")!;
  const skills = evs.find((e) => e.kind === "skills")!;
  assert.deepEqual([mcp.from, mcp.to], [skills.from, skills.to]);
  assert.notEqual(mcp.id, skills.id);
});

test("ids are deterministic, salt-dependent, and time-dependent", () => {
  const f = fx();
  writeClaude(f);
  const a = snap(f);
  f.json(".claude/settings.json", withSettings({ model: "sonnet" }));
  const b = snap(f);
  const x = diffSnapshots(a, b, { hash });
  const y = diffSnapshots(a, b, { hash });
  assert.deepEqual(x, y);
  assert.notEqual(diffSnapshots(a, b, { hash: makeHash("other-salt") })[0]!.id, x[0]!.id);
  assert.notEqual(diffSnapshots(a, { ...b, t: "2026-10-05T00:00:00.000Z" }, { hash })[0]!.id, x[0]!.id);
  // without a HashFn it still works (unsalted fallback)
  assert.match(diffSnapshots(a, b)[0]!.id, /^c-[0-9a-f]{12}$/);
});

test("backward clock: events carry next.t, nothing is negative or dropped", () => {
  const f = fx();
  writeClaude(f);
  const a = { ...snap(f), t: "2026-10-05T12:00:00.000Z" };
  f.json(".claude/settings.json", withSettings({ model: "sonnet" }));
  const b = { ...snap(f), t: "2026-10-01T09:00:00.000Z" }; // user reset the clock
  const evs = diff(a, b);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.t, "2026-10-01T09:00:00.000Z");
  assert.equal(evs[0]!.day, "2026-10-01");
});

test("day follows the requested timezone", () => {
  const f = fx();
  writeClaude(f);
  const a = snap(f);
  f.json(".claude/settings.json", withSettings({ model: "sonnet" }));
  const b = { ...snap(f), t: "2026-10-04T23:30:00.000Z" };
  assert.equal(diffSnapshots(a, b, { hash, timeZone: "UTC" })[0]!.day, "2026-10-04");
  assert.equal(diffSnapshots(a, b, { hash, timeZone: "Pacific/Auckland" })[0]!.day, "2026-10-05");
});

test("invalid inputs produce no events instead of throwing", () => {
  const f = fx();
  writeClaude(f);
  const a = snap(f);
  const codexSnap: ConfigSnapshot = { t: a.t, agent: "codex", items: {} };
  assert.deepEqual(diff(a, codexSnap), [], "different agents are never compared");
  assert.deepEqual(diff(a, { ...a, t: "not a date" }), []);
  assert.deepEqual(diff(a, { ...a, items: null as unknown as ConfigSnapshot["items"] }), []);
  assert.deepEqual(diff({ ...a, items: [] as unknown as ConfigSnapshot["items"] }, a), []);
  assert.deepEqual(diff(null as unknown as ConfigSnapshot, a), []);
  assert.deepEqual(diff({ ...a, agent: "bogus" as AgentId }, { ...a, agent: "bogus" as AgentId }), []);
  assert.deepEqual(diff(a, a), []);
});

test("a tampered stored snapshot cannot smuggle text into events", () => {
  const f = fx();
  writeClaude(f);
  const a = snap(f);
  const evil = "EVIL <script>alert(1)</script> /etc/passwd \u001b[31m";
  const b: ConfigSnapshot = {
    ...a,
    items: {
      ...a.items,
      "settings.model": evil,
      "settings.effort": "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
      "skills.count": -5,
      "settings.env.count": 1.5,
      "settings.hooks.total": 2,
      "settings.hooks.event.<img src=x>": 7,
      [`skills.name.${evil}`]: true,
      "settings.other.hash": "not-a-hash /secret",
    },
  };
  const evs = diff(a, b);
  const text = JSON.stringify(evs);
  for (const bad of ["EVIL", "<script>", "passwd", "sk-ant", "<img", "\u001b", "/secret"]) assert.equal(text.includes(bad), false, bad);
  for (const e of evs) {
    assert.match(e.from, /^[A-Za-z0-9._\-[\]:+@ ]+$/);
    assert.match(e.to, /^[A-Za-z0-9._\-[\]:+@ ]+$/);
  }
  assert.ok(evs.some((e) => e.kind === "model" && HASH.test(e.to)));
});

test("a stored snapshot cannot put an unlisted hook event name into a note, even a label-safe one", () => {
  const f = fx();
  writeClaude(f);
  const a = snap(f);
  const b: ConfigSnapshot = {
    ...a,
    items: { ...a.items, "settings.hooks.total": 3, "settings.hooks.event.AcmeClientSecretProj": 1, "settings.hooks.event.Stop": 1 },
  };
  const [ev] = diff(a, b);
  assert.equal(ev!.kind, "hooks");
  assert.equal(ev!.note, "hooks: other 0 to 1; Stop 0 to 1");
  assert.equal(JSON.stringify(ev).includes("Acme"), false);
});

// ------------------------------------------------------------------------------------------ codex

const CODEX_BASE = `
model = "gpt-6-luna"
model_reasoning_effort = "high"
model_provider = "openai"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
notify = ["n"]
[mcp_servers.one]
command = "x"
[plugins."p1@m"]
enabled = true
`;

function codexChange(configAfter: string | null, extra: (f: Fixture) => void = () => {}): ChangeEvent[] {
  const f = fx();
  f.write(".codex/config.toml", CODEX_BASE);
  f.write(".codex/AGENTS.md", "rules\n");
  f.write(".codex/skills/s1/SKILL.md", "x");
  const a = snap(f, "codex");
  if (configAfter !== null) f.write(".codex/config.toml", configAfter);
  extra(f);
  return diff(a, snap(f, "codex"));
}

test("a stored snapshot cannot put a profile name or any unlisted enum value into from/to, even a label-safe one", () => {
  // e.g. a baseline written before profile names were hashed, or edited by hand
  const f = fx();
  f.write(".codex/config.toml", CODEX_BASE);
  const fresh = snap(f, "codex");
  const stored: ConfigSnapshot = {
    ...fresh,
    items: {
      ...fresh.items,
      "config.profile": "client-acme-payroll",
      "config.provider": "acme-gateway",
      "config.approval": "AcmeMode",
      "config.sandbox": "acme-project",
    },
  };
  const evs = diff(stored, fresh);
  assert.deepEqual(evs.map((e) => [e.from, e.to]), [
    [h("acme-gateway"), "openai"],
    [h("AcmeMode"), "on-request"],
    [h("acme-project"), "workspace-write"],
    [h("client-acme-payroll"), "unset"],
  ]);
  const salted = JSON.stringify(evs);
  const unsalted = diffSnapshots(stored, fresh);
  assert.equal(unsalted.length, 4);
  for (const e of unsalted) assert.match(e.from, HASH);
  for (const text of [salted, JSON.stringify(unsalted)]) assert.equal(text.toLowerCase().includes("acme"), false);

  const c = fx();
  writeClaude(c);
  const ca = snap(c);
  const [mode] = diff({ ...ca, items: { ...ca.items, "settings.permissions.mode": "Acme Project" } }, ca);
  assert.deepEqual([mode!.kind, mode!.from, mode!.to], ["config", h("Acme Project"), "default"]);

  // listed values and hashes in a stored snapshot are shown as they are
  const [ok] = diff({ ...ca, items: { ...ca.items, "settings.permissions.mode": "plan" } }, ca);
  assert.deepEqual([ok!.from, ok!.to], ["plan", "default"]);
  const [hh] = diff({ ...ca, items: { ...ca.items, "settings.permissions.mode": h("x") } }, ca);
  assert.deepEqual([hh!.from, hh!.to], [h("x"), "default"]);
});

test("codex: model, effort, provider, approval, sandbox", () => {
  const evs = codexChange(
    CODEX_BASE.replace("gpt-6-luna", "gpt-6.1-sol").replace('"high"', '"low"').replace('"openai"', '"ollama"')
      .replace("on-request", "never").replace("workspace-write", "danger-full-access"),
  );
  assert.deepEqual(evs.map((e) => [e.kind, e.from, e.to, e.note]), [
    ["model", "gpt-6-luna", "gpt-6.1-sol", "configured default model"],
    ["effort", "high", "low", "configured reasoning effort"],
    ["config", "openai", "ollama", "model provider"],
    ["config", "on-request", "never", "approval policy"],
    ["config", "workspace-write", "danger-full-access", "sandbox mode"],
  ]);
  for (const e of evs) assert.equal(e.agent, "codex");
});

test("codex: a user-defined provider or an unknown approval value is shown as a hash only", () => {
  const evs = codexChange(CODEX_BASE.replace('"openai"', '"acme-gateway"').replace("on-request", "AcmeMode"));
  assert.deepEqual(evs.map((e) => [e.kind, e.from, e.to, e.note]), [
    ["config", "openai", h("acme-gateway"), "model provider"],
    ["config", "on-request", h("AcmeMode"), "approval policy"],
  ]);
  assert.equal(JSON.stringify(evs).includes("acme"), false);
});

test("codex: notify toggled, MCP and plugins changed, profile selected", () => {
  const [n] = codexChange(CODEX_BASE.replace('notify = ["n"]', "notify = []"));
  assert.deepEqual([n!.kind, n!.from, n!.to, n!.note], ["config", "present", "absent", "notify command"]);

  const [mcp] = codexChange(CODEX_BASE + '[mcp_servers.two]\ncommand = "y"\n');
  assert.deepEqual([mcp!.kind, mcp!.from, mcp!.to], ["mcp", "1", "2"]);
  assert.equal(mcp!.note, `MCP servers: added 1 (${h("two")})`);

  const [mcpEdit] = codexChange(CODEX_BASE.replace('command = "x"', 'command = "x2"'));
  assert.equal(mcpEdit!.note, "MCP servers edited");

  // a server's env VALUES are not part of anything we keep: editing only those is not a detectable change
  const withEnvValue = (v: string): ConfigSnapshot => {
    const f = fx();
    f.write(".codex/config.toml", CODEX_BASE.replace('command = "x"', `command = "x"\n[mcp_servers.one.env]\nK = "${v}"\n`));
    return snap(f, "codex");
  };
  assert.deepEqual(diff(withEnvValue("v1"), withEnvValue("v2")), []);

  const [pl] = codexChange(CODEX_BASE.replace("enabled = true", "enabled = false"));
  assert.deepEqual([pl!.kind, pl!.from, pl!.to], ["plugins", "1", "0"]);

  const evs = codexChange(`profile = "fast"\n${CODEX_BASE}[profiles.fast]\nmodel = "m2"\n`);
  assert.deepEqual(evs.map((e) => [e.kind, e.from, e.to]), [["model", "gpt-6-luna", "m2"], ["config", "unset", h("fast")]]);
  assert.equal(evs[1]!.note, "active profile");
});

test("codex: AGENTS.md and skills", () => {
  const evs = codexChange(null, (f) => {
    f.write(".codex/AGENTS.md", "rules\nmore\n");
    f.write(".codex/skills/s2/SKILL.md", "x");
  });
  assert.deepEqual(evs.map((e) => e.kind), ["instructions", "skills"]);
  assert.equal(evs[0]!.note, "edited, bytes 6 to 11, lines 1 to 2");
  assert.equal(evs[1]!.note, `skills: added 1 (${h("s2")})`);
});

test("codex: malformed config.toml is unknown, so no config events", () => {
  assert.deepEqual(codexChange('model = "unterminated\n'), []);
});

test("codex: changes Codex makes by itself to [projects.*] are not setup changes", () => {
  assert.deepEqual(codexChange(CODEX_BASE + '[projects."/a/b"]\ntrust_level = "trusted"\n'), []);
});
