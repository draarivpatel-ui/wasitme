import { createHash } from "node:crypto";
import type { HashFn } from "../../types.js";
import { cleanLabel, looksSecret } from "../../util.js";

/** Short salted id as it appears in snapshots and events: "h:" + 8 lowercase hex chars. */
export const SHORT_HASH_RE = /^h:[0-9a-f]{8}$/;

/** Salted short hash of `value` (the HashFn's output is clamped to the documented "h:xxxxxxxx" shape). */
export function shortHash(hash: HashFn, value: string): string {
  const raw = hash(value, "h:");
  const hex = (raw.startsWith("h:") ? raw.slice(2) : raw).toLowerCase().replace(/[^0-9a-f]/g, "");
  return "h:" + hex.padEnd(8, "0").slice(0, 8);
}

/** Unsalted short hash. Only for places that have no HashFn (event ids when the caller gave none). */
export function unsaltedShortHash(value: string): string {
  return "h:" + createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export { looksSecret };

/** cleanLabel plus a token-shape guard. */
export function safeLabel(value: unknown): string | undefined {
  const l = cleanLabel(value);
  return l !== undefined && !looksSecret(l) ? l : undefined;
}

/**
 * Value of a config key as a snapshot item: a label, "unset" when absent, or a salted short hash
 * when the value is not label-safe (so nothing unexpected rides along).
 *
 * `vocab` is for keys whose legal values are a fixed list (permission mode, approval policy …).
 * With it, a value is shown only if it is on the list: a charset check alone lets any
 * user-chosen word through (a client name is a perfectly good label), a list does not.
 * Leave it off only where the product itself shows the value (model and effort names).
 */
export function labelOf(hash: HashFn, value: unknown, vocab?: ReadonlySet<string>): string {
  if (value === undefined || value === null) return "unset";
  if (typeof value === "string" || typeof value === "number") {
    const label = safeLabel(value);
    const ok = label !== undefined && (vocab === undefined ? FREE_LABEL.test(label) : vocab.has(label));
    return ok ? label! : shortHash(hash, String(value));
  }
  return shortHash(hash, canonicalJson(value));
}

/**
 * Shape of a free label (model and effort names; PRIVACY.md "What is stored"): an id-like token — letters, digits and
 * `. _ : -`, an optional context suffix like `[1m]` and one Vertex-style version suffix (`@20250514`, `@latest`,
 * `@default`) — and never spaces. cleanLabel alone lets short prose through ("the launch codename is …"), which the
 * WP-12 privacy probe caught in a model value; a free `@…` suffix let an e-mail address through (WP-12 review).
 */
const FREE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(\[[0-9A-Za-z]{1,8}\])?(@(?:\d{8}|latest|default))?$/;

/** Like labelOf, but never readable: "unset" when absent, otherwise a salted short hash (switches stay detectable). */
export function hashedOf(hash: HashFn, value: unknown): string {
  if (value === undefined || value === null) return "unset";
  return shortHash(hash, typeof value === "string" ? value : canonicalJson(value));
}

const MAX_CANON_DEPTH = 40;

/** Deterministic JSON (sorted keys, depth-bounded) so semantically equal config hashes equally. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (depth > MAX_CANON_DEPTH) return '"~deep~"';
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalJson(v, depth + 1)).join(",") + "]";
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(rec[k], depth + 1)).join(",") + "}";
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Sorted key names of a map; the values are dropped (env blocks: key names only, never values). */
export function keysOnly(v: unknown): string[] | string {
  return isRecord(v) ? Object.keys(v).sort() : typeof v;
}

/** Keys of an MCP server definition whose values carry credentials (env vars, auth headers). */
const SECRET_MAPS = new Set(["env", "headers", "http_headers", "env_http_headers"]);

/**
 * An MCP server definition with its env/header VALUES removed (key names kept). command, args and
 * url stay so that editing a server is still detectable — only as a salted hash, never as text.
 */
export function redactServer(cfg: unknown): unknown {
  if (!isRecord(cfg)) return cfg;
  return Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, SECRET_MAPS.has(k) ? keysOnly(v) : v]));
}

/** The whole mcpServers / mcp_servers block, redacted server by server. */
export function redactServers(servers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(servers).map(([name, cfg]) => [name, redactServer(cfg)]));
}
