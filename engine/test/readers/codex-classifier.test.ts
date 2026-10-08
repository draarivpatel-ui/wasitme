/**
 * Labelled-day check for the Codex interactive / scripted classifier (METHOD.md §2, WP-11Δ acceptance). A synthetic day:
 * one rollout per launch surface and edge case, each labelled by hand with the class its session should get. Real-log
 * counts are WP-24a's job; nothing here is copied or derived from a real session log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionFlags } from "../../src/readers/codex/session.js";
import type { InteractiveClass } from "../../src/types.js";
import { Rollout, uuid, writeTree, type MetaOpts } from "../fixtures/codex/build.js";
import { scan } from "../fixtures/codex/harness.js";

interface Labelled {
  what: string;
  meta: Omit<MetaOpts, "id"> | null;
  label: InteractiveClass;
  /** Start the session with a heartbeat-triggered stretch before the first prompt. */
  heartbeat?: boolean;
}

const MISSING_PARENT = uuid(2999);

const DAY: Labelled[] = [
  { what: "Codex Desktop app", meta: { source: "vscode", originator: "Codex Desktop" }, label: "interactive" },
  { what: "VS Code extension", meta: { source: "vscode", originator: "codex_vscode" }, label: "interactive" },
  { what: "terminal UI", meta: { source: "cli", originator: "codex-tui" }, label: "interactive" },
  { what: "terminal UI, generic default originator", meta: { source: "cli", originator: "codex_cli_rs" }, label: "interactive" },
  { what: "codex exec", meta: { source: "exec", originator: "codex_exec" }, label: "scripted" },
  { what: "TypeScript SDK (runs exec)", meta: { source: "exec", originator: "codex_sdk_ts" }, label: "scripted" },
  { what: "Codex as an MCP server", meta: { source: "mcp", originator: "codex_cli_rs" }, label: "scripted" },
  {
    what: "orphaned subagent (parent file gone)",
    meta: { source: { subagent: { thread_spawn: { parent_thread_id: MISSING_PARENT, depth: 1 } } }, threadSource: "subagent", parent: MISSING_PARENT },
    label: "scripted",
  },
  { what: "agent-created thread", meta: { source: "vscode", threadSource: "agent_created_thread" }, label: "scripted" },
  { what: "agent role set", meta: { source: "cli", originator: "codex-tui", agentRole: "worker" }, label: "scripted" },
  { what: "contradiction: interactive source, exec originator", meta: { source: "cli", originator: "codex_exec" }, label: "unknown" },
  { what: "contradiction: exec source, Desktop originator", meta: { source: "exec", originator: "Codex Desktop" }, label: "unknown" },
  { what: "no source, TUI originator", meta: { originator: "codex-tui", omit: ["source"] }, label: "interactive" },
  { what: "no source, exec originator", meta: { originator: "codex_exec", omit: ["source"] }, label: "scripted" },
  { what: "no source, no originator", meta: { omit: ["source", "originator"] }, label: "unknown" },
  { what: "no source, generic default originator", meta: { originator: "codex_cli_rs", omit: ["source"] }, label: "unknown" },
  { what: "unrecognised source, Desktop originator", meta: { source: "desktop-preview", originator: "Codex Desktop" }, label: "interactive" },
  { what: "Desktop session woken by a heartbeat, then typed into", meta: { source: "vscode", originator: "Codex Desktop" }, label: "interactive", heartbeat: true },
  { what: "no session_meta at all", meta: null, label: "unknown" },
];

function rollout(i: number, l: Labelled): { id: string; content: string; stamp: string } {
  const id = uuid(2000 + i);
  const hh = String(i).padStart(2, "0");
  const r = new Rollout(`2026-09-24T${hh}:00:00Z`);
  if (l.meta) r.meta({ id, ...l.meta });
  if (l.heartbeat) {
    const h = uuid(20000 + i * 10);
    r.started(h).ctx(h).user(h, "<heartbeat>\n<id>wake</id>\n</heartbeat>").cmd(h).complete(h).tick(60_000);
  }
  const t = uuid(20000 + i * 10 + 1);
  r.started(t).ctx(t).user(t, `synthetic prompt ${i}`).cmd(t).usage(t, `u${i}`, { input: 1, output: 1 }).complete(t);
  return { id, content: r.text(), stamp: `2026-09-24T${hh}-00-00` };
}

test("labelled day: every exchange gets its session's hand label (zero mismatches)", async () => {
  const files = DAY.map((l, i) => rollout(i, l));
  const s = await scan(writeTree(files).root, files.map((f) => f.id));
  const mismatches: string[] = [];
  const confusion = new Map<string, number>();
  DAY.forEach((l, i) => {
    const xs = s.byThread.get(files[i]!.id)!.exchanges;
    if (!xs.length) mismatches.push(`${l.what}: no exchanges`);
    for (const e of xs) {
      const key = `${l.label}→${e.interactiveClass}`;
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
      if (e.interactiveClass !== l.label) mismatches.push(`${l.what}: labelled ${l.label}, got ${e.interactiveClass}`);
    }
  });
  assert.deepEqual(mismatches, [], `confusion: ${JSON.stringify([...confusion])}`);
  const counted = [...confusion.values()].reduce((a, b) => a + b, 0);
  assert.equal(counted, DAY.length + 1, "one exchange per session, two for the heartbeat-started one");
  // The class never becomes a label of its own: entrypoint stays the source enum.
  for (const e of s.exchanges) assert.ok(["cli", "vscode", "exec", "mcp", "subagent", "other", "unknown"].includes(e.entrypoint));
});

test("classifier unit: sessionFlags reads only source / originator / thread_source / parent / agent_role", () => {
  const c = (p: Record<string, unknown>) => sessionFlags(p).interactiveClass;
  assert.equal(c({ source: "vscode", originator: "Codex Desktop" }), "interactive");
  assert.equal(c({ source: "exec" }), "scripted");
  assert.equal(c({ source: "subagent" }), "scripted", "a string subagent source is a spawned thread too");
  assert.equal(c({ source: "cli", parent_thread_id: "x" }), "scripted");
  assert.equal(c({ source: "cli", thread_source: "guardian_review" }), "scripted");
  assert.equal(c({ source: "cli", originator: "codex_sdk_ts" }), "unknown");
  assert.equal(c({}), "unknown");
  assert.equal(c({ source: "vscode", originator: "some-new-client" }), "interactive", "an unknown originator is neutral");
  assert.equal(c({ source: "cli", cwd: "/x", model_provider: "y", cli_version: "1" }), "interactive", "nothing else is read");
  const f = sessionFlags({ source: "exec", originator: "codex_exec" });
  assert.deepEqual(f, { entrypoint: "exec", automated: false, scripted: true, interactiveClass: "scripted" });
});
