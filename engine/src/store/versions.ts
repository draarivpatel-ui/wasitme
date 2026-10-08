/**
 * Per-family parser versions (METHOD.md §9 "Format drift") as the store uses them.
 *
 * Both readers export the same family names (aligned at WP-12): exchanges, toolErrors, research, friction, context,
 * labels, interactive, events — and a field → family map for every Exchange field. A shard records the versions it
 * was derived with. When a family's number moves:
 *  - source still present: the source is re-parsed and ONLY that family's fields (or its events) are copied into the
 *    stored exchanges, so a bump whose parser output did not change leaves the state byte-identical; a bump of
 *    `exchanges` (what an exchange is) replaces everything, since ids and boundaries may move;
 *  - source deleted: history cannot be re-derived; the shard keeps its old numbers and the affected metrics are
 *    reported as paused (`health.paused[].why = "parser_changed"`) while that history is inside an evaluated window.
 */
import { CLAUDE_FIELD_FAMILY, CLAUDE_PARSER_VERSIONS } from "../readers/claude.js";
import { CODEX_FIELD_FAMILY, CODEX_PARSER_VERSIONS } from "../readers/codex.js";
import type { AgentId, Exchange } from "../types.js";

export type FamilyVersions = Readonly<Record<string, number>>;
export type VersionOverride = Partial<Record<AgentId, Partial<Record<string, number>>>>;

export const READER_VERSIONS: Readonly<Record<AgentId, FamilyVersions>> = Object.freeze({
  "claude-code": CLAUDE_PARSER_VERSIONS,
  codex: CODEX_PARSER_VERSIONS,
});

export const FIELD_FAMILY: Readonly<Record<AgentId, Readonly<Record<keyof Exchange, string>>>> = Object.freeze({
  "claude-code": CLAUDE_FIELD_FAMILY,
  codex: CODEX_FIELD_FAMILY,
});

/** Families whose change replaces a whole shard (exchange boundaries and ids may move). */
export const STRUCTURAL_FAMILY = "exchanges";
export const EVENTS_FAMILY = "events";

/** The reader's versions with an optional override (tests bump a family this way). */
export function currentVersions(agent: AgentId, override?: VersionOverride): Record<string, number> {
  const base: Record<string, number> = { ...READER_VERSIONS[agent] };
  const o = override?.[agent];
  if (o) for (const [k, v] of Object.entries(o)) if (typeof v === "number" && Number.isSafeInteger(v) && v >= 1) base[k] = v;
  return sortKeys(base);
}

/** Families whose stored version differs from the current one (a family missing on either side counts). */
export function changedFamilies(stored: FamilyVersions | undefined, current: FamilyVersions): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(current)) if (stored?.[k] !== v) out.add(k);
  for (const k of Object.keys(stored ?? {})) if (!(k in current)) out.add(k);
  return [...out].sort();
}

/**
 * `snapshot.health.parserVersions`: one family → version map when every agent agrees on a family's number; when
 * they disagree, per-agent keys (`claudeCodeToolErrors`, `codexToolErrors`). Keys stay inside the schema's
 * ^[A-Za-z][A-Za-z0-9]{0,31}$ and the 24-key cap.
 */
export function healthParserVersions(byAgent: ReadonlyMap<AgentId, FamilyVersions>): Record<string, number> {
  const out: Record<string, number> = {};
  const families = new Set<string>();
  for (const v of byAgent.values()) for (const k of Object.keys(v)) families.add(k);
  for (const f of [...families].sort()) {
    const vals = new Set<number>();
    for (const v of byAgent.values()) if (typeof v[f] === "number") vals.add(v[f]!);
    if (vals.size === 1) out[f] = [...vals][0]!;
    else for (const [agent, v] of byAgent) if (typeof v[f] === "number") out[`${camel(agent)}${f[0]!.toUpperCase()}${f.slice(1)}`] = v[f]!;
  }
  const keys = Object.keys(out).filter((k) => /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k)).slice(0, 24);
  const bounded: Record<string, number> = {};
  for (const k of keys) bounded[k] = out[k]!;
  return bounded;
}

function camel(agent: string): string {
  return agent.replace(/[^A-Za-z0-9]+([A-Za-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, "");
}

export function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k]!;
  return out;
}

/** Every Exchange field in one canonical order (the shards serialise exchanges in this order). */
export const EXCHANGE_FIELDS: readonly (keyof Exchange)[] = Object.freeze(Object.keys(CLAUDE_FIELD_FAMILY) as (keyof Exchange)[]);
