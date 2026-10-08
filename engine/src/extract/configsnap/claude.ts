import { join } from "node:path";
import type { HashFn } from "../../types.js";
import { Collector, decodeText, nameItems, parseJson } from "./common.js";
import type { AgentCollect } from "./common.js";
import { scanTopLevel } from "./jsonscan.js";
import { canonicalJson, isRecord, keysOnly, labelOf, redactServers, shortHash } from "./labels.js";
import { resolveClaudePaths } from "./paths.js";
import { isDirSafe, readCapped } from "./safefs.js";
import type { ReadOutcome } from "./safefs.js";
import type { Ctx, Items } from "./types.js";
import { KNOWN_HOOK_EVENTS, PERMISSION_MODES } from "./vocab.js";

/**
 * Claude Code global configuration → ConfigSnapshot items. Reads, in this order:
 *   <dir>/CLAUDE.md, <dir>/settings.json, Claude's global state file (~/.claude.json by default; see
 *   resolveClaudePaths; top-level mcpServers only),
 *   <dir>/plugins/installed_plugins.json, <dir>/skills/<name>/SKILL.md (existence only).
 * Never reads project folders, settings.local.json, managed settings, hook/skill/MCP contents.
 *
 * Item keys (first segment = the source; a snapshot either has a whole source or none of it):
 *   instructions.{present,hash,bytes,lines,capped}
 *   settings.{model,effort,thinking}                                  labels / "unset"
 *   settings.permissions.mode                                         fixed-vocabulary label, else a hash / "unset"
 *   settings.statusline.{present,hash}
 *   settings.hooks.{total,hash,event.<Name>}                          handler counts; <Name> is a known event or a hash
 *   settings.permissions.{allow,deny,ask,count,hash}                  rule counts only
 *   settings.env.{count,hash}                                         key count only
 *   settings.plugins.{count,name.<h>}                                 enabled plugins, hashed names
 *   settings.other.hash                                               hash of every setting not itemised above
 *   claudejson.mcp.{count,hash,name.<h>}
 *   plugins.installed.{count,name.<h>}
 *   skills.{count,name.<h>}
 */
export function collectClaude(ctx: Ctx): AgentCollect {
  const c = new Collector("claude-code", ctx);
  const paths = resolveClaudePaths(ctx.env, ctx.home);

  const dir = isDirSafe(paths.dir, ctx.guard);
  if (dir !== "ok") {
    c.note("config-dir", dir);
    return c.done(false);
  }

  c.instructions(readCapped(join(paths.dir, "CLAUDE.md"), ctx.capBytes, ctx.guard));
  collectSettings(c, join(paths.dir, "settings.json"));
  collectClaudeJson(c, paths.jsonCandidates);
  collectInstalledPlugins(c, join(paths.dir, "plugins", "installed_plugins.json"));
  c.skills(join(paths.dir, "skills"));
  return c.done(true);
}

/** settings.json. A missing file is definitive (empty settings); anything unreadable/oversized/malformed is unknown. */
function collectSettings(c: Collector, path: string): void {
  const out = readCapped(path, c.ctx.capBytes, c.ctx.guard);
  if (out.access === "missing") {
    c.put(settingsItems({}, c.hash));
    c.note("settings", "missing");
  } else if (out.access !== "ok" || !out.buf) {
    c.note("settings", out.access);
  } else if (out.capped) {
    c.note("settings", "capped");
  } else {
    const text = decodeText(out.buf);
    const parsed = text.trim() === "" ? {} : parseJson(text);
    if (isRecord(parsed)) {
      c.put(settingsItems(parsed, c.hash));
      c.note("settings", "ok");
    } else {
      c.note("settings", "malformed");
    }
  }
}

/**
 * ~/.claude.json: top-level mcpServers only. `projects` (whose keys are filesystem paths) is skipped
 * unseen. If the file is cut off by the cap before the key is found we cannot say "no servers" — unknown.
 */
function collectClaudeJson(c: Collector, candidates: readonly string[]): void {
  let out: ReadOutcome | undefined;
  for (const p of candidates) {
    out = readCapped(p, c.ctx.claudeJsonCapBytes, c.ctx.guard);
    if (out.access !== "missing") break;
  }
  if (!out || out.access === "missing") {
    c.put(mcpItems({}, c.hash, false));
    c.note("claude-json", "missing");
    return;
  }
  if (out.access !== "ok" || !out.buf) {
    c.note("claude-json", out.access);
    return;
  }
  const scan = scanTopLevel(decodeText(out.buf), new Set(["mcpServers"]));
  const raw = scan.found.get("mcpServers");
  if (raw === undefined) {
    if (scan.complete) {
      c.put(mcpItems({}, c.hash, false));
      c.note("claude-json", "ok");
    } else {
      c.note("claude-json", out.capped ? "capped" : "malformed");
    }
    return;
  }
  const parsed = parseJson(raw);
  if (isRecord(parsed) || parsed === null) {
    c.put(mcpItems(isRecord(parsed) ? parsed : {}, c.hash, true));
    c.note("claude-json", out.capped ? "capped" : "ok");
  } else {
    c.note("claude-json", "malformed");
  }
}

