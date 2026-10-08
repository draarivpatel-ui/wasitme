#!/usr/bin/env node
// check-mod-allowlist.mjs - the plugin's mod stays inside the frozen capability allow-list (D25, SECURITY.md).
//
// Usage: node scripts/check-mod-allowlist.mjs [dir]        (default: plugin)
// Exit codes: 0 clean (or no such directory: prints SKIPPED), 1 a forbidden call or hook, 2 usage error.
//
// The Claude Code host derives a mod's `calls:` from literal `$.noun.method(...)` and `on("event")` text, so a literal
// search is what the host sees. Forbidden: $.process, $.env, $.http, $.fs.write*, $.fs passed around as a value,
// computed access $[...], $.session.messages, and hooks on "tool.call" or "prompt.submit" (the mod would see every tool
// call and prompt). Comments are masked first: prose such as "`$.fs` does not expand ~" is not a call. (The exact
// check is plugin/tests/check-calls.mjs, which reads the host's own `calls:` line and needs the claude CLI.)
//
// Ported from the grep in ci.yml's "Mod capability allow-list" step; ci.yml and scripts/ci-local.sh both run this.

import { existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lineOfIndex, maskJsComments } from "./lib/source-scan.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(SELF));
const EXTENSIONS = /\.(?:mjs|cjs|js|ts|tsx|mts|cts|jsx)$/;

export const FORBIDDEN = [
  { re: /\$\.process\b/g, what: "$.process (runs programs)" },
  { re: /\$\.env\b/g, what: "$.env (reads the environment)" },
  { re: /\$\.http\b/g, what: "$.http (network)" },
  { re: /\$\.fs\.write/g, what: "$.fs.write* (writes files)" },
  { re: /\$\.fs(?![.\w])/g, what: "$.fs used as a value (escapes the literal-call allow-list)" },
  { re: /\$\[/g, what: "computed $[...] access (cannot be checked)" },
  { re: /\$\.session\.messages/g, what: "$.session.messages (reads the conversation)" },
  { re: /\bon\(\s*["'`]tool\.call["'`]/g, what: 'on("tool.call") (sees every tool call)' },
  { re: /\bon\(\s*["'`]prompt\.submit["'`]/g, what: 'on("prompt.submit") (sees every prompt)' },
];

/** [{line, what}] for one source text. */
export function modFindings(src) {
  const code = maskJsComments(src);
  const out = [];
  for (const f of FORBIDDEN) for (const m of code.matchAll(f.re)) out.push({ line: lineOfIndex(code, m.index), what: f.what });
  return out.sort((a, b) => a.line - b.line);
}

function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (name === "node_modules" || name === ".git") continue;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && EXTENSIONS.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function main(argv, io = { out: (m) => process.stdout.write(m + "\n"), err: (m) => process.stderr.write(m + "\n") }) {
  if (argv.length > 1 || argv.some((a) => a.startsWith("-"))) { io.err("usage: check-mod-allowlist.mjs [dir]"); return argv.includes("-h") || argv.includes("--help") ? 0 : 2; }
  const dir = resolve(argv[0] ?? join(REPO_ROOT, "plugin"));
  if (!existsSync(dir)) { io.out(`check-mod-allowlist: SKIPPED (no ${relative(process.cwd(), dir) || dir} directory yet)`); return 0; }
  let count = 0;
  let scanned = 0;
  for (const f of files(dir)) {
    scanned++;
    for (const x of modFindings(readFileSync(f, "utf8"))) {
      count++;
      io.err(`${relative(process.cwd(), f)}:${x.line}: [mod-allowlist] ${x.what} is outside the frozen mod allow-list (D25)`);
    }
  }
  io.out(`check-mod-allowlist: ${scanned} file(s) scanned, ${count} finding(s)`);
  return count ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) process.exitCode = main(process.argv.slice(2));
