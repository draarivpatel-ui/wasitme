/**
 * Format fidelity: the generated logs follow the field names / enums a counts-only check of real logs found, and
 * contain the quirks real parsers get wrong. Counts of planted noise (replays, split lines, snapshot extras,
 * archived copies...) are cross-checked against raw counts of the files: raw - planted noise = logical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, type Generated } from "../src/synth/generate.js";
import { claudePatch, CLAUDE_MODERN_FROM } from "../src/synth/schedule.js";
import { findScenario } from "../src/synth/scenarios.js";

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Line { path: string; rec: Rec; raw: string }

let cached: Generated | undefined;
function both(): Generated {
  if (!cached) cached = generate(findScenario("both-agents")!.build({}), "both-agents");
  return cached;
}

function lines(g: Generated, prefix: string, suffix = ".jsonl"): Line[] {
  const out: Line[] = [];
  for (const f of g.files) {
    if (!f.path.startsWith(prefix) || !f.path.endsWith(suffix)) continue;
    for (const raw of String(f.data).split("\n")) if (raw) out.push({ path: f.path, rec: JSON.parse(raw) as Rec, raw });
  }
  return out;
}

const claudeMain = (g: Generated): Line[] => lines(g, "claude/projects/").filter((l) => l.path.split("/").length === 4);
const claudeSub = (g: Generated): Line[] => lines(g, "claude/projects/").filter((l) => l.path.includes("/subagents/") && l.path.split("/").pop()!.startsWith("agent-"));
const codexLines = (g: Generated): Line[] => lines(g, "codex/");

// ============================================================================ Claude

test("Claude: record envelopes carry the real logs' field names, with modern-era fields only from the right version", () => {
  const g = both();
  const users = claudeMain(g).filter((l) => l.rec.type === "user" && l.rec.promptSource === "typed");
  assert.ok(users.length > 300);
  for (const { rec } of users.slice(0, 200)) {
    for (const k of ["parentUuid", "isSidechain", "promptId", "message", "uuid", "timestamp", "permissionMode", "promptSource", "origin", "userType", "entrypoint", "cwd", "sessionId", "version", "gitBranch", "slug"]) {
      assert.ok(k in rec, `user record lacks ${k}`);
    }
    assert.equal(rec.message.role, "user");
    assert.match(rec.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  const assistants = claudeMain(g).filter((l) => l.rec.type === "assistant" && l.rec.message.model !== "<synthetic>");
  for (const { rec } of assistants.slice(0, 200)) {
    for (const k of ["requestId", "uuid", "timestamp", "message", "sessionId", "version"]) assert.ok(k in rec, `assistant lacks ${k}`);
    for (const k of ["model", "id", "role", "content", "stop_reason", "usage"]) assert.ok(k in rec.message, `message lacks ${k}`);
    for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "cache_creation", "service_tier"]) assert.ok(k in rec.message.usage, `usage lacks ${k}`);
  }
  // Era: origin / permissionMode on user prompts and effort on assistants appear exactly from CLAUDE_MODERN_FROM on.
  let legacy = 0;
  for (const l of claudeMain(g)) {
    const modern = claudePatch(l.rec.version ?? "") >= CLAUDE_MODERN_FROM;
    if (l.rec.type === "assistant" && l.rec.message.model !== "<synthetic>") assert.equal("effort" in l.rec, modern, `${l.rec.version}`);
    if (l.rec.type === "user" && l.rec.promptId !== undefined) assert.ok(modern);
    if (!modern && l.rec.type === "user") { legacy++; assert.ok(!("origin" in l.rec) && !("permissionMode" in l.rec)); }
  }
  assert.ok(legacy > 0, "some legacy-era records exist");
});

test("Claude: one API response is split over several lines (same message.id and requestId, output tokens growing)", () => {
  const g = both();
  const byReq = new Map<string, Line[]>();
  const seenUuid = new Set<string>();
  for (const l of [...claudeMain(g), ...claudeSub(g)]) {
    if (l.rec.type !== "assistant" || !l.rec.requestId) continue;
    if (seenUuid.has(l.rec.uuid)) continue; // a resumed session's replay of the same line
    seenUuid.add(l.rec.uuid);
    byReq.set(l.rec.requestId, [...(byReq.get(l.rec.requestId) ?? []), l]);
  }
  let extra = 0;
  let nullFinal = 0;
  let multi = 0;
  for (const ls of byReq.values()) {
    extra += ls.length - 1;
    if (ls.length < 2) continue;
    multi++;
    assert.equal(new Set(ls.map((l) => l.rec.message.id)).size, 1);
    assert.equal(new Set(ls.map((l) => l.rec.message.usage.input_tokens)).size, 1, "input tokens repeat identically");
    const outs = ls.map((l) => l.rec.message.usage.output_tokens as number);
    for (let i = 1; i < outs.length; i++) assert.ok(outs[i]! >= outs[i - 1]!, "output tokens never shrink");
    assert.equal(outs[outs.length - 1], Math.max(...outs), "the last line holds the max");
    assert.ok(outs[0]! < outs[outs.length - 1]!, "the first line is not the answer");
    for (const l of ls.slice(0, -1)) assert.equal(l.rec.message.stop_reason, null);
    if (ls[ls.length - 1]!.rec.message.stop_reason === null) nullFinal++;
    assert.equal(new Set(ls.map((l) => l.rec.uuid)).size, ls.length, "each line has its own uuid");
  }
  assert.ok(multi > 1000);
  assert.equal(extra, both().truth.noise.claude!.streamingExtraLines, "raw lines - responses = planted split lines");
  assert.ok(nullFinal > 0, "some final lines carry stop_reason null too");
});

test("Claude: resumed sessions replay earlier records with identical uuids under a foreign sessionId", () => {
  const g = both();
  const all = claudeMain(g);
  const withUuid = all.filter((l) => typeof l.rec.uuid === "string");
  const distinct = new Set(withUuid.map((l) => l.rec.uuid));
  assert.equal(withUuid.length - distinct.size, g.truth.noise.claude!.replayedRecords, "raw - distinct uuids = planted replays");
  assert.ok(g.truth.noise.claude!.replayedRecords > 100);
  const seen = new Map<string, Line>();
  let foreign = 0;
  for (const l of withUuid) {
    const first = seen.get(l.rec.uuid);
    if (!first) { seen.set(l.rec.uuid, l); continue; }
    assert.notEqual(first.path, l.path, "duplicates live in a different file");
    assert.equal(first.raw, l.raw, "a replay is byte-identical to the original record");
    const own = l.path.split("/").pop()!.replace(".jsonl", "");
    if (l.rec.sessionId !== own) foreign++;
  }
  assert.ok(foreign > 100, "replayed records carry a sessionId that is not their file's own");
  // The replayed human prompts are exactly what the planted-noise counter says.
  assert.ok(g.truth.noise.claude!.replayedHumanPrompts > 5);
});

test("Claude: queued prompts are queued_command attachments next to queue-operation records; peers and notifications are noise", () => {
  const g = both();
  const all = claudeMain(g);
  const queued = all.filter((l) => l.rec.type === "attachment" && l.rec.attachment.type === "queued_command");
  const human = queued.filter((l) => l.rec.isMeta !== true && (l.rec.attachment.origin === undefined || l.rec.attachment.origin.kind === "human"));
  const unique = new Set(human.map((l) => l.rec.uuid));
  assert.equal(unique.size, g.truth.totals["claude-code"]!.queuedMidTurn!, "human queued commands (replays aside) = planted");
  assert.ok(queued.some((l) => l.rec.attachment.origin?.kind === "peer"));
  assert.ok(queued.some((l) => l.rec.isMeta === true && l.rec.attachment.origin?.kind === "task-notification"));
  assert.ok(queued.some((l) => Array.isArray(l.rec.attachment.prompt)), "prompt as a block list");
  assert.ok(queued.some((l) => typeof l.rec.attachment.prompt === "string"), "prompt as a string");
  const ops = all.filter((l) => l.rec.type === "queue-operation");
  assert.ok(ops.some((l) => l.rec.operation === "enqueue" && typeof l.rec.content === "string"));
  assert.ok(ops.some((l) => l.rec.operation === "remove"));
  assert.equal(ops.filter((l) => l.rec.operation === "enqueue").length, ops.filter((l) => l.rec.operation === "remove").length);
});

test("Claude: interrupts come as list-form and string-form texts, 'for tool use' after a rejected call", () => {
  const g = both();
  const all = claudeMain(g);
  const interrupts = all.filter((l) => l.rec.type === "user" && JSON.stringify(l.rec.message.content).includes("[Request interrupted by user"));
  assert.ok(interrupts.some((l) => Array.isArray(l.rec.message.content) && l.rec.message.content[0].text === "[Request interrupted by user]"), "list form");
  assert.ok(interrupts.some((l) => typeof l.rec.message.content === "string"), "string form");
  const forTool = interrupts.filter((l) => JSON.stringify(l.rec.message.content).includes("for tool use"));
  assert.ok(forTool.length > 3);
  for (const l of forTool) {
    const idx = all.indexOf(all.find((x) => x.rec.uuid === l.rec.uuid)!);
    const prev = all.slice(Math.max(0, idx - 6), idx).reverse().find((x) => x.rec.type === "user" && x.rec.toolDenialKind);
    assert.equal(prev?.rec.toolDenialKind, "user-rejected", "a tool-use interrupt follows a user-rejected tool result");
  }
});

test("Claude: toolDenialKind separates user rejections from auto-mode blocks and permission rules from real failures", () => {
  const g = both();
  const results = claudeMain(g).filter((l) => l.rec.type === "user" && Array.isArray(l.rec.message.content) && l.rec.message.content[0]?.type === "tool_result");
  const kinds = new Map<string, number>();
  for (const l of results) if (l.rec.toolDenialKind) kinds.set(l.rec.toolDenialKind, (kinds.get(l.rec.toolDenialKind) ?? 0) + 1);
  for (const k of ["user-rejected", "automode-blocked", "permission-rule", "automode-unavailable"]) assert.ok((kinds.get(k) ?? 0) > 2, `${k}: ${kinds.get(k)}`);
  for (const l of results) {
    if (l.rec.toolDenialKind) assert.equal(l.rec.message.content[0].is_error, true, "denials are errors too (the trap)");
    assert.ok("toolUseResult" in l.rec && "sourceToolAssistantUUID" in l.rec);
  }
  const plainErrors = results.filter((l) => l.rec.message.content[0].is_error === true && !l.rec.toolDenialKind);
  assert.ok(plainErrors.length > 100);
});

test("Claude: api_error retries, final API failures, compactions and thinking blocks", () => {
  const g = both();
  const all = claudeMain(g);
  const retries = all.filter((l) => l.rec.type === "system" && l.rec.subtype === "api_error");
  assert.ok(retries.length > 100);
  for (const { rec } of retries.slice(0, 100)) {
    assert.ok(Number.isInteger(rec.retryAttempt) && rec.retryAttempt >= 1);
    assert.ok(rec.maxRetries >= rec.retryAttempt && rec.retryInMs > 0);
    assert.ok([429, 500, 529].includes(rec.error.status));
  }
  const failures = all.filter((l) => l.rec.type === "assistant" && l.rec.isApiErrorMessage === true);
  assert.ok(failures.length > 5);
  for (const { rec } of failures) {
    assert.equal(rec.message.model, "<synthetic>");
    assert.equal(rec.apiErrorStatus, 529);
    assert.equal(rec.requestId, undefined, "no requestId on a synthetic error stub");
  }
  const bounds = all.filter((l) => l.rec.type === "system" && l.rec.subtype === "compact_boundary");
  assert.ok(bounds.length >= 3);
  for (const b of bounds) {
    assert.deepEqual(Object.keys(b.rec.compactMetadata).sort(), ["postTokens", "preTokens", "trigger"]);
    const next = all[all.indexOf(b) + 1]!;
    assert.equal(next.rec.isCompactSummary, true);
  }
  const blocks = all.filter((l) => l.rec.type === "assistant").flatMap((l) => l.rec.message.content as Rec[]).filter((b) => b.type === "thinking");
  const redacted = blocks.filter((b) => b.thinking === "");
  assert.ok(redacted.length > 500 && blocks.length - redacted.length > 500);
  for (const b of blocks) assert.ok(typeof b.signature === "string" && b.signature.length >= 40);
  const lens = new Set(blocks.map((b) => b.signature.length));
  assert.ok(lens.size > 100, "signature length varies (it is the depth proxy)");
});

test("Claude: attachments carry config evidence; only documented record types appear", () => {
  const g = both();
  const all = claudeMain(g);
  const types = new Set(all.filter((l) => l.rec.type === "attachment").map((l) => l.rec.attachment.type));
  for (const t of ["environment", "identity", "skill_listing", "deferred_tools_delta", "instructions", "system_prompt", "queued_command", "total_tokens_reminder"]) assert.ok(types.has(t), t);
  const identity = all.find((l) => l.rec.type === "attachment" && l.rec.attachment.type === "identity")!;
  assert.deepEqual(Object.keys(identity.rec.attachment).sort(), ["knowledgeCutoff", "marketingName", "modelId", "type"]);
  const known = new Set(["user", "assistant", "system", "attachment", "queue-operation", "permission-mode", "file-history-snapshot", "ai-title", "last-prompt", "cost-state"]);
  for (const l of all) assert.ok(known.has(l.rec.type), `unexpected record type ${l.rec.type}`);
  const systems = new Set(all.filter((l) => l.rec.type === "system").map((l) => l.rec.subtype));
  for (const s of ["api_error", "compact_boundary", "turn_duration", "stop_hook_summary"]) assert.ok(systems.has(s), s);
});

test("Claude: subagent files (plain and workflow-nested) with sidechain records, metadata and journals", () => {
  const g = both();
  const subs = g.files.filter((f) => f.path.includes("/subagents/"));
  const agentFiles = subs.filter((f) => /\/agent-[0-9a-f]+\.jsonl$/.test(f.path));
  assert.equal(agentFiles.length, g.truth.noise.claude!.subagentFiles);
  assert.ok(agentFiles.some((f) => f.path.includes("/subagents/workflows/")), "workflow-nested subagents exist");
  assert.ok(agentFiles.some((f) => !f.path.includes("/workflows/")));
  assert.equal(subs.filter((f) => f.path.endsWith("/journal.jsonl")).length, g.truth.noise.claude!.workflowJournals);
  assert.equal(subs.filter((f) => f.path.endsWith(".meta.json")).length, agentFiles.length);
  for (const f of agentFiles.slice(0, 20)) {
    const recs = String(f.data).split("\n").filter(Boolean).map((x) => JSON.parse(x) as Rec);
    assert.equal(recs[0]!.parentUuid, null, "subagent files start with a null parentUuid");
    assert.ok(recs.every((r) => r.isSidechain === true && typeof r.agentId === "string"));
    const sid = f.path.split("/")[3]!;
    assert.ok(recs.every((r) => r.sessionId === sid), "sidechain records carry the parent session id");
  }
});

test("Claude: a clock reset leaves a record stamped before its own prompt, and nothing yields a negative duration", () => {
  const g = both();
  const glitched = g.rows.filter((r) => r.clockGlitch);
  assert.ok(glitched.length >= 3);
  assert.ok(g.rows.every((r) => r.durationMs >= 0));
  const ex = glitched.find((r) => r.agent === "claude-code")!;
  const recs = claudeMain(g).filter((l) => l.path === ex.session);
  const idx = recs.findIndex((l) => l.rec.timestamp === ex.t && l.rec.type !== "attachment");
  assert.ok(idx >= 0);
  let end = idx;
  while (end + 1 < recs.length && !(recs[end + 1]!.rec.type === "user" && recs[end + 1]!.rec.origin?.kind === "human") && recs[end + 1]!.rec.type !== undefined) {
    end++;
    if (recs[end]!.rec.type === "system" && recs[end]!.rec.subtype === "turn_duration") break;
  }
  assert.ok(Date.parse(recs[end]!.rec.timestamp) < Date.parse(ex.t), "the exchange ends with a timestamp from before it began");
});

// ============================================================================ Codex

test("Codex: envelopes, session_meta, turn_context and token records follow the documented shapes", () => {
  const g = both();
  const all = codexLines(g);
  assert.ok(all.length > 10_000);
  const metas = all.filter((l) => l.rec.type === "session_meta");
  assert.ok(metas.length > 200);
  for (const { rec } of metas.slice(0, 100)) {
    for (const k of ["timestamp", "cwd", "originator", "cli_version", "source", "model_provider", "git"]) assert.ok(k in rec.payload, `session_meta lacks ${k}`);
    assert.ok("session_id" in rec.payload || "id" in rec.payload);
  }
  const contexts = all.filter((l) => l.rec.type === "turn_context");
  for (const { rec } of contexts.slice(0, 100)) for (const k of ["turn_id", "cwd", "approval_policy", "model", "effort", "summary", "sandbox_policy"]) assert.ok(k in rec.payload, `turn_context lacks ${k}`);
  const usage = all.filter((l) => l.rec.type === "token_usage_record");
  for (const { rec } of usage.slice(0, 100)) {
    for (const k of ["response_id", "turn_id", "usage", "turn_token_usage"]) assert.ok(k in rec.payload);
    for (const k of ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]) assert.ok(k in rec.payload.usage);
    assert.ok(rec.payload.usage.cached_input_tokens <= rec.payload.usage.input_tokens, "input includes cached");
    assert.ok(rec.payload.usage.reasoning_output_tokens <= rec.payload.usage.output_tokens, "reasoning is inside output");
  }
  const types = new Set(all.map((l) => l.rec.type));
  for (const t of ["session_meta", "turn_context", "event_msg", "response_item", "token_usage_record", "compacted"]) assert.ok(types.has(t), t);
  const events = new Set(all.filter((l) => l.rec.type === "event_msg").map((l) => l.rec.payload.type));
  for (const t of ["task_started", "task_complete", "turn_aborted", "token_count", "item_completed", "user_message", "agent_message", "exec_command_end", "patch_apply_end", "mcp_tool_call_end"]) assert.ok(events.has(t), t);
});

test("Codex: paginated and legacy rollouts differ the way research/07 says", () => {
  const g = both();
  let paginated = 0;
  let legacy = 0;
  for (const f of g.files) {
    if (!f.path.startsWith("codex/") || !f.path.endsWith(".jsonl")) continue;
    const recs = String(f.data).split("\n").filter(Boolean).map((x) => JSON.parse(x) as Rec);
    if (!recs.some((r) => r.type === "turn_context" || r.payload?.type === "task_started")) continue;
    const meta = recs.find((r) => r.type === "session_meta")!.payload as Rec;
    const hasItems = recs.some((r) => r.payload?.type === "item_completed");
    if (hasItems) {
      paginated++;
      assert.ok(recs.every((r, i) => r.ordinal === i), "paginated rollouts number their records");
      assert.ok("session_id" in meta && !("id" in meta));
      assert.ok("base_instructions" in meta);
      assert.ok(recs.some((r) => r.type === "response_item" && r.payload.type === "message"), "raw response_item mirrors sit next to the items");
      assert.ok(!recs.some((r) => r.payload?.type === "exec_command_end" || r.payload?.type === "patch_apply_end"));
    } else {
      legacy++;
      assert.ok(recs.every((r) => !("ordinal" in r)), "legacy rollouts carry no ordinal");
      assert.ok("id" in meta && !("session_id" in meta), "old metadata uses id");
      assert.ok(typeof meta.instructions === "string");
    }
  }
  assert.ok(paginated > 100 && legacy > 20, `${paginated} paginated, ${legacy} legacy`);
});

test("Codex: streaming token snapshots share a response_id; token_count repeats byte-for-byte", () => {
  const g = both();
  const byFile = new Map<string, Line[]>();
  for (const l of codexLines(g)) byFile.set(l.path, [...(byFile.get(l.path) ?? []), l]);
  let repeats = 0;
  let counts = 0;
  const snapshots = new Set<string>();
  const responses = new Set<string>();
  for (const ls of byFile.values()) {
    const byResp = new Map<string, number[]>();
    let prev = "";
    for (const l of ls) {
      if (l.rec.type === "token_usage_record") {
        const arr = byResp.get(l.rec.payload.response_id) ?? [];
        arr.push(l.rec.payload.usage.output_tokens);
        byResp.set(l.rec.payload.response_id, arr);
        // Legacy-fork replays and archived copies repeat whole responses; collapse them by (response, snapshot).
        snapshots.add(`${l.rec.payload.response_id}|${l.rec.payload.usage.output_tokens}`);
        responses.add(l.rec.payload.response_id);
      }
      if (l.rec.type === "event_msg" && l.rec.payload.type === "token_count") {
        counts++;
        const key = l.raw.replace(/"ordinal":\d+,/, "");
        if (key === prev) repeats++;
        prev = key;
      } else if (l.rec.type !== "event_msg") prev = "";
    }
    for (const outs of byResp.values()) {
      for (let i = 1; i < outs.length; i++) assert.ok(outs[i]! >= outs[i - 1]!);
      assert.equal(outs[outs.length - 1], Math.max(...outs), "the last snapshot is the final usage");
    }
  }
  const n = g.truth.noise.codex!;
  assert.equal(snapshots.size - responses.size, n.tokenSnapshotExtras, "distinct snapshots - responses = planted snapshot extras");
  assert.ok(repeats >= n.tokenCountRepeats && counts >= n.tokenCountRecords);
});

test("Codex: forks (legacy copies the parent's turns, paginated references them), imported stubs, subagent and exec threads", () => {
  const g = both();
  const all = codexLines(g);
  const metas = all.filter((l) => l.rec.type === "session_meta");
  const forks = metas.filter((l) => l.rec.payload.forked_from_id);
  assert.ok(forks.length >= 5, `${forks.length} forks`);
  assert.ok(forks.some((l) => l.rec.payload.history_base), "paginated forks reference their parent");
  assert.ok(forks.some((l) => !l.rec.payload.history_base), "legacy forks copy history");
  const turnFiles = new Map<string, Set<string>>();
  for (const l of all) if (l.rec.type === "turn_context" && l.path.startsWith("codex/sessions/")) turnFiles.set(l.rec.payload.turn_id, (turnFiles.get(l.rec.payload.turn_id) ?? new Set()).add(l.path));
  const copied = [...turnFiles.values()].filter((s) => s.size > 1).length;
  assert.equal(copied, g.truth.noise.codex!.forkReplayedTurns, "turn ids that appear in two rollouts = planted replays");
  assert.ok(copied >= 1);

  // Imported / stub turns: a turn with a UserMessage but no turn_context.
  const started = all.filter((l) => l.rec.payload?.type === "task_started").map((l) => l.rec.payload.turn_id as string);
  const withContext = new Set(all.filter((l) => l.rec.type === "turn_context").map((l) => l.rec.payload.turn_id as string));
  assert.equal(started.filter((id) => !withContext.has(id)).length, g.truth.noise.codex!.importedStubTurns);

  // Subagent threads: parent_thread_id + agent_role, linked from the parent's CollabAgentToolCall.
  const subs = metas.filter((l) => l.rec.payload.parent_thread_id);
  assert.equal(subs.length, g.truth.noise.codex!.subagentThreads);
  assert.ok(subs.every((l) => l.rec.payload.agent_role && l.rec.payload.agent_nickname && l.rec.payload.source?.subagent));
  const spawned = new Set(all.filter((l) => l.rec.payload?.item?.type === "CollabAgentToolCall").flatMap((l) => l.rec.payload.item.receiver_thread_ids as string[]));
  const legacySpawns = all.filter((l) => l.rec.type === "response_item" && l.rec.payload.type === "function_call" && l.rec.payload.name === "spawn_agent").length;
  assert.ok(subs.length === 0 || spawned.size > 0 || legacySpawns > 0);
  for (const id of spawned) assert.ok(subs.some((l) => l.rec.payload.session_id === id || l.rec.payload.id === id), "every spawned thread has its rollout");

  // exec threads are non-interactive.
  const exec = metas.filter((l) => l.rec.payload.source === "exec");
  assert.equal(exec.length, g.truth.noise.codex!.execSessions);
  assert.ok(exec.every((l) => l.rec.payload.originator === "codex_exec"));
});

test("Codex: aborted turns (user vs other reasons), injected context messages, migrated duplicates", () => {
  const g = both();
  const all = codexLines(g);
  const reasons = new Set(all.filter((l) => l.rec.payload?.type === "turn_aborted").map((l) => l.rec.payload.reason));
  assert.deepEqual([...reasons].sort(), ["interrupted", "replaced"]);
  const injected = new Set<string>();
  for (const l of all) {
    const text = l.rec.payload?.item?.type === "UserMessage" ? String(l.rec.payload.item.content?.[0]?.text) : "";
    for (const prefix of ["<environment_context>", "# AGENTS.md instructions", "<turn_aborted>", "<subagent_notification>"]) if (text.startsWith(prefix)) injected.add(prefix);
  }
  assert.equal(injected.size, 4, [...injected].join(","));
  // A migrated message is recorded twice in one turn: as a canonical item and as a legacy user_message event.
  let dup = 0;
  const byTurn = new Map<string, { item: string[]; event: string[] }>();
  for (const l of all) {
    const p = l.rec.payload;
    if (p?.type === "item_completed" && p.item.type === "UserMessage") {
      const t = byTurn.get(p.turn_id) ?? { item: [], event: [] };
      t.item.push(p.item.content[0].text);
      byTurn.set(p.turn_id, t);
    }
  }
  let currentTurn = "";
  for (const l of all) {
    const p = l.rec.payload;
    if (p?.type === "task_started") currentTurn = p.turn_id;
    if (p?.type === "user_message" && p.images && byTurn.get(currentTurn)?.item.includes(p.message)) dup++;
  }
  assert.ok(dup > 20 && dup >= g.truth.noise.codex!.migratedDuplicateMessages * 0.9, `${dup} migrated duplicates`);
});

test("Codex: archived_sessions holds moved rollouts and byte-identical copies of live ones (same basename)", () => {
  const g = both();
  const live = new Map<string, string>();
  const archived = new Map<string, string>();
  for (const f of g.files) {
    const name = f.path.split("/").pop()!;
    if (f.path.startsWith("codex/sessions/") && name.startsWith("rollout-")) live.set(name, String(f.data));
    if (f.path.startsWith("codex/archived_sessions/")) archived.set(name, String(f.data));
  }
  assert.match([...archived.keys()][0]!, /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f-]{36}\.jsonl$/);
  let copies = 0;
  let moved = 0;
  for (const [name, data] of archived) {
    if (live.has(name)) { copies++; assert.equal(live.get(name), data, "an archived copy is byte-identical"); } else moved++;
  }
  assert.equal(copies, g.truth.noise.codex!.archivedCopied);
  assert.equal(moved, g.truth.noise.codex!.archivedMoved);
  assert.ok(copies > 3 && moved > 10);
  for (const name of live.keys()) assert.match(name, /^rollout-/);
  const livePaths = g.files.filter((f) => f.path.startsWith("codex/sessions/")).map((f) => f.path);
  assert.ok(livePaths.every((p) => /^codex\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-/.test(p)), "live rollouts sit under sessions/YYYY/MM/DD");
});
