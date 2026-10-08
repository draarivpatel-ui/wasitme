// Shared test helpers for scripts/test/*.test.mjs (not itself a test file).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = dirname(SCRIPTS_DIR);

/** Build a throwaway directory from {relative path: contents}. Returns {root, cleanup}. */
export function makeTree(files = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wasitme-scripts-test-")));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Run `node <script> ...args`, returning {status, stdout, stderr}. */
export function runNode(script, args = [], options = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", ...options });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Run the exported `main(argv, io[, env])` of a script in-process and capture its output. */
export function runMain(main, argv, env) {
  const out = [];
  const err = [];
  const code = main(argv, { out: (m) => out.push(m), err: (m) => err.push(m) }, env);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

export function writeExecutable(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

/** git is needed by some tests; they skip when it is missing. */
export const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
export const git = (cwd, ...args) =>
  spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" });
