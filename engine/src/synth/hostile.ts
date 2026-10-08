/**
 * The hostile corpus: logs a careless parser would choke on or leak from. Everything is synthetic.
 *
 *   small tier (committed under testdata/hostile): secrets in every field that can carry text, ANSI /
 *     bidi / HTML poison in label fields, malformed and truncated lines, unknown record types, odd
 *     timestamps, U+2028/2029, deep nesting, BOM + CRLF, binary garbage, zero-byte files, orphan
 *     subagent files, archived duplicates, forks of nothing.
 *   full tier (generated on demand, never committed): the small tier plus a 25 MB single line (valid
 *     JSON with a canary inside), a 200,000-deep object, a 1.2 MB line, a symlink loop, a mutual
 *     symlink pair, and a symlink to a directory outside the scanned tree.
 *
 * Every planted sentinel string carries `SYNTHCANARY<5 digits>` and is registered, so CANARIES.txt is
 * complete by construction (a test re-derives it from the tree). Control characters and bidi marks are
 * JSON-escaped on disk so the fixture is safe to view and diff; U+2028/2029 stay raw because that is
 * the point of that file. The secret-shaped strings are deliberately off-spec (wrong length / no
 * checksum) so they look wrong to real secret scanners and right to ours.
 */
import { Rng } from "./rng.js";
import { iso, type OutFile } from "./emit.js";
import type { OutLink } from "./write.js";

export type HostileTier = "small" | "full";

export interface CanaryInfo { id: string; kind: string; value: string; where: string[] }
export interface PoisonInfo { id: string; kind: string; escaped: string }
export interface FileExpect {
  path: string;
  kind: string;
  /** Lines that are not a JSON object (readJsonl badLines). Null when policy-dependent. */
  badLines: number | null;
  truncatedTail: number;
  /** Planted human prompts in well-formed records of this file (null = not asserted). */
  humanPrompts: number | null;
  note: string;
}
export interface HostileManifest {
  formatVersion: 1;
  tier: HostileTier;
  roots: { claudeConfigDir: "claude"; codexHome: "codex" };
  canaries: CanaryInfo[];
  poison: PoisonInfo[];
  /** Generic shapes any output must not contain (in addition to the exact canaries). */
  patterns: string[];
  files: FileExpect[];
  notes: string[];
}

export interface Hostile {
  files: OutFile[];
  links: OutLink[];
  canaries: CanaryInfo[];
  manifest: HostileManifest;
}

const BASE = Date.UTC(2026, 5, 1, 10, 0, 0);
const CWD = "/Users/syn-user/code";

/** JSON.stringify with bidi / zero-width marks as \u escapes (control chars are already escaped). */
function J(o: unknown): string {
  return JSON.stringify(o).replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const FILL = "Zx9QkLm3Rt7VbN2cWd5YhJ8sPa4GfXe1UoIi6TyHnBvCr0AqSw";

class Canaries {
  readonly items: CanaryInfo[] = [];
  private n = 0;
  /** Register a sentinel built around a fresh id and return its value. */
  plant(kind: string, make: (id: string) => string): string {
    const id = `SYNTHCANARY${String(++this.n).padStart(5, "0")}`;
    const value = make(id);
    this.items.push({ id, kind, value, where: [] });
    return value;
  }
  anthropic(): string { return this.plant("anthropic-key", (id) => `sk-ant-api03-${id}-${FILL}${FILL.slice(0, 14)}`); }
  openai(): string { return this.plant("openai-key", (id) => `sk-proj-${id}${FILL.slice(0, 40)}`); }
  github(): string { return this.plant("github-token", (id) => `ghp_${id}${FILL.slice(0, 20)}`); }
  aws(): string { return this.plant("aws-access-key-id", (id) => `AKIA${id}`); }
  email(): string { return this.plant("email", (id) => `canary.${id.toLowerCase()}@example.invalid`); }
  text(kind = "sentinel"): string { return this.plant(kind, (id) => `the launch codename is ${id}`); }
  pem(): { header: string; body: string; footer: string } {
    const body = this.plant("private-key-body", (id) => `MIIEvQIBADANBgkqhkiG9w0BAQEFAASC${id}${FILL}`);
    return { header: "-----BEGIN RSA PRIVATE KEY-----", body, footer: "-----END RSA PRIVATE KEY-----" };
  }
}

class Poison {
  readonly items: PoisonInfo[] = [];
  private n = 0;
  add(kind: string, value: string): string {
    const escaped = J(value).slice(1, -1);
    this.items.push({ id: `POISON${String(++this.n).padStart(3, "0")}`, kind, escaped });
    return value;
  }
}

/** Accumulates a file as raw chunks so lines can be arbitrary bytes. */
class Chunks {
  private parts: Buffer[] = [];
  lines = 0;
  line(s: string, eol = "\n"): this { this.parts.push(Buffer.from(s + eol, "utf8")); this.lines++; return this; }
  bytes(b: Buffer): this { this.parts.push(b); return this; }
  data(): Buffer { return Buffer.concat(this.parts); }
}

interface ClaudeOpts {
  sessionId: string; cwd: string; branch: string; version: string; entrypoint: string; slug: string; model: string; effort: string; mode: string;
}

class ClaudeFile {
  readonly out = new Chunks();
  private parent: string | null = null;
  private t = BASE;
  constructor(private rng: Rng, readonly o: ClaudeOpts) {}

  private tail(): Record<string, unknown> {
    const o = this.o;
    return { userType: "external", entrypoint: o.entrypoint, cwd: o.cwd, sessionId: o.sessionId, version: o.version, gitBranch: o.branch, slug: o.slug };
  }
  tick(ms = 1000): number { this.t += ms; return this.t; }
  rec(type: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}, ts = this.tick()): string {
    const uuid = this.rng.uuid();
    this.out.line(J({ parentUuid: this.parent, isSidechain: false, type, ...body, uuid, timestamp: iso(ts), ...extra, ...this.tail() }));
    this.parent = uuid;
    return uuid;
  }
  user(content: unknown, extra: Record<string, unknown> = {}): string {
    return this.rec("user", { message: { role: "user", content } }, { permissionMode: this.o.mode, promptSource: "typed", origin: { kind: "human" }, ...extra });
  }
  assistant(blocks: unknown[], usage: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
    const out = Number(usage.output_tokens ?? 20);
    return this.rec("assistant", {
      message: {
        model: this.o.model, id: `msg_01${this.rng.base62(22)}`, type: "message", role: "assistant", content: blocks, stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: out, service_tier: "standard", ...usage },
      },
      requestId: `req_011C${this.rng.base62(20)}`,
    }, { effort: this.o.effort, ...extra });
  }
  toolUse(name: string, input: unknown): { id: string; uuid: string } {
    const id = `toolu_01${this.rng.base62(22)}`;
    const uuid = this.assistant([{ type: "tool_use", id, name, input }], { stop_reason: "tool_use" });
    return { id, uuid };
  }
  toolResult(id: string, sourceUuid: string, content: unknown, toolUseResult: unknown, isError = false): void {
    this.rec("user", { message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content, ...(isError ? { is_error: true } : {}) }] } }, { toolUseResult, sourceToolAssistantUUID: sourceUuid });
  }
  attachment(a: Record<string, unknown>): void { this.rec("attachment", { attachment: a }); }
  system(subtype: string, fields: Record<string, unknown> = {}): void { this.rec("system", { subtype, ...fields }, { isMeta: false }); }
  turnEnd(): void { this.system("turn_duration", { durationMs: 1000, messageCount: 2 }); }
  meta(rec: Record<string, unknown>): void { this.out.line(J(rec)); }
}

