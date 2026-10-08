/**
 * Project snapshots (D32; PRIVACY.md "What is read").
 *
 * The SessionStart hook (engine/src/hook/session-start.ts) is the only code that reads project files. Each run writes
 * ONE record, atomically, into `state/projsnap/` (an inbox: hooks never rewrite shared files, so concurrent sessions
 * cannot clobber each other). The next scan, under the scan lock, consolidates the inbox into
 * `history/projsnap.json` (keyed by record name, so a crash between the history write and the inbox cleanup
 * re-ingests nothing twice) and then removes the consumed inbox files. Scans never touch project folders.
 *
 * A record holds: when (`t`, UTC), which session (`s-` HMAC of the session id: the same id the Claude reader gives
 * that session), which project (`p-` HMACs of the cwd in the encodings the readers use), whether it observed
 * anything (an EPERM / sandbox denial means "not observed"), and per fixed file name: present / salted hash / bytes /
 * lines. A torn or unreadable file contributes no keys ("unknown": no event).
 *
 * From the consolidated records the scan derives:
 *  - change events (agent claude-code, side you, provenance project_snapshot): a project instruction file
 *    (CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md) or .mcp.json appearing, disappearing or changing → strong;
 *    .claude/settings(.local).json → weak (only its hash is known, not which setting moved);
 *  - which sessions were observed on which local day (the "fully observed" rule, D63).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ChangeEvent, ChangeKind, ChangeStrength, HashFn } from "../types.js";
import { localDay } from "../util.js";
import { readOwnJson, removeQuietly, writeIfChanged } from "./atomic.js";

export const PROJSNAP_SCHEMA = "wasitme.projsnap/1";
const HISTORY_SCHEMA = "wasitme.projsnap-history/1";
const MAX_RECORDS = 20_000;
const MAX_INBOX = 5_000;

/** The fixed project files the hook looks at, by stable item id. */
export const PROJECT_FILES = [
  { id: "claudeMd", rel: ["CLAUDE.md"], kind: "instructions", strength: "strong", json: false },
  { id: "claudeLocalMd", rel: ["CLAUDE.local.md"], kind: "instructions", strength: "strong", json: false },
  { id: "dotClaudeMd", rel: [".claude", "CLAUDE.md"], kind: "instructions", strength: "strong", json: false },
  { id: "settings", rel: [".claude", "settings.json"], kind: "config", strength: "weak", json: true },
  { id: "settingsLocal", rel: [".claude", "settings.local.json"], kind: "config", strength: "weak", json: true },
  { id: "mcpJson", rel: [".mcp.json"], kind: "mcp", strength: "strong", json: true },
] as const satisfies readonly { id: string; rel: readonly string[]; kind: ChangeKind; strength: ChangeStrength; json: boolean }[];

const FILE_IDS = new Set<string>(PROJECT_FILES.map((f) => f.id));
const ITEM_RE = /^([A-Za-z]+)\.(present|hash|bytes|lines)$/;
const HASH_RE = /^h:[0-9a-f]{8}$/;
const SESSION_RE = /^s-[0-9a-f]{12}$/;
const PROJECT_RE = /^p-[0-9a-f]{12}$/;
const NAME_RE = /^[0-9TZ-]{15,32}-[0-9a-f]{12}\.json$/;

export type ProjItems = Record<string, string | number | boolean>;

export interface ProjRecord {
  name: string;
  t: string;
  session: string | null;
  projects: string[];
  observed: boolean;
  items: ProjItems;
}

