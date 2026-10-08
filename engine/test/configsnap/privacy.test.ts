import { test, after } from "node:test";
import assert from "node:assert/strict";
import { collectConfig, collectConfigSnapshots, diffSnapshots, mergeSnapshots } from "../../src/extract/configsnap/index.js";
import type { ChangeEvent, ConfigSnapshot } from "../../src/types.js";
import { cleanLabel } from "../../src/util.js";
import { shortHash } from "../../src/extract/configsnap/labels.js";
import { Fixture, SENTINELS, hash, opts } from "./helpers.js";

const [
  ENV_SECRET, ARG_TOKEN, HOOK_CMD, RULE_TEXT, PLUGIN_NAME, SERVER_NAME, SKILL_NAME, BODY_TEXT, SECRET_PATH,
  PROFILE_NAME, HOOK_EVENT, PERM_MODE, APPROVAL, SANDBOX, PROVIDER,
] = SENTINELS;

const fixtures: Fixture[] = [];
function fx(): Fixture {
  const f = new Fixture();
  fixtures.push(f);
  return f;
}
after(() => fixtures.forEach((f) => f.cleanup()));

/** Hostile Claude + Codex trees: a sentinel in every field that must never be exported. `variant` flips every value. */
function hostileTree(f: Fixture, variant: "a" | "b"): void {
  const v = variant;
  f.write(".claude/CLAUDE.md", `# ${BODY_TEXT}-${v}\nsecret instructions ${ENV_SECRET}\n`);
  f.json(".claude/settings.json", {
    model: "claude-opus-5-5",
    apiKeyHelper: `/bin/${ENV_SECRET}-${v}`,
    statusLine: { type: "command", command: `${HOOK_CMD}-${v} ${SECRET_PATH}` },
    hooks: {
      PreToolUse: [{ matcher: SECRET_PATH, hooks: [{ type: "command", command: `${HOOK_CMD}-${v}` }] }],
      [`${SERVER_NAME}-event-${v}`]: [{ hooks: [{ type: "command", command: HOOK_CMD }] }],
      [`${HOOK_EVENT}${v}`]: [{ hooks: [{ type: "command", command: HOOK_CMD }] }],
    },
    permissions: {
      allow: [`Bash(${RULE_TEXT}-${v}:*)`, `Read(${SECRET_PATH}/**)`],
      deny: [`Bash(curl ${ENV_SECRET}:*)`],
      additionalDirectories: [SECRET_PATH],
      defaultMode: `${PERM_MODE}${v}`,
    },
    env: { ANTHROPIC_API_KEY: `${ENV_SECRET}-${v}`, [`${ENV_SECRET}_NAME`]: ARG_TOKEN },
    enabledPlugins: { [`${PLUGIN_NAME}@${SECRET_PATH}`]: true },
    note: `${BODY_TEXT}-${v}`,
  });
  f.json(".claude.json", {
    userID: ENV_SECRET,
    projects: { [SECRET_PATH]: { history: [{ display: BODY_TEXT }], mcpServers: { hiddenProjectServer: { command: ARG_TOKEN } } } },
    mcpServers: {
      [`${SERVER_NAME}-${v}`]: { command: "npx", args: ["-y", `${ARG_TOKEN}-${v}`], env: { TOKEN: `${ENV_SECRET}-${v}` } },
      http: { type: "http", url: `https://${ENV_SECRET}.invalid`, headers: { Authorization: `Bearer ${ENV_SECRET}` } },
    },
  });
  f.json(".claude/plugins/installed_plugins.json", { version: 2, plugins: { [`${PLUGIN_NAME}@market-${v}`]: [{ installPath: `${SECRET_PATH}/plugin`, version: v }] } });
  f.write(`.claude/skills/${SKILL_NAME}-${v}/SKILL.md`, `${BODY_TEXT} skill body`);

  f.write(".codex/AGENTS.md", `agents ${BODY_TEXT}-${v}\n`);
  f.write(
    ".codex/config.toml",
    `
model = "gpt-6-luna"
profile = "${PROFILE_NAME}${v}"
approval_policy = "${APPROVAL}${v}"
sandbox_mode = "${SANDBOX}${v}"
model_provider = "${PROVIDER}${v}"
notify = ["${HOOK_CMD}-${v}", "${ARG_TOKEN}"]
[mcp_servers."${SERVER_NAME}-${v}"]
command = "${HOOK_CMD}"
args = ["--token", "${ARG_TOKEN}-${v}"]
[mcp_servers."${SERVER_NAME}-${v}".env]
SECRET = "${ENV_SECRET}-${v}"
[plugins."${PLUGIN_NAME}@${SECRET_PATH}-${v}"]
enabled = true
[projects."${SECRET_PATH}"]
trust_level = "trusted"
[profiles.other]
model = "${ENV_SECRET}"
[profiles.${PROFILE_NAME}${v}]
model_reasoning_effort = "low"
`,
  );
  f.write(`.codex/skills/${SKILL_NAME}-${v}/SKILL.md`, BODY_TEXT);
}