function claudeBase(rng: Rng, project: string, over: Partial<ClaudeOpts> = {}): ClaudeOpts {
  return {
    sessionId: rng.uuid(), cwd: `${CWD}/${project}`, branch: "main", version: "2.1.260", entrypoint: "cli", slug: "quiet-parser-billing",
    model: "claude-opus-5-5", effort: "high", mode: "default", ...over,
  };
}

const encode = (cwd: string): string => cwd.replace(/[/.]/g, "-");

function nested(depth: number, leaf: unknown): string {
  return `{"a":`.repeat(depth) + J(leaf) + "}".repeat(depth);
}

export function generateHostile(tier: HostileTier, seed = 7): Hostile {
  const rng = new Rng(seed, "hostile");
  const C = new Canaries();
  const P = new Poison();
  const files: OutFile[] = [];
  const links: OutLink[] = [];
  const expects: FileExpect[] = [];
  const add = (path: string, data: string | Buffer, e: Omit<FileExpect, "path">): void => {
    files.push({ path, data, mtimeMs: BASE + 3_600_000 });
    expects.push({ path, ...e });
  };

  claudeSecrets(rng, C, add);
  claudeLabels(rng, P, add);
  claudeMalformed(rng, add);
  claudeBom(rng, add);
  claudeDeep(rng, add, 3000);
  claudeLineSeps(rng, C, add);
  claudeJunk(rng, C, add);
  codexAll(rng, C, P, add, 3000);

  const notes = [
    "Canaries (CANARIES.txt) must never appear in any output of the engine. Poison strings (poison[].escaped, JSON-escaped here) must never appear raw.",
    "badLines / truncatedTail are what readJsonl reports for the file; null means the count depends on reader policy (BOM handling).",
    "The file whose note says 'ambiguous' holds records whose classification is a policy choice (e.g. an API 'Request was aborted' error); no count is asserted.",
    "A symlink loop / outside-tree link exists only in the full tier. Version 9.9.9 marks records that live outside the scanned tree: seeing it in output means a symlink was followed.",
  ];

  if (tier === "full") fullTier(rng, C, files, links, expects);

  // Where each canary landed (only small files are scanned; the 25 MB fixtures carry canaries by construction).
  for (const f of files) {
    if (f.data.length > 2_000_000) continue;
    const text = typeof f.data === "string" ? f.data : f.data.toString("utf8");
    for (const c of C.items) if (text.includes(c.value)) c.where.push(f.path);
  }
  if (tier === "full") for (const c of C.items) if (!c.where.length) c.where.push("(large fixture)");

  const manifest: HostileManifest = {
    formatVersion: 1, tier, roots: { claudeConfigDir: "claude", codexHome: "codex" }, canaries: C.items, poison: P.items,
    patterns: [
      "sk-ant-[A-Za-z0-9_-]{20,}", "sk-proj-[A-Za-z0-9_-]{20,}", "ghp_[A-Za-z0-9]{36}", "AKIA[0-9A-Z]{16}",
      "-----BEGIN [A-Z ]*PRIVATE KEY-----", "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[a-z]{2,}", "SYNTHCANARY[0-9]{5}",
    ],
    files: expects, notes,
  };
  const canaryText = [
    "# wasitme hostile-corpus canaries (all synthetic).",
    "# One literal string per line; lines starting with '# ' are comments. Multi-line values (private key blocks) are listed by their unique body line.",
    "# NO output of the engine (reports, JSON, snapshots, logs, errors, caches) may contain any of these strings.",
    "# Also scan for the generic shapes in HOSTILE-MANIFEST.json (patterns) and for the raw poison strings (poison[]).",
    ...C.items.map((c) => c.value),
  ].join("\n") + "\n";
  files.push({ path: "CANARIES.txt", data: canaryText, mtimeMs: BASE + 3_600_000 });
  files.push({ path: "HOSTILE-MANIFEST.json", data: JSON.stringify(manifest, null, 2) + "\n", mtimeMs: BASE + 3_600_000 });
  return { files, links, canaries: C.items, manifest };
}

type Add = (path: string, data: string | Buffer, e: Omit<FileExpect, "path">) => void;

// ---------------------------------------------------------------------------------- Claude

