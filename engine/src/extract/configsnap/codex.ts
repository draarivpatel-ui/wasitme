import { join } from "node:path";
import type { HashFn } from "../../types.js";
import { Collector, decodeText, nameItems } from "./common.js";
import type { AgentCollect } from "./common.js";
import { canonicalJson, hashedOf, labelOf, redactServers, shortHash } from "./labels.js";
import { resolveCodexDir } from "./paths.js";
import { isDirSafe, readCapped } from "./safefs.js";
import { isTable, parseToml } from "./toml.js";
import type { TomlTable } from "./toml.js";
import type { Ctx, Items } from "./types.js";
import { APPROVAL_POLICIES, BUILTIN_PROVIDERS, SANDBOX_MODES } from "./vocab.js";

/**
 * Codex global configuration → ConfigSnapshot items. Reads <dir>/config.toml (data-only parse),
 * <dir>/AGENTS.override.md or <dir>/AGENTS.md (hash/size only), <dir>/skills/<name>/SKILL.md (existence only).
 * Never reads project folders, rules/, hooks, notify commands or MCP command/args/env values.
 *
 * Item keys:
 *   instructions.{present,hash,bytes,lines,capped}
 *   config.{model,effort}                                            labels / "unset"
 *   config.{provider,approval,sandbox}                               fixed-vocabulary labels, else a hash / "unset"
 *   config.profile                                                   salted hash / "unset" (profile names are user-invented)
 *   config.notify.present
 *   config.mcp.{count,hash,name.<h>}
 *   config.plugins.{count,name.<h>}                                  enabled plugins, hashed names
 *   skills.{count,name.<h>}
 *
 * When `profile = "x"` is set and [profiles.x] exists, the profile's model / model_reasoning_effort /
 * model_provider / approval_policy / sandbox_mode override the top-level values (as Codex applies them).
 */
export function collectCodex(ctx: Ctx): AgentCollect {
  const c = new Collector("codex", ctx);
  const dir = resolveCodexDir(ctx.env, ctx.home);

  const dirState = isDirSafe(dir, ctx.guard);
  if (dirState !== "ok") {
    c.note("config-dir", dirState);
    return c.done(false);
  }

  // Codex prefers AGENTS.override.md over AGENTS.md (per its docs; not verified locally). An empty
  // override does not count. A broken override makes instructions unknown rather than silently
  // falling back to a file Codex would not be using.
  const override = readCapped(join(dir, "AGENTS.override.md"), ctx.capBytes, ctx.guard);
  const useOverride = override.access !== "missing" && !(override.access === "ok" && override.size === 0);
  c.instructions(useOverride ? override : readCapped(join(dir, "AGENTS.md"), ctx.capBytes, ctx.guard));

  collectConfigToml(c, join(dir, "config.toml"));
  c.skills(join(dir, "skills"));
  return c.done(true);
}

/** config.toml. A missing file is definitive (all defaults); unreadable/oversized/malformed is unknown. */
function collectConfigToml(c: Collector, path: string): void {
  const out = readCapped(path, c.ctx.capBytes, c.ctx.guard);
  if (out.access === "missing") {
    c.put(configItems(Object.create(null) as TomlTable, c.hash));
    c.note("config-toml", "missing");
  } else if (out.access !== "ok" || !out.buf) {
    c.note("config-toml", out.access);
  } else if (out.capped) {
    c.note("config-toml", "capped");
  } else {
    const { root, errors } = parseToml(decodeText(out.buf));
    if (errors === 0) {
      c.put(configItems(root, c.hash));
      c.note("config-toml", "ok");
    } else {
      // A partial tree could report "0 MCP servers" for a file that has 3: trust none of it.
      c.note("config-toml", "malformed");
    }
  }
}

export function configItems(root: TomlTable, hash: HashFn): Items {
  const profileName = typeof root.profile === "string" ? root.profile : undefined;
  const profiles = isTable(root.profiles) ? root.profiles : undefined;
  const chosen = profileName !== undefined && profiles ? profiles[profileName] : undefined;
  const profile = isTable(chosen) ? chosen : undefined;
  const effective = (key: string): unknown => (profile && key in profile ? profile[key] : root[key]);

  const items: Items = {
    // A profile name is whatever the user typed (often a client or project): hash only, so a switch is still seen.
    "config.profile": hashedOf(hash, root.profile),
    "config.model": labelOf(hash, effective("model")),
    "config.effort": labelOf(hash, effective("model_reasoning_effort")),
    // Provider ids outside the built-in set name a user-defined [model_providers.<id>] table.
    "config.provider": labelOf(hash, effective("model_provider"), BUILTIN_PROVIDERS),
    "config.approval": labelOf(hash, effective("approval_policy"), APPROVAL_POLICIES),
    "config.sandbox": labelOf(hash, effective("sandbox_mode"), SANDBOX_MODES),
    "config.notify.present": Array.isArray(root.notify) ? root.notify.length > 0 : root.notify !== undefined,
  };

  const servers = isTable(root.mcp_servers) ? root.mcp_servers : undefined;
  const serverNames = servers ? Object.keys(servers).filter((k) => isTable(servers[k])) : [];
  Object.assign(items, nameItems("config.mcp", serverNames, hash));
  if (servers) items["config.mcp.hash"] = shortHash(hash, canonicalJson(redactServers(servers)));

  const plugins = isTable(root.plugins) ? root.plugins : undefined;
  const enabled = plugins
    ? Object.keys(plugins).filter((k) => {
        const p = plugins[k];
        return isTable(p) && p.enabled !== false;
      })
    : [];
  Object.assign(items, nameItems("config.plugins", enabled, hash));

  return items;
}