const KEY_RE = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*(\.h:[0-9a-f]{8})?$/;
const VALUE_RE = /^(h:[0-9a-f]{8}|unset|on|off|other)$/;

function assertSnapshotClean(s: ConfigSnapshot): void {
  for (const [k, v] of Object.entries(s.items)) {
    assert.match(k, KEY_RE, `key shape: ${k}`);
    if (typeof v === "string") assert.ok(VALUE_RE.test(v) || cleanLabel(v) === v, `value shape for ${k}`);
    else if (typeof v === "number") assert.ok(Number.isSafeInteger(v) && v >= 0, `number shape for ${k}`);
    else assert.equal(typeof v, "boolean");
  }
}

function assertEventClean(e: ChangeEvent): void {
  for (const text of [e.from, e.to]) assert.ok(/^h:[0-9a-f]{8}$/.test(text) || /^[A-Za-z0-9._\-[\]:+@ ]{1,60}$/.test(text), `event value shape: ${text}`);
  assert.match(e.id, /^c-[0-9a-f]{12}$/);
  if (e.note) assert.match(e.note, /^[A-Za-z0-9 ,;():.\-]+$/, `note shape: ${e.note}`);
}

test("no sentinel (secret, argument, path, rule, name, body text) reaches any snapshot, diagnostic or event", () => {
  const a = fx();
  const b = fx();
  hostileTree(a, "a");
  hostileTree(b, "b");

  const ra = (agent: "claude-code" | "codex") => collectConfig(agent, opts(a));
  const rb = (agent: "claude-code" | "codex") => collectConfig(agent, opts(b));
  const everything: unknown[] = [];

  for (const agent of ["claude-code", "codex"] as const) {
    const sa = ra(agent);
    const sb = rb(agent);
    assert.equal(sa.found, true);
    assertSnapshotClean(sa.snapshot);
    assertSnapshotClean(sb.snapshot);
    const events = diffSnapshots(sa.snapshot, { ...sb.snapshot, t: "2026-10-05T00:00:00.000Z" }, { hash });
    assert.ok(events.length > 0, `${agent}: variant b differs from a, so there must be events`);
    events.forEach(assertEventClean);
    const unsalted = diffSnapshots(sa.snapshot, sb.snapshot);
    unsalted.forEach(assertEventClean);
    everything.push(sa, sb, events, unsalted, mergeSnapshots(sa.snapshot, sb.snapshot));
  }
  everything.push(collectConfigSnapshots(opts(a)));

  const text = JSON.stringify(everything);
  for (const s of SENTINELS) assert.equal(text.includes(s), false, `leaked: ${s}`);
  for (const frag of ["apiKeyHelper", "ANTHROPIC_API_KEY", "Bearer", "installPath", "trust_level", "hiddenProjectServer", "npx", "--token", "Authorization"]) {
    assert.equal(text.includes(frag), false, `leaked fragment: ${frag}`);
  }
});

test("fields bound to a fixed vocabulary export a hash for a user-chosen word (the sentinels really are in the data)", () => {
  const f = fx();
  hostileTree(f, "a");
  const h = (v: string): string => shortHash(hash, v);
  const c = collectConfig("claude-code", opts(f)).snapshot.items;
  assert.equal(c["settings.permissions.mode"], h(`${PERM_MODE}a`));
  assert.equal(c[`settings.hooks.event.${h(`${HOOK_EVENT}a`)}`], 1);
  assert.equal(c["settings.hooks.event.PreToolUse"], 1, "a real event name is still readable");
  const x = collectConfig("codex", opts(f)).snapshot.items;
  assert.equal(x["config.profile"], h(`${PROFILE_NAME}a`));
  assert.equal(x["config.approval"], h(`${APPROVAL}a`));
  assert.equal(x["config.sandbox"], h(`${SANDBOX}a`));
  assert.equal(x["config.provider"], h(`${PROVIDER}a`));
  assert.equal(x["config.effort"], "low", "the active profile's override still applies");
});

