/**
 * Source discovery for Claude Code (stat only, no file reads).
 *
 * Layout: <root>/projects/<encoded-cwd>/<sessionId>.jsonl, with subagent transcripts under
 * <sessionId>/subagents/agent-*.jsonl and <sessionId>/subagents/workflows/<run>/agent-*.jsonl.
 *
 * A Source's files are exactly the session's own transcripts: the main file, then its subagent
 * transcripts. Every FileStamp is a stat of a regular file at that path. Only `*.jsonl` transcripts are
 * listed: no file under a `tool-results/` folder (spilled tool output) is ever listed or opened. A session that
 * EnterWorktree moved to another project folder (D62b) keeps the subagent transcripts it left behind: a
 * `<sessionId>/subagents/` folder with no `<sessionId>.jsonl` next to it joins the one source of that session id.
 *
 * A resumed session re-logs earlier records (same uuids and timestamps) into a new file in the same
 * project folder; parse() drops those copies by checking the sessions created before it ("priors",
 * see priors.ts). That dependency on sibling sessions is NOT part of Source.files: list() hands the
 * project's creation order to the priors index, and parse() reports the sessions it actually replays in
 * `ParseResult.deps` (D39, WP-12), so the store re-parses a session when a session it replays changes —
 * and not when an unrelated earlier session in the same project is appended (a digest of every earlier
 * session would re-parse every later session of a busy project on each append).
 */
import { basename, dirname, join, relative, sep } from "node:path";
import type { FileStamp, Source } from "../../types.js";
import { entries, walkFiles } from "../fs.js";
import { rememberListing } from "./priors.js";
import { byName, projectMains, statFile } from "./project.js";

export { creationOrder } from "./project.js";

/** Folder name Claude Code spills large tool output into; nothing under it is a transcript. */
const TOOL_RESULTS = "tool-results";

/** Subagent transcripts of one session, sorted; journals, meta files and spilled tool output are not transcripts. */
export function subagentFiles(projectDir: string, sessionFile: string): FileStamp[] {
  const dir = join(projectDir, basename(sessionFile, ".jsonl"), "subagents");
  const paths = walkFiles(dir, (n) => n.startsWith("agent-") && n.endsWith(".jsonl"), 4)
    .filter((p) => !relative(dir, p).split(sep).includes(TOOL_RESULTS))
    .sort();
  const out: FileStamp[] = [];
  for (const p of paths) {
    const st = statFile(p)?.stamp;
    if (st) out.push(st);
  }
  return out;
}

export function listSources(projectsDir: string): Source[] {
  const sources: Source[] = [];
  /** Session id → the sources whose main transcript has that name (more than one only after a stray re-creation). */
  const bySession = new Map<string, Source[]>();
  /** Session folders whose main transcript is not next to them: [project folder, session id]. */
  const orphans: [string, string][] = [];
  for (const proj of entries(projectsDir).sort(byName)) {
    if (!proj.isDir) continue;
    const order = projectMains(proj.path);
    rememberListing(proj.path, order.map((m) => m.stamp));
    for (const m of [...order].sort(byName)) {
      const source: Source = {
        agent: "claude-code",
        key: `${proj.name}/${m.name}`,
        files: [m.stamp, ...subagentFiles(proj.path, m.name)],
      };
      sources.push(source);
      const sid = basename(m.name, ".jsonl");
      const same = bySession.get(sid);
      if (same) same.push(source);
      else bySession.set(sid, [source]);
    }
    const mains = new Set(order.map((m) => m.name));
    for (const d of entries(proj.path).sort(byName)) if (d.isDir && !mains.has(`${d.name}.jsonl`)) orphans.push([proj.path, d.name]);
  }
  // A session that EnterWorktree moved to another project folder (D62b) may leave its subagent transcripts behind:
  // they belong to the one main transcript of that session id elsewhere (never attached when two folders hold one).
  for (const [dir, sid] of orphans) {
    const owners = bySession.get(sid);
    if (owners?.length !== 1) continue;
    owners[0]!.files.push(...subagentFiles(dir, `${sid}.jsonl`));
  }
  return sources;
}

export interface SourceFiles {
  main: FileStamp;
  subagents: FileStamp[];
}

/**
 * Split a source's files by role, using path structure only (anything else is ignored): the main transcript first,
 * then subagent transcripts under `<project folder>/<session id>/subagents/` — its own folder's, or another project
 * folder's when the session was moved away from it (listSources).
 */
export function classify(files: readonly FileStamp[]): SourceFiles | undefined {
  const [main, ...rest] = files;
  if (!main) return undefined;
  const sid = basename(main.path, ".jsonl");
  const projects = dirname(dirname(main.path));
  const subagents: FileStamp[] = [];
  for (const f of rest) {
    const rel = relative(projects, f.path).split(sep);
    if (rel.length >= 4 && rel[0] !== ".." && rel[0] !== "" && rel[1] === sid && rel[2] === "subagents" && !rel.includes(TOOL_RESULTS)) {
      subagents.push(f);
    }
  }
  return { main, subagents };
}