function collectInstalledPlugins(c: Collector, path: string): void {
  const out = readCapped(path, c.ctx.capBytes, c.ctx.guard);
  if (out.access === "missing") {
    c.put(nameItems("plugins.installed", [], c.hash));
    c.note("installed-plugins", "missing");
  } else if (out.access !== "ok" || !out.buf) {
    c.note("installed-plugins", out.access);
  } else if (out.capped) {
    c.note("installed-plugins", "capped");
  } else {
    const parsed = parseJson(decodeText(out.buf));
    const plugins = isRecord(parsed) ? parsed.plugins : undefined;
    if (isRecord(plugins)) {
      c.put(nameItems("plugins.installed", Object.keys(plugins), c.hash));
      c.note("installed-plugins", "ok");
    } else {
      c.note("installed-plugins", "malformed");
    }
  }
}

function mcpItems(servers: Record<string, unknown>, hash: HashFn, hashIt: boolean): Items {
  const items = nameItems("claudejson.mcp", Object.keys(servers), hash);
  if (hashIt) items["claudejson.mcp.hash"] = shortHash(hash, canonicalJson(redactServers(servers)));
  return items;
}

function handlerCount(groups: unknown): number {
  if (!Array.isArray(groups)) return 0;
  let n = 0;
  for (const g of groups) {
    if (isRecord(g) && Array.isArray(g.hooks)) n += g.hooks.filter(isRecord).length;
  }
  return n;
}

const ruleCount = (v: unknown): number => (Array.isArray(v) ? v.filter((x) => typeof x === "string").length : 0);

/** Settings keys that get their own items; every other key is folded into settings.other.hash. */
const ITEMISED = new Set(["model", "effortLevel", "effort", "alwaysThinkingEnabled", "statusLine", "hooks", "permissions", "env", "enabledPlugins"]);

/** Turns settings.json into counts, labels and salted hashes. No value is copied through. */
export function settingsItems(s: Record<string, unknown>, hash: HashFn): Items {
  const items: Items = {};

  items["settings.model"] = labelOf(hash, s.model);
  items["settings.effort"] = labelOf(hash, s.effortLevel !== undefined ? s.effortLevel : s.effort);
  const think = s.alwaysThinkingEnabled;
  items["settings.thinking"] = think === undefined || think === null ? "unset" : typeof think === "boolean" ? (think ? "on" : "off") : "other";

  const hasStatus = s.statusLine !== undefined && s.statusLine !== null;
  items["settings.statusline.present"] = hasStatus;
  if (hasStatus) items["settings.statusline.hash"] = shortHash(hash, canonicalJson(s.statusLine));

  let hookTotal = 0;
  if (isRecord(s.hooks)) {
    for (const [event, groups] of Object.entries(s.hooks)) {
      const n = handlerCount(groups);
      if (n === 0) continue;
      // Only Claude Code's own event names are shown; anything else (a typo, a newer event, a user-chosen word) is a hash.
      const name = KNOWN_HOOK_EVENTS.has(event) ? event : shortHash(hash, event);
      const key = `settings.hooks.event.${name}`;
      const prev = items[key];
      items[key] = (typeof prev === "number" ? prev : 0) + n;
      hookTotal += n;
    }
  }
  items["settings.hooks.total"] = hookTotal;
  if (s.hooks !== undefined) items["settings.hooks.hash"] = shortHash(hash, canonicalJson(s.hooks));

  const perms = isRecord(s.permissions) ? s.permissions : undefined;
  const allow = ruleCount(perms?.allow);
  const deny = ruleCount(perms?.deny);
  const ask = ruleCount(perms?.ask);
  items["settings.permissions.allow"] = allow;
  items["settings.permissions.deny"] = deny;
  items["settings.permissions.ask"] = ask;
  items["settings.permissions.count"] = allow + deny + ask;
  items["settings.permissions.mode"] = labelOf(hash, perms?.defaultMode, PERMISSION_MODES);
  if (s.permissions !== undefined) {
    // defaultMode is reported on its own; the hash covers the rules (and anything else in the block).
    const rules = perms ? Object.fromEntries(Object.entries(perms).filter(([k]) => k !== "defaultMode")) : s.permissions;
    items["settings.permissions.hash"] = shortHash(hash, canonicalJson(rules));
  }

  // env: key count, and a hash of the sorted KEY NAMES. Values (API keys, tokens, URLs) are never read into anything.
  items["settings.env.count"] = isRecord(s.env) ? Object.keys(s.env).length : 0;
  if (s.env !== undefined) items["settings.env.hash"] = shortHash(hash, canonicalJson(keysOnly(s.env)));

  const enabled = isRecord(s.enabledPlugins) ? Object.entries(s.enabledPlugins).filter(([, v]) => Boolean(v)).map(([k]) => k) : [];
  Object.assign(items, nameItems("settings.plugins", enabled, hash));

  const rest = Object.fromEntries(Object.entries(s).filter(([k]) => !ITEMISED.has(k)));
  items["settings.other.hash"] = shortHash(hash, canonicalJson(rest));

  return items;
}