function claudeSecrets(rng: Rng, C: Canaries, add: Add): void {
  const cwdName = C.plant("path", (id) => `hostile-${id}`);
  const o = claudeBase(rng, cwdName, { branch: C.plant("branch", (id) => `feature/${id}-branch`), slug: C.plant("slug", (id) => `${id.toLowerCase()}-quiet-parser`) });
  const f = new ClaudeFile(rng, o);
  const pem = C.pem();
  const key1 = C.anthropic();
  f.meta({ type: "permission-mode", permissionMode: "default", sessionId: o.sessionId });
  f.user(`Please deploy with ${key1} and ${C.openai()}, token ${C.github()}, aws ${C.aws()}; contact ${C.email()}.\n${pem.header}\n${pem.body}\n${pem.footer}`);
  f.attachment({ type: "environment", platform: "darwin", shell: "zsh", model: o.model, env: { ANTHROPIC_API_KEY: C.anthropic(), HOME: C.plant("path", (id) => `/Users/syn-user/${id}`) } });
  f.attachment({ type: "skill_listing", skillCount: 1, skills: [C.plant("path", (id) => `/Users/syn-user/.claude/skills/${id}/SKILL.md`)] });
  f.attachment({ type: "instructions", path: `${o.cwd}/CLAUDE.md`, content: `${C.text("instructions-sentinel")} and ${C.openai()}` });
  f.attachment({ type: "system_prompt", systemPrompt: `${C.text("system-prompt-sentinel")} ${C.github()}` });
  f.assistant([
    { type: "thinking", thinking: C.text("thinking-sentinel"), signature: rng.base64(120) },
    { type: "text", text: `I will use ${C.anthropic()} to deploy; notify ${C.email()}.` },
  ]);
  const bash = f.toolUse("Bash", { command: `export ANTHROPIC_API_KEY=${C.anthropic()} && ./deploy.sh`, description: C.text("tool-input-sentinel") });
  f.toolResult(bash.id, bash.uuid, `.env\nOPENAI_API_KEY=${C.openai()}\nAWS_ACCESS_KEY_ID=${C.aws()}\n${C.text("tool-output-sentinel")}`, { stdout: `token ${C.github()}`, stderr: "", interrupted: false });
  const read = f.toolUse("Read", { file_path: C.plant("path", (id) => `${o.cwd}/${id}-private-notes.md`) });
  f.toolResult(read.id, read.uuid, `${pem.header}\n${pem.body}\n${pem.footer}`, { type: "text", file: { filePath: `${o.cwd}/.env`, content: C.anthropic() } });
  f.meta({ type: "queue-operation", operation: "enqueue", timestamp: iso(f.tick(10)), sessionId: o.sessionId, content: `queued with ${C.github()}` });
  f.attachment({ type: "queued_command", prompt: `also remember ${C.text("queued-sentinel")} and ${C.aws()}`, commandMode: "prompt", origin: { kind: "human" } });
  f.user([{ type: "text", text: "[Request interrupted by user]" }]);
  f.turnEnd();
  f.user(`Mail the report to ${C.email()} and ignore ${C.text("prompt-sentinel")}.`);
  f.assistant([{ type: "text", text: `Done. ${C.text("response-sentinel")}` }]);
  f.turnEnd();
  f.meta({ type: "ai-title", aiTitle: `Fix for ${C.email()}`, sessionId: o.sessionId });
  f.meta({ type: "last-prompt", lastPrompt: `Mail the report to ${C.email()}`, sessionId: o.sessionId });
  add(`claude/projects/${encode(o.cwd)}/${o.sessionId}.jsonl`, f.out.data(), {
    kind: "secrets", badLines: 0, truncatedTail: 0, humanPrompts: 2, note: "valid session; secrets in prompts, tool inputs/outputs, cwd, branch, slug, attachments, queue, title",
  });
}

function claudeLabels(rng: Rng, P: Poison, add: Add): void {
  const poison = claudeBase(rng, "hostile-labels", {
    version: P.add("ansi-version", "\u001b[31m2.1.289\u001b[0m"),
    model: P.add("bidi-model", "claude-opus-5-5\u202e"),
    effort: P.add("html-effort", "<script>alert(1)</script>"),
    entrypoint: P.add("html-entrypoint", 'cli"><img src=x onerror=alert(1)>'),
    mode: P.add("bidi-mode", "default\u2066"),
    branch: P.add("script-branch", "</script><script>alert(2)</script>"),
    slug: P.add("ansi-slug", "\u001b[1mbold\u001b[0m-slug"),
  });
  const f = new ClaudeFile(rng, poison);
  f.user(P.add("ansi-prompt", "\u001b]0;pwned\u0007 run \u001b[2Jthis <a href=\"javascript:alert(1)\">link</a> \u202eexe.txt"));
  f.assistant([{ type: "text", text: P.add("html-assistant", "<script>alert(document.cookie)</script><svg onload=alert(1)>") }]);
  const t = f.toolUse("Bash", { command: P.add("bidi-command", "echo \u202ehello\u202c") });
  f.toolResult(t.id, t.uuid, P.add("ansi-output", "\u001b[31mred\u001b[0m \u001b[?1049h"), "x");
  f.turnEnd();
  // The same session continues with clean labels, so only the poisoned exchange is affected.
  const clean = new ClaudeFile(rng, { ...poison, version: "2.1.261", model: "claude-opus-5-5", effort: "high", entrypoint: "cli", mode: "default", branch: "main", slug: "quiet-parser-billing", sessionId: poison.sessionId });
  clean.user("Plain follow-up prompt after the poisoned exchange.");
  clean.assistant([{ type: "text", text: "Plain answer." }]);
  clean.turnEnd();
  add(`claude/projects/-Users-syn-user-code-hostile-labels/${poison.sessionId}.jsonl`, Buffer.concat([f.out.data(), clean.out.data()]), {
    kind: "poison-labels", badLines: 0, truncatedTail: 0, humanPrompts: 2, note: "ANSI / bidi / HTML in version, model, effort, entrypoint, permissionMode, gitBranch, slug and text; second exchange is clean",
  });
}

