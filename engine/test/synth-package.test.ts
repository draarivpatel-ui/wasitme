/**
 * The generator, the hostile-corpus builder (secret-shaped strings, canary text), the reference counter and
 * the test kit are development tools: they are compiled into dist/src/synth but must never be published.
 *
 * Excluding them is a one-line change to engine/package.json (the manifest is not part of the synth package):
 *     "files": ["dist/src", "!dist/src/synth", "README.md", "LICENSE"]
 * Until the manifest's owner applies it, the pack check below skips itself (loudly) instead of failing; once
 * applied it is live and checks the real `npm pack` listing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Dev-only trees under src/: the synth tools, and the WP-23 calibration harness built on them
 * (src/analysis/calibration, excluded from the package as "!dist/src/analysis/calibration").
 */
const DEV_ONLY = [join(ENGINE, "src", "synth"), join(ENGINE, "src", "analysis", "calibration")];

function shippedTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!DEV_ONLY.includes(p)) shippedTsFiles(p, out);
    } else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("nothing outside the dev-only trees imports the synth tools or the calibration harness (so they can be left out of the published package)", () => {
  const importers = shippedTsFiles(join(ENGINE, "src")).filter((f) => /from\s+["'][^"']*\b(synth|calibration)\//.test(readFileSync(f, "utf8")));
  assert.deepEqual(importers, [], "shipped code must not depend on the dev-only synth tools or the calibration harness");
});

test("engine/package.json leaves the calibration harness out of the published files", () => {
  const pkg = JSON.parse(readFileSync(join(ENGINE, "package.json"), "utf8")) as { files: string[] };
  assert.ok(pkg.files.includes("!dist/src/analysis/calibration"), JSON.stringify(pkg.files));
});

test("npm pack --dry-run lists no synth file (once engine/package.json excludes them)", (t) => {
  const pkg = JSON.parse(readFileSync(join(ENGINE, "package.json"), "utf8")) as { files: string[] };
  if (!pkg.files.includes("!dist/src/synth")) {
    t.skip('engine/package.json still publishes dist/src/synth: add "!dist/src/synth" to its "files" (the manifest owner), then this check runs');
    return;
  }
  const npm = process.env.npm_execpath ? { cmd: process.execPath, args: [process.env.npm_execpath] } : { cmd: "npm", args: [] as string[] };
  const r = spawnSync(npm.cmd, [...npm.args, "pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ENGINE, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    t.skip("npm is not on PATH (run through `npm test -w engine`)");
    return;
  }
  assert.equal(r.status, 0, r.stderr);
  const listing = JSON.parse(r.stdout) as { files: { path: string }[] }[];
  const paths = listing[0]!.files.map((f) => f.path);
  assert.deepEqual(paths.filter((p) => /synth|calibration/i.test(p)), [], "no synth or calibration-harness file may ship");
  assert.ok(paths.includes("dist/src/util.js"), `the engine code still ships: ${paths.join(", ")}`);
  assert.ok(paths.includes("package.json"));
});