test("env and header VALUES feed no item at all: trees that differ only in those values snapshot identically", () => {
  const build = (v: string): Fixture => {
    const f = fx();
    f.json(".claude/settings.json", { env: { KEY: v, OTHER: `${v}-2` }, model: "m" });
    f.json(".claude.json", {
      mcpServers: {
        s: { command: "c", args: ["a"], env: { T: v }, headers: { Authorization: `Bearer ${v}` } },
        h: { type: "http", url: "https://example.invalid", headers: { "X-Key": v } },
      },
    });
    f.write(
      ".codex/config.toml",
      `[mcp_servers.s]\ncommand = "c"\nenv = { T = "${v}" }\nhttp_headers = { Authorization = "Bearer ${v}" }\nenv_http_headers = { X = "${v}" }\n`,
    );
    return f;
  };
  const a = build("VALUE_ONE_SENTINEL");
  const b = build("VALUE_TWO_SENTINEL_LONGER");
  for (const agent of ["claude-code", "codex"] as const) {
    const sa = collectConfig(agent, opts(a)).snapshot;
    const sb = collectConfig(agent, opts(b)).snapshot;
    assert.deepEqual(sa.items, sb.items, agent);
    assert.deepEqual(diffSnapshots(sa, sb, { hash }), [], agent);
  }
  const c = collectConfig("claude-code", opts(a)).snapshot.items;
  assert.ok(c["settings.env.hash"] && c["claudejson.mcp.hash"]);
  // ...while key NAMES and the command/args are still tracked
  const keyRenamed = fx();
  keyRenamed.json(".claude/settings.json", { env: { RENAMED: "x", OTHER: "y" }, model: "m" });
  assert.notEqual(collectConfig("claude-code", opts(keyRenamed)).snapshot.items["settings.env.hash"], c["settings.env.hash"]);
});

test("the known facts are still reported (privacy did not just delete everything)", () => {
  const f = fx();
  hostileTree(f, "a");
  const c = collectConfig("claude-code", opts(f)).snapshot.items;
  assert.equal(c["settings.model"], "claude-opus-5-5");
  assert.equal(c["settings.env.count"], 2);
  assert.equal(c["settings.permissions.allow"], 2);
  assert.equal(c["settings.permissions.deny"], 1);
  assert.equal(c["claudejson.mcp.count"], 2);
  assert.equal(c["skills.count"], 1);
  const x = collectConfig("codex", opts(f)).snapshot.items;
  assert.equal(x["config.mcp.count"], 1);
  assert.equal(x["config.notify.present"], true);
  assert.equal(x["config.model"], "gpt-6-luna", "[profiles.*] without profile = ... is not the active model");
});

test("a hostile tree is collected in bounded time", () => {
  const f = fx();
  hostileTree(f, "a");
  f.write(".claude/CLAUDE.md", Buffer.alloc(5 * 1024 * 1024, "x"));
  f.write(".claude/settings.json", "[".repeat(2_000_000)); // over the cap
  f.write(".codex/config.toml", "= ".repeat(600_000)); // over the cap
  const t0 = Date.now();
  collectConfigSnapshots(opts(f));
  assert.ok(Date.now() - t0 < 5000);

  // under the cap but hostile: deep nesting, a flood of bad TOML lines
  f.write(".claude/settings.json", '{"x":' + "[".repeat(400_000) + "]".repeat(400_000) + "}");
  f.write(".codex/config.toml", "= x\n".repeat(200_000));
  const t1 = Date.now();
  const snaps = collectConfigSnapshots(opts(f));
  assert.ok(Date.now() - t1 < 5000);
  assert.equal(snaps.length, 2);
});

test("nothing outside the fixture home is read: an explicit home with an empty env never reaches the real ~/.claude or ~/.codex", () => {
  const f = fx();
  f.mkdir(".claude");
  // no .codex here: if the collector fell back to the real home, a Codex snapshot would appear on a dev machine
  const found = collectConfigSnapshots(opts(f)).map((s) => s.agent);
  assert.deepEqual(found, ["claude-code"]);
});