function claudeMalformed(rng: Rng, add: Add): void {
  const o = claudeBase(rng, "hostile-malformed");
  const f = new ClaudeFile(rng, o);
  const raw = f.out;
  let bad = 0;
  const rawBad = (s: string): void => { raw.line(s); bad++; };

  f.user("A well-formed prompt before the damage.");
  f.assistant([{ type: "text", text: "A well-formed answer." }]);
  rawBad('{"type":"user","message":{"role":"user","content":"unterminated string');
  rawBad("null");
  rawBad("[1,2,3]");
  rawBad("42");
  rawBad('"just a string"');
  rawBad("undefined");
  rawBad("}");
  rawBad('{"type":"user",');
  rawBad('{"type":"user","message":{"role":"user","content":"nul\u0000inside"}}'); // raw NUL in a JSON string is invalid
  raw.line("");
  raw.line("   \t  ");
  // Invalid UTF-8 inside an otherwise valid record: decodes with U+FFFD and is still a human prompt.
  raw.bytes(Buffer.concat([
    Buffer.from('{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"bad bytes: ', "utf8"),
    Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from(' end"},"uuid":"' + rng.uuid() + '","timestamp":"' + iso(f.tick()) + '","origin":{"kind":"human"},"sessionId":"' + o.sessionId + '","version":"2.1.260"}\n', "utf8"),
  ]));
  f.assistant([{ type: "holo_block", payload: { deep: [1, 2, 3] } }, { type: "text", text: "after an unknown content block type" }]);
  f.rec("synthetic-future-record", { payload: { a: 1 } });
  f.rec("synthetic-future-record", { payload: { b: 2 } });
  f.rec("artifact-new-thing", { payload: { c: 3 } });
  // Timestamps out of range or unparseable.
  raw.line(J({ type: "user", message: { role: "user", content: "prompt dated before 2020" }, uuid: rng.uuid(), timestamp: "2019-12-31T23:59:59.000Z", origin: { kind: "human" }, sessionId: o.sessionId, version: "2.1.260" }));
  raw.line(J({ type: "user", message: { role: "user", content: "prompt dated in 2099" }, uuid: rng.uuid(), timestamp: "2099-01-01T00:00:00.000Z", origin: { kind: "human" }, sessionId: o.sessionId, version: "2.1.260" }));
  raw.line(J({ type: "user", message: { role: "user", content: "prompt with no timestamp" }, uuid: rng.uuid(), origin: { kind: "human" }, sessionId: o.sessionId, version: "2.1.260" }));
  raw.line(J({ type: "user", message: { role: "user", content: "prompt with a junk timestamp" }, uuid: rng.uuid(), timestamp: "not-a-date", origin: { kind: "human" }, sessionId: o.sessionId, version: "2.1.260" }));
  raw.line(J({ type: "user", message: { role: "user", content: "prompt with epoch-seconds timestamp" }, uuid: rng.uuid(), timestamp: 1_780_000_000, origin: { kind: "human" }, sessionId: o.sessionId, version: "2.1.260" }));
  // Odd shapes that are still JSON objects.
  raw.line(J({ type: "assistant", uuid: rng.uuid(), timestamp: iso(f.tick()), message: { role: "assistant", model: "claude-opus-5-5", content: 12345, usage: { input_tokens: "lots", output_tokens: -7, cache_read_input_tokens: null } }, requestId: "req_weird" }));
  raw.line(J({ type: "user", uuid: rng.uuid(), timestamp: iso(f.tick()), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_missing", content: "x", is_error: "true" }] } }));
  raw.line(J({ type: "user", uuid: rng.uuid(), timestamp: iso(f.tick()) }));
  raw.line(J({ type: "assistant", uuid: rng.uuid(), timestamp: iso(f.tick()), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_dup", name: "Read", input: { file_path: "/x" } }, { type: "tool_use", id: "toolu_dup", name: "Read", input: { file_path: "/x" } }], usage: { output_tokens: 9 } }, requestId: "req_dup" }));
  // Ambiguous: an API "Request was aborted" error (interrupt or API error is a reader policy choice).
  f.assistant([{ type: "text", text: "API Error: Request was aborted." }], {}, { isApiErrorMessage: true, error: "aborted" });
  // CRLF line endings on a valid record.
  raw.line(J({ type: "user", message: { role: "user", content: "a prompt on a CRLF line" }, uuid: rng.uuid(), timestamp: iso(f.tick()), origin: { kind: "human" }, sessionId: o.sessionId, version: "2.1.260" }), "\r\n");
  // A duplicated uuid within the file.
  const dupUuid = rng.uuid();
  for (let i = 0; i < 2; i++) raw.line(J({ type: "user", message: { role: "user", content: "same record written twice" }, uuid: dupUuid, timestamp: iso(f.tick()), origin: { kind: "human" }, sessionId: o.sessionId, version: "2.1.260" }));
  // Partial write: the last line is cut off with no newline.
  raw.line('{"type":"assistant","message":{"role":"assistant","content":[{"type":"te', "");
  add(`claude/projects/-Users-syn-user-code-hostile-malformed/${o.sessionId}.jsonl`, raw.data(), {
    kind: "malformed", badLines: bad, truncatedTail: 1, humanPrompts: null,
    note: "ambiguous: bad lines, NUL, invalid UTF-8, unknown record types (synthetic-future-record x2), out-of-range / missing / junk timestamps, odd shapes, duplicate uuid and tool ids, API 'Request was aborted' record, CRLF, truncated tail",
  });
}

function claudeBom(rng: Rng, add: Add): void {
  const o = claudeBase(rng, "hostile-bom");
  const f = new ClaudeFile(rng, o);
  f.user("A prompt in a file that starts with a byte-order mark and uses CRLF.");
  f.assistant([{ type: "text", text: "Answer." }]);
  f.turnEnd();
  const text = f.out.data().toString("utf8").replace(/\n/g, "\r\n");
  add(`claude/projects/-Users-syn-user-code-hostile-bom/${o.sessionId}.jsonl`, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]), {
    kind: "bom-crlf", badLines: null, truncatedTail: 0, humanPrompts: null, note: "UTF-8 BOM before the first record and CRLF everywhere: whether the first record survives is reader policy",
  });
}

function claudeDeep(rng: Rng, add: Add, depth: number): void {
  const o = claudeBase(rng, "hostile-deep");
  const f = new ClaudeFile(rng, o);
  f.user("A prompt followed by records with deeply nested payloads.");
  const body = f.out;
  const t = f.toolUse("Bash", { command: "ls" });
  body.line(`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"${t.id}","type":"tool_result","content":"ok"}]},"toolUseResult":${nested(depth, "leaf")},"sourceToolAssistantUUID":"${t.uuid}","uuid":"${rng.uuid()}","timestamp":"${iso(f.tick())}","sessionId":"${o.sessionId}","version":"${o.version}"}`);
  f.assistant([{ type: "text", text: "Done." }]);
  f.turnEnd();
  add(`claude/projects/-Users-syn-user-code-hostile-deep/${o.sessionId}.jsonl`, body.data(), {
    kind: "deep-nesting", badLines: 0, truncatedTail: 0, humanPrompts: 1, note: `a tool result whose toolUseResult is an object nested ${depth} deep: parses fine, breaks recursive walkers`,
  });
}

function claudeLineSeps(rng: Rng, C: Canaries, add: Add): void {
  const o = claudeBase(rng, "hostile-lineseps");
  const f = new ClaudeFile(rng, o);
  const inner = J({ type: "user", message: { role: "user", content: "smuggled record" }, uuid: rng.uuid(), timestamp: iso(BASE), origin: { kind: "human" }, sessionId: o.sessionId });
  f.user(`first half\u2028${inner}`);
  f.assistant([{ type: "text", text: `separators: \u2028 line sep \u2029 paragraph sep \u0085 next line \u000b vt \u000c ff ${C.text("lineseps-sentinel")}` }]);
  f.turnEnd();
  f.user("second prompt with a raw U+2029\u2029inside");
  f.assistant([{ type: "text", text: "Answer." }]);
  f.turnEnd();
  add(`claude/projects/-Users-syn-user-code-hostile-lineseps/${o.sessionId}.jsonl`, f.out.data(), {
    kind: "line-separators", badLines: 0, truncatedTail: 0, humanPrompts: 2,
    note: "raw U+2028/U+2029 inside strings (JSON.stringify does not escape them): readline-style splitting corrupts these records; a smuggled record text must not become a prompt",
  });
}

function claudeJunk(rng: Rng, C: Canaries, add: Add): void {
  const dir = "claude/projects/-Users-syn-user-code-hostile-junk";
  add(`${dir}/garbage.jsonl`, rng.bytes(4096), { kind: "binary-garbage", badLines: null, truncatedTail: 0, humanPrompts: 0, note: "4 KB of random bytes" });
  add(`${dir}/empty.jsonl`, "", { kind: "zero-byte", badLines: 0, truncatedTail: 0, humanPrompts: 0, note: "zero-byte session file" });
  add(`${dir}/newlines.jsonl`, "\n\n\n\n", { kind: "blank-only", badLines: 0, truncatedTail: 0, humanPrompts: 0, note: "only newlines" });
  add(`${dir}/notes.txt`, `${C.text("notes-sentinel")}\n`, { kind: "non-jsonl", badLines: 0, truncatedTail: 0, humanPrompts: 0, note: "not a session file" });
  // A directory that merely has a .jsonl name; the session inside carries version 9.9.8 so traversal would show.
  const inner = new ClaudeFile(rng, claudeBase(rng, "hostile-junk", { version: "9.9.8" }));
  inner.user("A prompt inside a directory named like a session file.");
  inner.assistant([{ type: "text", text: "Answer." }]);
  add(`${dir}/fake-session.jsonl/inner.jsonl`, inner.out.data(), { kind: "dir-named-jsonl", badLines: 0, truncatedTail: 0, humanPrompts: 1, note: "directory named *.jsonl: not a session file; its content must not be read (version 9.9.8)" });
  // An orphan subagent file with no main session file next to it.
  const orphanSession = rng.uuid();
  const sub = new ClaudeFile(rng, claudeBase(rng, "hostile-junk", { sessionId: orphanSession }));
  sub.user("orphan subagent prompt");
  sub.assistant([{ type: "text", text: "orphan result" }]);
  add(`${dir}/${orphanSession}/subagents/agent-${rng.hex(17)}.jsonl`, sub.out.data().toString("utf8").replace(/"isSidechain":false/g, '"isSidechain":true'), { kind: "orphan-subagent", badLines: 0, truncatedTail: 0, humanPrompts: 0, note: "subagent file whose main session file does not exist" });
}

// ---------------------------------------------------------------------------------- Codex

class CodexFile {
  readonly out = new Chunks();
  private ord = 0;
  private t = BASE;
  constructor(private rng: Rng, readonly id: string, readonly legacy = false) {}
  tick(ms = 500): number { this.t += ms; return this.t; }
  rec(type: string, payload: unknown, ts = this.tick()): void {
    this.out.line(J(this.legacy ? { timestamp: iso(ts), type, payload } : { timestamp: iso(ts), ordinal: this.ord++, type, payload }));
  }
  meta(over: Record<string, unknown> = {}): void {
    this.rec("session_meta", { session_id: this.id, timestamp: iso(this.t), cwd: `${CWD}/hostile-codex`, originator: "codex-tui", cli_version: "0.150.0", source: "cli", model_provider: "openai", git: { commit_hash: this.rng.hex(40), branch: "main" }, base_instructions: { text: "synthetic base instructions" }, ...over });
  }
  turn(over: { context?: Record<string, unknown>; prompt?: string } = {}): string {
    const turn = this.rng.uuid();
    this.rec("event_msg", { type: "task_started", turn_id: turn, model_context_window: 258400 });
    this.rec("turn_context", { turn_id: turn, cwd: `${CWD}/hostile-codex`, approval_policy: "on-request", model: "gpt-6-luna", effort: "medium", summary: "auto", ...over.context });
    if (over.prompt !== undefined) {
      this.rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: over.prompt }] });
      this.rec("event_msg", { type: "item_completed", turn_id: turn, item: { type: "UserMessage", id: `item_${this.rng.hex(24)}`, content: [{ type: "text", text: over.prompt, text_elements: [] }] } });
    }
    return turn;
  }
  usage(turn: string, out = 40): void {
    const u = { input_tokens: 3000, cached_input_tokens: 2800, cache_write_input_tokens: 0, output_tokens: out, reasoning_output_tokens: 5, total_tokens: 3000 + out };
    this.rec("token_usage_record", { response_id: `resp_${this.rng.hex(20)}`, turn_id: turn, usage: u, turn_token_usage: u });
  }
  complete(turn: string, last: string | null = null): void {
    this.rec("event_msg", { type: "task_complete", turn_id: turn, last_agent_message: last, duration_ms: 1000, time_to_first_token_ms: 100, error: null });
  }
}