export interface ProjHistory { records: ProjRecord[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate one record (from the inbox or the history file): anything off-shape is dropped, never repaired. */
export function validRecord(name: string, v: unknown): ProjRecord | undefined {
  if (!NAME_RE.test(name) || !isObj(v) || v.schema !== PROJSNAP_SCHEMA) return undefined;
  if (typeof v.t !== "string" || !Number.isFinite(Date.parse(v.t))) return undefined;
  const session = v.session === null ? null : typeof v.session === "string" && SESSION_RE.test(v.session) ? v.session : undefined;
  if (session === undefined) return undefined;
  if (!Array.isArray(v.projects) || v.projects.length === 0 || v.projects.length > 4 || !v.projects.every((p) => typeof p === "string" && PROJECT_RE.test(p))) return undefined;
  if (typeof v.observed !== "boolean" || !isObj(v.items)) return undefined;
  const items: ProjItems = {};
  for (const [k, val] of Object.entries(v.items)) {
    const m = ITEM_RE.exec(k);
    if (!m || !FILE_IDS.has(m[1]!)) return undefined;
    const ok = m[2] === "present" ? typeof val === "boolean"
      : m[2] === "hash" ? typeof val === "string" && HASH_RE.test(val)
      : typeof val === "number" && Number.isSafeInteger(val) && val >= 0;
    if (!ok) return undefined;
    items[k] = val as string | number | boolean;
  }
  return { name, t: new Date(Date.parse(v.t)).toISOString(), session, projects: [...v.projects] as string[], observed: v.observed, items };
}

export function loadProjHistory(path: string): ProjHistory {
  const v = readOwnJson(path, 64 << 20);
  if (!isObj(v) || v.schema !== HISTORY_SCHEMA || !Array.isArray(v.records)) return { records: [] };
  const records: ProjRecord[] = [];
  for (const r of v.records) {
    if (!isObj(r) || typeof r.name !== "string") continue;
    const ok = validRecord(r.name, { ...r, schema: PROJSNAP_SCHEMA });
    if (ok) records.push(ok);
  }
  return { records: sortRecords(records) };
}

function sortRecords(rs: ProjRecord[]): ProjRecord[] {
  return rs.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function sortedItems(items: ProjItems): ProjItems {
  const out: ProjItems = {};
  for (const k of Object.keys(items).sort()) out[k] = items[k]!;
  return out;
}

export function serializeProjHistory(h: ProjHistory): string {
  const records = h.records.map((r) => ({ name: r.name, t: r.t, session: r.session, projects: r.projects, observed: r.observed, items: sortedItems(r.items) }));
  return `${JSON.stringify({ schema: HISTORY_SCHEMA, records })}\n`;
}

/** Fold the inbox into the history (memory). Returns the inbox files consumed (to delete after the history is saved). */
export function ingestInbox(inbox: string, h: ProjHistory): { changed: boolean; consumed: string[] } {
  let names: string[] = [];
  try { names = readdirSync(inbox); } catch { return { changed: false, consumed: [] }; }
  const known = new Set(h.records.map((r) => r.name));
  const consumed: string[] = [];
  let changed = false;
  for (const name of names.filter((n) => n.endsWith(".json")).sort().slice(0, MAX_INBOX)) {
    const path = join(inbox, name);
    consumed.push(path);
    if (known.has(name)) continue;
    const rec = validRecord(name, readOwnJson(path, 1 << 20));
    if (!rec) continue; // off-shape: dropped (and removed with the rest)
    h.records.push(rec);
    known.add(name);
    changed = true;
  }
  if (changed) h.records = sortRecords(h.records).slice(-MAX_RECORDS);
  return { changed, consumed };
}

export function saveProjHistory(path: string, h: ProjHistory): boolean {
  return writeIfChanged(path, serializeProjHistory(h));
}

export function removeConsumed(paths: readonly string[]): void {
  for (const p of paths) removeQuietly(p);
}

/** Change events between consecutive observed snapshots of the same project (oldest first). */
export function projectEvents(h: ProjHistory, hash: HashFn, timeZone: string): ChangeEvent[] {
  const byProject = new Map<string, ProjRecord[]>();
  for (const r of h.records) {
    if (!r.observed) continue;
    const key = r.projects[0]!;
    const l = byProject.get(key);
    if (l) l.push(r); else byProject.set(key, [r]);
  }
  const out: ChangeEvent[] = [];
  for (const [project, recs] of [...byProject.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // Last known state per file: a later record that could not read a file keeps the earlier state (unknown ≠ changed).
    const known = new Map<string, { present: boolean; hash?: string }>();
    for (const r of recs) {
      for (const f of PROJECT_FILES) {
        const present = r.items[`${f.id}.present`];
        if (typeof present !== "boolean") continue; // not observed this time
        const h = r.items[`${f.id}.hash`];
        const now = { present, hash: typeof h === "string" ? h : undefined };
        const prev = known.get(f.id);
        known.set(f.id, now);
        if (!prev) continue; // the first observation is a baseline
        let from: string, to: string;
        if (prev.present !== now.present) {
          from = prev.present ? prev.hash ?? "present" : "absent";
          to = now.present ? now.hash ?? "present" : "absent";
        } else if (now.present && prev.hash !== undefined && now.hash !== undefined && prev.hash !== now.hash) {
          from = prev.hash;
          to = now.hash;
        } else continue;
        out.push({
          id: hash(`projsnap|${project}|${f.id}|${from}|${to}|${r.t}`, "c-"),
          t: r.t,
          day: localDay(r.t, timeZone),
          agent: "claude-code",
          kind: f.kind,
          side: "you",
          strength: f.strength,
          provenance: "project_snapshot",
          from,
          to,
          evidence: "snapshot",
          note: `project ${f.kind === "instructions" ? "instructions" : f.kind === "mcp" ? "MCP servers" : "settings"}`,
        });
      }
    }
  }
  return out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.id < b.id ? -1 : 1));
}

/** Local day → sessions that had an observed project snapshot that day. */
export function observedSessionsByDay(h: ProjHistory, timeZone: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of h.records) {
    if (!r.observed || r.session === null) continue;
    const d = localDay(r.t, timeZone);
    let s = out.get(d);
    if (!s) out.set(d, (s = new Set()));
    s.add(r.session);
  }
  return out;
}
