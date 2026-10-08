import { test } from "node:test";
import assert from "node:assert/strict";
import { Rollout, testCtx, uuid, writeTree } from "../fixtures/codex/build.js";
import { scan } from "../fixtures/codex/harness.js";

const id = uuid(21);
const [E1, E2, E3] = [uuid(211), uuid(212), uuid(213)];

function session(): string {
  return new Rollout("2026-09-15T10:00:00Z")
    .meta({ id, cli: "0.159.0", baseInstructions: "base v1", dynamicTools: [{ name: "a" }] })
    .started(E1).ctx(E1, { model: "m1", effort: "low", approval: "never" }).user(E1, "one").usage(E1, "1", { input: 1, output: 1 }).complete(E1)
    // resumed under a newer CLI: own session_meta re-emitted with new version / instructions / tools
    .tick(60_000).meta({ id, cli: "0.160.0", baseInstructions: "base v2", dynamicTools: [{ name: "a" }, { name: "b" }] })
    .settings({ model: "m2" })
    .started(E2).ctx(E2, { model: "m2", effort: "high", approval: "never" }).user(E2, "two").usage(E2, "2", { input: 1, output: 1 }).complete(E2)
    .tick(60_000).started(E3).ctx(E3, { model: "m3", effort: "high", approval: "never" }).user(E3, "three").complete(E3)
    .text();
}

test("change events: side, strength and provenance per METHOD.md §9 (version bump, explicit settings, unrecorded moves)", async () => {
  const { root } = writeTree([{ id, content: session() }]);
  const { events, exchanges } = await scan(root);
  assert.deepEqual(events.map((e) => [e.kind, e.side, e.strength, e.provenance, e.userInitiated, e.t]), [
    // a version bump and what changed with it are routine background, never deciding
    ["version", "agent", "routine", "log_field", undefined, "2026-09-15T10:01:00.000Z"],
    ["system-prompt", "agent", "routine", "log_field", undefined, "2026-09-15T10:01:00.000Z"],
    ["config", "agent", "routine", "log_field", undefined, "2026-09-15T10:01:00.000Z"],
    // model: explicit thread_settings_applied → the user (a command record), even across a version change
    ["model", "you", "strong", "command", true, "2026-09-15T10:01:00.000Z"],
    // model moved with no settings record (picker, flag, profile…): unknown, weak (D33) — never `you` by inference
    ["model", "unknown", "weak", "log_field", false, "2026-09-15T10:02:00.000Z"],
    // effort changed at the same boundary as the CLI update, with no explicit setting → unknown
    ["effort", "unknown", "weak", "log_field", false, "2026-09-15T10:01:00.000Z"],
  ]);
  const v = events[0]!;
  assert.equal(v.from, "0.159.0");
  assert.equal(v.to, "0.160.0");
  const sp = events[1]!;
  assert.match(sp.from, /^h:[0-9a-f]{8}$/);
  assert.match(sp.to, /^h:[0-9a-f]{8}$/);
  assert.notEqual(sp.from, sp.to);
  assert.equal(sp.from, testCtx().hash("base v1", "h:").slice(0, 10), "salted short hash, never the text");
  assert.equal(events[2]!.note, "dynamic tools changed");
  assert.deepEqual(exchanges.map((e) => e.version), ["0.159.0", "0.160.0", "0.160.0"]);
  assert.deepEqual(exchanges.map((e) => e.model), ["m1", "m2", "m3"]);
  assert.ok(events.every((e) => e.day === "2026-09-15"));
});

test("change event ids are stable across rescans", async () => {
  const { root } = writeTree([{ id, content: session() }]);
  const a = await scan(root);
  const b = await scan(root);
  assert.deepEqual(a.events.map((e) => e.id), b.events.map((e) => e.id));
  assert.equal(new Set(a.events.map((e) => e.id)).size, a.events.length);
});

test("resumed without a version bump: base_instructions is context only (you·weak), tools unknown·weak, provider you·strong", async () => {
  const sid = uuid(22);
  const [F1, F2] = [uuid(221), uuid(222)];
  const content = new Rollout("2026-09-16T10:00:00Z")
    .meta({ id: sid, baseInstructions: "base v1", dynamicTools: [{ name: "a" }], provider: "synthetic-gateway-one" })
    .started(F1).ctx(F1).user(F1, "one").usage(F1, "1", { input: 1, output: 1 }).complete(F1)
    .tick(60_000)
    .meta({ id: sid, baseInstructions: "base v2", dynamicTools: [{ name: "a" }, { name: "b" }], provider: "synthetic-gateway-two" })
    .started(F2).ctx(F2).user(F2, "two").usage(F2, "2", { input: 1, output: 1 }).complete(F2)
    .text();
  const { root } = writeTree([{ id: sid, content }]);
  const { events } = await scan(root);
  assert.deepEqual(events.map((e) => [e.kind, e.side, e.strength, e.provenance, e.note]), [
    ["system-prompt", "you", "weak", "log_field", "base instructions changed (context only)"],
    ["config", "unknown", "weak", "log_field", "dynamic tools changed"],
    ["config", "you", "strong", "log_field", "model_provider changed"],
  ]);
  const p = events[2]!;
  assert.equal(p.from, testCtx().hash("synthetic-gateway-one", "h:").slice(0, 10), "provider stored as a salted short hash");
  assert.equal(p.to, testCtx().hash("synthetic-gateway-two", "h:").slice(0, 10));
  assert.ok(!JSON.stringify(events).includes("synthetic-gateway"), "the provider name never leaves the parser");
  assert.ok(events.every((e) => !(e.kind === "system-prompt" && (e.side === "unknown" || e.strength === "strong"))),
    "base_instructions never decides: not strong, and not unknown (an unknown candidate decides unclear, METHOD.md §11 row 5)");
});