function rolloutPath(dir: string, ts: number, id: string): string {
  return `${dir}/rollout-${iso(ts).slice(0, 19).replace(/:/g, "-")}-${id}.jsonl`;
}
const SESS = "codex/sessions/2026/06/01";

function codexAll(rng: Rng, C: Canaries, P: Poison, add: Add, depth: number): void {
  // ---- secrets everywhere a rollout can carry text
  {
    const id = rng.uuid();
    const f = new CodexFile(rng, id);
    const cwd = C.plant("path", (x) => `${CWD}/hostile-${x}`);
    const pem = C.pem();
    f.meta({
      cwd, git: { commit_hash: rng.hex(40), branch: C.plant("branch", (x) => `feature/${x}-branch`) },
      base_instructions: { text: `${C.text("system-prompt-sentinel")} ${C.anthropic()}` },
      dynamic_tools: [{ name: C.plant("tool-name", (x) => `mcp__${x.toLowerCase()}__search`), description: "synthetic" }],
    });
    const turn = f.turn({ context: { cwd }, prompt: `Deploy with ${C.openai()} and ${C.github()}; mail ${C.email()}.\n${pem.header}\n${pem.body}\n${pem.footer}` });
    f.rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\n${C.text("agents-sentinel")} ${C.aws()}\n</INSTRUCTIONS>` }] });
    f.rec("response_item", { type: "reasoning", summary: [{ type: "summary_text", text: C.text("reasoning-sentinel") }], content: null, encrypted_content: rng.base64(80) });
    const cmd = `export OPENAI_API_KEY=${C.openai()} && ./deploy.sh`;
    f.rec("response_item", { type: "function_call", name: "shell", arguments: J({ command: ["bash", "-lc", cmd], workdir: cwd }), call_id: "call_secret_1" });
    f.rec("response_item", { type: "function_call_output", call_id: "call_secret_1", output: `Exit code: 0\nWall time: 0.1 seconds\nOutput:\n${C.anthropic()}\n${C.text("tool-output-sentinel")}` });
    f.rec("event_msg", { type: "item_completed", turn_id: turn, item: { type: "CommandExecution", id: "item_s1", call_id: "call_secret_1", command: cmd, cwd, parsed_cmd: [{ type: "unknown", cmd }], status: "completed", exit_code: 0, aggregated_output: `${C.github()}`, duration: { secs: 0, nanos: 1 } } });
    f.rec("event_msg", { type: "item_completed", turn_id: turn, item: { type: "FileChange", id: "item_s2", call_id: "call_secret_2", changes: [{ path: `${cwd}/${C.plant("path", (x) => `${x}-notes.md`)}`, kind: { type: "update" }, diff: `+${C.anthropic()}` }], status: "completed" } });
    f.rec("event_msg", { type: "item_completed", turn_id: turn, item: { type: "McpToolCall", id: "item_s3", server: "synth", tool: "search", status: "completed", arguments: { q: C.email() }, result: { content: [{ type: "text", text: C.openai() }] } } });
    f.usage(turn);
    f.complete(turn, `Finished. ${C.text("response-sentinel")} ${C.email()}`);
    add(rolloutPath(SESS, BASE, id), f.out.data(), { kind: "secrets", badLines: 0, truncatedTail: 0, humanPrompts: 1, note: "secrets in prompt, injected AGENTS.md, base_instructions, cwd, branch, tool names, call args/outputs, item fields, final message" });
  }
  // ---- poisoned labels
  {
    const id = rng.uuid();
    const f = new CodexFile(rng, id);
    f.meta({
      cli_version: P.add("ansi-codex-version", "\u001b[31m0.160.0\u001b[0m"), source: P.add("html-codex-source", "<b>cli</b>"),
      originator: P.add("bidi-codex-originator", "codex-tui\u202e"), model_provider: P.add("script-provider", "openai</script>"),
    });
    const turn = f.turn({
      context: { model: P.add("bidi-codex-model", "gpt-6-luna\u2067"), effort: P.add("ansi-codex-effort", "\u001b[1mhigh"), approval_policy: P.add("html-codex-approval", "never<img src=x>") },
      prompt: P.add("ansi-codex-prompt", "\u001b[31mred prompt\u001b[0m <script>1</script> \u202eevil"),
    });
    f.usage(turn);
    f.complete(turn);
    add(rolloutPath(SESS, BASE + 60_000, id), f.out.data(), { kind: "poison-labels", badLines: 0, truncatedTail: 0, humanPrompts: 1, note: "ANSI / bidi / HTML in cli_version, source, originator, provider, model, effort, approval_policy, prompt" });
  }
  // ---- malformed
  {
    const id = rng.uuid();
    const f = new CodexFile(rng, id);
    const out = f.out;
    let bad = 0;
    f.meta();
    const turn = f.turn({ prompt: "A well-formed Codex prompt." });
    out.line("{not json"); bad++;
    out.line("null"); bad++;
    out.line("[1,2]"); bad++;
    f.rec("future_envelope", { type: "whatever", n: 1 });
    f.rec("future_envelope", { type: "whatever", n: 2 });
    out.line(J({ timestamp: iso(f.tick()), ordinal: 99, type: "event_msg", payload: "a string payload" }));
    out.line(J({ timestamp: iso(f.tick()), ordinal: 98, type: "event_msg", payload: null }));
    out.line(J({ timestamp: iso(f.tick()), ordinal: 97, payload: { type: "task_started" } }));
    f.rec("event_msg", { type: "task_started" }); // no turn_id
    f.rec("token_usage_record", { response_id: "resp_neg", turn_id: turn, usage: { input_tokens: -5, cached_input_tokens: 9_000_000_000, output_tokens: "many", reasoning_output_tokens: null } });
    f.rec("token_usage_record", { turn_id: turn, usage: { input_tokens: 10, output_tokens: 5 } }); // no response_id
    f.rec("event_msg", { type: "turn_aborted", turn_id: turn, reason: "some-new-reason", duration_ms: -5 });
    f.rec("event_msg", { type: "item_completed", turn_id: turn, item: { type: "BrandNewItemKind", id: "x" } });
    f.rec("event_msg", { type: "item_completed", turn_id: turn, item: "not an object" });
    out.line(J({ timestamp: "2019-01-01T00:00:00Z", ordinal: 5, type: "event_msg", payload: { type: "task_complete", turn_id: turn } }));
    out.line('{"timestamp":"' + iso(f.tick()) + '","type":"event_msg","payload":{"type":"task_comp', "");
    add(rolloutPath(SESS, BASE + 120_000, id), out.data(), { kind: "malformed", badLines: bad, truncatedTail: 1, humanPrompts: null, note: "ambiguous: bad lines, unknown envelope types (future_envelope x2), odd payload shapes, missing ids, impossible numbers, stale timestamp, truncated tail" });
  }
  // ---- zero-byte, garbage, archived duplicate, archived orphan
  add(rolloutPath(SESS, BASE + 180_000, rng.uuid()), "", { kind: "zero-byte", badLines: 0, truncatedTail: 0, humanPrompts: 0, note: "zero-byte rollout" });
  add(rolloutPath(SESS, BASE + 240_000, rng.uuid()), rng.bytes(2048), { kind: "binary-garbage", badLines: null, truncatedTail: 0, humanPrompts: 0, note: "2 KB of random bytes named like a rollout" });
  {
    const id = rng.uuid();
    const f = new CodexFile(rng, id);
    f.meta();
    const turn = f.turn({ prompt: "A prompt in a rollout that also sits in archived_sessions." });
    f.usage(turn);
    f.complete(turn);
    const data = f.out.data();
    const live = rolloutPath(SESS, BASE + 300_000, id);
    add(live, data, { kind: "archived-duplicate", badLines: 0, truncatedTail: 0, humanPrompts: 1, note: "byte-identical copy also under archived_sessions (dedupe by basename)" });
    add(`codex/archived_sessions/${live.split("/").pop()}`, data, { kind: "archived-duplicate-copy", badLines: 0, truncatedTail: 0, humanPrompts: 0, note: "the archived copy: must not count twice" });
  }
  // ---- an old-format (legacy) rollout: `id` not `session_id`, no ordinal, no item_completed
  {
    const id = rng.uuid();
    const f = new CodexFile(rng, id, true);
    f.meta({ session_id: undefined, id, cli_version: "0.141.0", base_instructions: undefined, instructions: "synthetic legacy instructions" });
    const turn = f.turn({ prompt: undefined });
    f.rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "A prompt in a legacy-format rollout." }] });
    f.rec("event_msg", { type: "user_message", message: "A prompt in a legacy-format rollout.", kind: "plain" });
    f.rec("response_item", { type: "function_call", name: "shell", arguments: J({ command: ["bash", "-lc", "cat src/a.ts"] }), call_id: "call_legacy" });
    f.rec("response_item", { type: "function_call_output", call_id: "call_legacy", output: "Exit code: 2\nWall time: 0.1 seconds\nOutput:\nnope" });
    f.rec("event_msg", { type: "exec_command_end", call_id: "call_legacy", turn_id: turn, command: ["bash", "-lc", "cat src/a.ts"], parsed_cmd: [{ type: "read", cmd: "cat src/a.ts", name: "a.ts", path: "src/a.ts" }], exit_code: 2, aggregated_output: "nope" });
    f.usage(turn);
    f.complete(turn);
    add(rolloutPath(SESS, BASE + 330_000, id), f.out.data(), { kind: "legacy-format", badLines: 0, truncatedTail: 0, humanPrompts: 1, note: "legacy rollout: id instead of session_id, no ordinal, no item_completed, tool events as exec_command_end" });
  }
  // ---- deep nesting, line separators, forks of nothing
  {
    const id = rng.uuid();
    const f = new CodexFile(rng, id);
    f.meta();
    const turn = f.turn({ prompt: "A prompt followed by a deeply nested payload." });
    f.out.line(`{"timestamp":"${iso(f.tick())}","ordinal":50,"type":"response_item","payload":{"type":"function_call_output","call_id":"call_deep","output":"ok","extra":${nested(depth, "leaf")}}}`);
    f.usage(turn);
    f.complete(turn);
    add(rolloutPath(SESS, BASE + 360_000, id), f.out.data(), { kind: "deep-nesting", badLines: 0, truncatedTail: 0, humanPrompts: 1, note: `a payload nested ${depth} deep` });
  }
  {
    const id = rng.uuid();
    const f = new CodexFile(rng, id);
    f.meta();
    const turn = f.turn({ prompt: `Codex prompt with raw separators \u2028 and \u2029 inside ${C.text("lineseps-sentinel")}` });
    f.usage(turn);
    f.complete(turn);
    add(rolloutPath(SESS, BASE + 420_000, id), f.out.data(), { kind: "line-separators", badLines: 0, truncatedTail: 0, humanPrompts: 1, note: "raw U+2028/U+2029 inside a prompt" });
  }
  {
    const id = rng.uuid();
    const f = new CodexFile(rng, id);
    f.meta({ forked_from_id: rng.uuid() });
    const turn = f.turn({ prompt: "A fork whose parent rollout does not exist." });
    f.usage(turn);
    f.complete(turn);
    add(rolloutPath(SESS, BASE + 480_000, id), f.out.data(), { kind: "fork-of-nothing", badLines: 0, truncatedTail: 0, humanPrompts: 1, note: "forked_from_id points at a missing parent: its own turns still count" });
  }
}

// ---------------------------------------------------------------------------------- full tier

function fullTier(rng: Rng, C: Canaries, files: OutFile[], links: OutLink[], expects: FileExpect[]): void {
  const reg = (path: string, data: string | Buffer, e: Omit<FileExpect, "path">): void => {
    files.push({ path, data, mtimeMs: BASE + 7_200_000 });
    expects.push({ path, ...e });
  };
  const canary = C.plant("big-line-sentinel", (id) => `the launch codename is ${id}`);
  const tailCanary = C.plant("big-line-sentinel", (id) => `the launch codename is ${id}`);
  const o = claudeBase(rng, "hostile-big");
  const mk = (content: string): string => `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${content}"},"uuid":"${rng.uuid()}","timestamp":"${iso(BASE)}","origin":{"kind":"human"},"sessionId":"${o.sessionId}","version":"${o.version}"}`;
  const huge = canary + "A".repeat(25 * 1024 * 1024) + tailCanary;
  const f = new ClaudeFile(rng, o);
  f.user("A normal prompt before the 25 MB line.");
  f.out.line(mk(huge));
  f.user("A normal prompt after the 25 MB line: reading must resume here.");
  f.assistant([{ type: "text", text: "Answer." }]);
  reg(`claude/projects/-Users-syn-user-code-hostile-big/${o.sessionId}.jsonl`, f.out.data(), {
    kind: "huge-line", badLines: 1, truncatedTail: 0, humanPrompts: 2, note: "a valid record whose text is 25 MB (canaries at both ends): over the reader's line cap it is skipped as one bad line and reading resumes after it",
  });

  const o2 = claudeBase(rng, "hostile-big");
  const g = new ClaudeFile(rng, o2);
  g.user("A normal prompt before the 1.2 MB line.");
  g.out.line(mk("B".repeat(1_200_000)));
  g.assistant([{ type: "text", text: "Answer." }]);
  reg(`claude/projects/-Users-syn-user-code-hostile-big/${o2.sessionId}.jsonl`, g.out.data(), {
    kind: "long-line", badLines: 0, truncatedTail: 0, humanPrompts: 2, note: "a valid 1.2 MB record (larger than a 1 MiB read chunk, under the line cap)",
  });

  const o3 = claudeBase(rng, "hostile-big");
  const d = new ClaudeFile(rng, o3);
  d.user("A prompt followed by a record nested 200,000 deep.");
  const t = d.toolUse("Bash", { command: "ls" });
  d.out.line(`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"${t.id}","type":"tool_result","content":"ok"}]},"toolUseResult":${nested(200_000, "leaf")},"uuid":"${rng.uuid()}","timestamp":"${iso(BASE + 5)}","sessionId":"${o3.sessionId}","version":"${o3.version}"}`);
  reg(`claude/projects/-Users-syn-user-code-hostile-big/${o3.sessionId}.jsonl`, d.out.data(), {
    kind: "deep-nesting-200k", badLines: 0, truncatedTail: 0, humanPrompts: 1, note: "a toolUseResult nested 200,000 deep: JSON.parse accepts it, hand-written recursive walkers (redaction, flattening) overflow the stack",
  });

  // Codex 25 MB line
  const cid = rng.uuid();
  const cf = new CodexFile(rng, cid);
  cf.meta();
  const turn = cf.turn({ prompt: "A normal Codex prompt before the 25 MB line." });
  cf.out.line(J({ timestamp: iso(cf.tick()), ordinal: 60, type: "response_item", payload: { type: "function_call_output", call_id: "call_big", output: canary + "C".repeat(25 * 1024 * 1024) } }));
  cf.usage(turn);
  cf.complete(turn);
  reg(rolloutPath(SESS, BASE + 540_000, cid), cf.out.data(), { kind: "huge-line", badLines: 1, truncatedTail: 0, humanPrompts: 1, note: "a 25 MB function_call_output line in a rollout" });

  // Symlinks. The outside directory lives next to the scanned roots (inside the output dir, outside claude/ and codex/).
  const out = claudeBase(rng, "hostile-outside", { version: "9.9.9" });
  const of = new ClaudeFile(rng, out);
  of.user(`An outside-the-tree session. ${C.text("outside-sentinel")}`);
  of.assistant([{ type: "text", text: "Answer." }]);
  reg(`outside/${out.sessionId}.jsonl`, of.out.data(), { kind: "outside-tree", badLines: 0, truncatedTail: 0, humanPrompts: 1, note: "lives outside the scanned tree (version 9.9.9); reachable only through a symlink" });
  const dir = "claude/projects/-Users-syn-user-code-hostile-links";
  links.push({ path: `${dir}/loop`, target: ".", type: "dir" });
  links.push({ path: `${dir}/a`, target: "b", type: "dir" });
  links.push({ path: `${dir}/b`, target: "a", type: "dir" });
  links.push({ path: `${dir}/outside-link`, target: "../../../outside", type: "dir" });
  const inside = claudeBase(rng, "hostile-links");
  const inf = new ClaudeFile(rng, inside);
  inf.user("A real session in a directory full of hostile symlinks.");
  inf.assistant([{ type: "text", text: "Answer." }]);
  reg(`${dir}/${inside.sessionId}.jsonl`, inf.out.data(), { kind: "symlink-neighbour", badLines: 0, truncatedTail: 0, humanPrompts: 1, note: "next to: loop -> . ; a -> b -> a ; outside-link -> ../../../outside (a directory outside the scanned tree)" });
}
