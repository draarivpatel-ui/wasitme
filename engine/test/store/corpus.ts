/**
 * A deterministic synthetic Claude Code corpus for end-to-end scan tests (scan → attribution → words → files).
 * Real-format JSONL written with the fixture SessionBuilder; numbers and opaque labels only.
 *
 * Every day has `sessionsPerDay` sessions in two projects (alternating, so the project mix never moves), each with
 * `exchanges` typed prompts on the CLI (interactive). One exchange = one prompt, one response with Read/Edit tool
 * calls, their results (some failed) and a closing response. Per exchange, before / after the onset:
 *   edits = 5: (5 − blind) read-then-edited files and `blind` files edited without a read;
 *   reads = 5 − blind (+1 spare read); failed results = `errors` (all on edit calls: the non-command construct).
 * A per-session wiggle (−1, +1, 0, 0) keeps cluster variance real. Optional changes at the onset day:
 *   switchModel: session 0 answers one exchange on the old model, then `/model` is typed (a command record) and the
 *                rest of the day and run uses the new model — a you·strong change (METHOD.md §9);
 *   bumpVersion: every session from the onset on runs the next CLI version (no command: agent·routine).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionBuilder, text, toolUseBlock, writeJsonl, type Rec } from "../fixtures/claude/builder.js";

export interface Rates { errors: number; blind: number }

export interface CorpusSpec {
  /** First day (UTC). */
  start: string;
  days: number;
  /** Day index (0-based) the change takes effect; undefined → no change. */
  onset?: number;
  before: Rates;
  after?: Rates;
  sessionsPerDay?: number;
  exchanges?: number;
  switchModel?: { from: string; to: string };
  bumpVersion?: { from: string; to: string };
  /** Model and version when nothing switches. */
  model?: string;
  version?: string;
}

export interface WrittenSession { id: string; project: string; cwd: string; start: string; day: string }

const WIGGLE = [-1, 1, 0, 0];
const PROJECTS = ["project-alpha", "project-beta"];

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function exchange(s: SessionBuilder, cwd: string, k: number, r: Rates, model: string): void {
  s.prompt(`synthetic request ${k}`, { promptSource: "typed" });
  const blocks: Rec[] = [];
  const ids: string[] = [];
  const edits = 5;
  const blind = Math.max(0, Math.min(edits, r.blind));
  const files = (i: number) => `${cwd}/src/file-${k}-${i}.ts`;
  for (let i = 0; i < edits - blind; i++) {
    const a = `${s.id}-r${k}-${i}`, b = `${s.id}-e${k}-${i}`;
    blocks.push(toolUseBlock(a, "Read", { file_path: files(i) }), toolUseBlock(b, "Edit", { file_path: files(i), old_string: "a", new_string: "b" }));
    ids.push(a, b);
  }
  const spare = `${s.id}-s${k}`;
  blocks.push(toolUseBlock(spare, "Read", { file_path: `${cwd}/README-${k}.md` }));
  ids.push(spare);
  for (let i = 0; i < blind; i++) {
    const b = `${s.id}-b${k}-${i}`;
    blocks.push(toolUseBlock(b, "Edit", { file_path: `${cwd}/src/blind-${k}-${i}.ts`, old_string: "a", new_string: "b" }));
    ids.push(b);
  }
  s.response(blocks, { model });
  // Failed results land on edit calls (non-command side of the split).
  const editIds = ids.filter((id) => /-[eb]\d+-\d+$/.test(id));
  const failed = new Set(editIds.slice(0, Math.max(0, Math.min(editIds.length, r.errors))));
  for (const id of ids) s.toolResult(id, failed.has(id) ? { isError: true, content: "synthetic failure" } : {});
  s.response([text("done")], { model });
}

/** Write the corpus under `<claudeDir>/projects/…`; returns every session (for the SessionStart hook). */
export function writeCorpus(claudeDir: string, spec: CorpusSpec): WrittenSession[] {
  const spd = spec.sessionsPerDay ?? 4, nx = spec.exchanges ?? 3;
  const out: WrittenSession[] = [];
  for (let d = 0; d < spec.days; d++) {
    const day = addDays(spec.start, d);
    const after = spec.onset !== undefined && d >= spec.onset;
    const rates = after && spec.after ? spec.after : spec.before;
    for (let i = 0; i < spd; i++) {
      const project = PROJECTS[i % PROJECTS.length]!;
      const cwd = `/synthetic/home/${project}`;
      const id = `sess-${day}-${i}`;
      const start = `${day}T${String(9 + 2 * i).padStart(2, "0")}:00:00.000Z`;
      const version = spec.bumpVersion ? (after ? spec.bumpVersion.to : spec.bumpVersion.from) : (spec.version ?? "2.1.250");
      const s = new SessionBuilder(id, { start, version, cwd, entrypoint: "cli" });
      const w = WIGGLE[i % WIGGLE.length]!;
      const r = { errors: Math.max(0, rates.errors + w), blind: Math.max(0, rates.blind + w) };
      const base = spec.model ?? "claude-opus-5-5";
      if (spec.switchModel && spec.onset !== undefined && d === spec.onset && i === 0) {
        // The switch: one exchange on the old model (the in-session baseline), then /model, then the new model.
        exchange(s, cwd, 0, spec.before, spec.switchModel.from);
        s.user(`<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>${spec.switchModel.to}</command-args>`);
        for (let k = 1; k < nx; k++) exchange(s, cwd, k, r, spec.switchModel.to);
      } else {
        const model = spec.switchModel ? (after ? spec.switchModel.to : spec.switchModel.from) : base;
        for (let k = 0; k < nx; k++) exchange(s, cwd, k, r, model);
      }
      const dir = join(claudeDir, "projects", `-synthetic-home-${project}`);
      mkdirSync(dir, { recursive: true });
      writeJsonl(join(dir, `${id}.jsonl`), s.records);
      out.push({ id, project, cwd, start, day });
    }
  }
  return out;
}
