#!/usr/bin/env node
// plugin-manifests.mjs - the plugin manifests, generated from ONE source (DECISIONS D49, D25).
//
// Usage:
//   node scripts/plugin-manifests.mjs           write them
//   node scripts/plugin-manifests.mjs --check   fail (exit 1) if any differs from what this would write
//
// The one source is this file plus engine/package.json, which carries the release version and the author (D17: the
// author is kept in one place). From it come:
//   plugin-codex/.codex-plugin/plugin.json     Codex's own manifest location
//   plugin-codex/plugin.json                   the agent-plugins manifest; Codex 0.160 installs THIS version when both
//                                              exist and disagree (S-CX §2.4), so both must always be equal
//   plugin-codex/.agents/plugins/marketplace.json   the separate marketplace root `wasitme-codex` (D32/D49)
// and the `version` field of the Claude Code plugin (plugin/.claude-plugin/plugin.json), so every manifest moves with
// the engine: Claude Code's third-party auto-update is off and a version bump is what moves an install forward (D25).
//
// plugin-codex/ holds exactly those three files and skills/report/SKILL.md: Codex copies the whole marketplace root into
// its cache, so nothing else (no tests, no generator, never a hooks/ folder) may live there. Zero dependencies.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The single source: everything Codex reads about the plugin. */
export const CODEX = {
  marketplace: "wasitme-codex",
  plugin: "wasitme",
  description:
    "The wasitme evidence report for Codex (was it me, or the agent?), built on this machine from your own session logs. Skills only; needs the full wasitme install. No network code. Independent; not affiliated with or endorsed by OpenAI or Anthropic.",
  schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
};

const json = (value) => JSON.stringify(value, null, 2) + "\n";

/** { path (repo-relative): exact file text } for every file this generator owns, from the engine's package.json. */
export function expected(root = ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, "engine", "package.json"), "utf8"));
  const version = String(pkg.version);
  const author = String(pkg.author);
  const claudePath = join("plugin", ".claude-plugin", "plugin.json");
  const claude = JSON.parse(readFileSync(join(root, claudePath), "utf8"));
  claude.version = version;
  return {
    [join("plugin-codex", ".codex-plugin", "plugin.json")]: json({
      name: CODEX.plugin,
      version,
      description: CODEX.description,
      skills: "./skills/",
    }),
    [join("plugin-codex", "plugin.json")]: json({
      $schema: CODEX.schema,
      name: CODEX.plugin,
      version,
      description: CODEX.description,
    }),
    [join("plugin-codex", ".agents", "plugins", "marketplace.json")]: json({
      name: CODEX.marketplace,
      owner: { name: author },
      plugins: [{ name: CODEX.plugin, source: "./" }],
    }),
    [claudePath]: JSON.stringify(claude, null, 2) + "\n",
  };
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function main(argv, io = { out: (m) => process.stdout.write(m + "\n"), err: (m) => process.stderr.write(m + "\n") }, root = ROOT) {
  const check = argv.includes("--check");
  if (argv.some((a) => a !== "--check")) {
    io.err("usage: plugin-manifests.mjs [--check]");
    return 2;
  }
  const files = expected(root);
  const stale = Object.entries(files).filter(([path, text]) => read(join(root, path)) !== text).map(([path]) => path);
  if (check) {
    if (stale.length > 0) {
      for (const path of stale) io.err(`${path} is out of date: run node scripts/plugin-manifests.mjs`);
      return 1;
    }
    io.out(`plugin manifests ok: ${Object.keys(files).length} files, one version`);
    return 0;
  }
  for (const path of stale) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), files[path]);
    io.out(`wrote ${relative(root, join(root, path))}`);
  }
  if (stale.length === 0) io.out("plugin manifests already up to date");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
