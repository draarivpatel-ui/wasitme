/**
 * The CLI (WP-30), end to end in a temp HOME / WASITME_HOME / agent roots: the default report, status, report formats
 * (including the exact call the Mac app makes), exclude, doctor, the status-line commands, trailing --json everywhere,
 * read-only runs, usage errors, and a leak check over the hostile corpus. Synthetic data only; the real ~/.wasitme,
 * ~/.claude and ~/.codex are never read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { lintCopy } from "../../src/contract/check.js";
import { loadExclude } from "../../src/store/exclude.js";
import { tokensBanned } from "../words/helpers.js";
import { main } from "../../src/cli/main.js";
import { ENGINE_VERSION } from "../../src/version.js";
import type { CliContext } from "../../src/cli/context.js";
import { copyCorpus, modes, TESTDATA, tempEnv, treeDigest, type TempEnv } from "../store/helpers.js";
import { outputsOf, readJson, ROOT } from "./cases.js";

const CLI = `${ROOT}engine/dist/src/cli/main.js`;
const SCRIPT = `${ROOT}packaging/statusline.sh`;
const CHECK = `${ROOT}scripts/check-privacy.mjs`;
const CANARIES = readFileSync(`${TESTDATA}/hostile/CANARIES.txt`, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("# ") && l !== "#");

function cliEnv(env: TempEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { HOME: env.home, WASITME_HOME: env.wh, WASITME_CLAUDE_DIR: env.claude, WASITME_CODEX_DIR: env.codex, CLAUDE_CONFIG_DIR: join(env.root, "claude-config"), WASITME_TZ: "UTC", PATH: "/usr/bin:/bin", ...extra };
}
function run(env: TempEnv, args: string[], extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: cliEnv(env, extra), timeout: 120_000 });
}
const iso = (d = new Date()): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Write a fresh results pair for a case from the real pipeline (generatedAt = now). */
function seed(env: TempEnv, name: string, at = iso()): void {
  const out = outputsOf(name);
  mkdirSync(env.wh, { recursive: true, mode: 0o700 });
  writeFileSync(join(env.wh, "snapshot.json"), `${JSON.stringify({ ...out.snapshot, generatedAt: at })}\n`, { mode: 0o600 });
  writeFileSync(join(env.wh, "glance.json"), `${JSON.stringify({ ...out.glance, generatedAt: at })}\n`, { mode: 0o600 });
}

function noPath(env: TempEnv, text: string, what: string): void {
  assert.ok(!text.includes(env.root), `${what}: no temp path`);
  assert.doesNotMatch(text, /\/Users\/|\/private\/|\/var\/folders|\/tmp\//, `${what}: no path`);
}

// ───────────────────────────── the default report ─────────────────────────────

test("wasitme (no arguments) scans on first use and prints each agent; piped output has no escape codes and no paths", () => {
  const env = tempEnv("cli-default");
  try {
    copyCorpus(env, join(TESTDATA, "seed", "tiny-both"));
    assert.ok(!existsSync(env.wh));
    const r = run(env, []);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.ok(existsSync(join(env.wh, "snapshot.json")), "the first run scanned");
    assert.match(r.stdout, /Claude Code {3}checked/);
    assert.match(r.stdout, /Codex {3}checked/);
    // The shipped calibration (2026-10-05) calibrates both agents, so a small corpus reads "Too early to tell" (row 2) for
    // each, not "Timeline only" (row 1; that path is covered by the seeded results below).
    assert.equal((r.stdout.match(/Too early to tell/g) ?? []).length, 2, "one finding per agent");
    assert.doesNotMatch(r.stdout, /Timeline only/);
    assert.doesNotMatch(r.stdout, /are off until wasitme's tests pass/);
    assert.ok(!r.stdout.includes("\x1b"), "a pipe gets no colour");
    noPath(env, r.stdout, "default");
    for (const line of r.stdout.split("\n")) assert.ok([...line].length <= 100);
    // the second run reads the file (no scan): same agents
    const again = run(env, ["--no-scan"]);
    assert.equal(again.status, 0);
    assert.equal(again.stdout.split("\n").filter((l) => l.startsWith("Finding")).length, 2);
  } finally {
    env.cleanup();
  }
});

test("wasitme --no-scan with nothing to read prints the empty-state sentence; --lead and --agent select what is shown", () => {
  const env = tempEnv("cli-empty");
  try {
    // No results file yet: --no-scan knows nothing about the logs, so it says there are no results (not "no logs").
    const empty = run(env, ["--no-scan"]);
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /No results yet\. Run: wasitme scan/);
    assert.doesNotMatch(empty.stdout, /logs found/);
    for (const args of [["--no-scan", "--json"], ["report", "--format", "json", "--no-scan"]]) {
      const j = run(env, args);
      assert.deepEqual([j.status, j.stdout], [1, ""], `${args.join(" ")}: no document to pass through is an error, never \`null\``);
      assert.match(j.stderr, /^wasitme: No results yet\. Run: wasitme scan\n$/);
    }
    // A damaged results file is not "no logs" either.
    mkdirSync(env.wh, { recursive: true, mode: 0o700 });
    writeFileSync(join(env.wh, "snapshot.json"), "{garbage", { mode: 0o600 });
    assert.match(run(env, ["--no-scan"]).stdout, /The results file is damaged\. Run: wasitme scan/);
    seed(env, "you");
    const finding = run(env, ["--no-scan", "--lead", "finding"]);
    assert.equal(finding.status, 0);
    const lines = finding.stdout.split("\n");
    assert.ok(lines.findIndex((l) => l.startsWith("Finding")) < lines.findIndex((l) => l.startsWith("What changed")));
    // `--lead verdict` (the contract's name for the same lead) stays a hidden alias: same output, never in help.
    assert.equal(run(env, ["--no-scan", "--lead", "verdict"]).stdout, finding.stdout);
    assert.doesNotMatch(run(env, ["help"]).stdout, /verdict/);
    assert.match(run(env, ["help"]).stdout, /--lead timeline\|finding/);
    assert.ok(run(env, ["--no-scan"]).stdout.split("\n").findIndex((l) => l.startsWith("What changed")) < run(env, ["--no-scan"]).stdout.split("\n").findIndex((l) => l.startsWith("Finding")));
    const only = run(env, ["--no-scan", "--agent", "claude-code"]);
    assert.equal(only.status, 0);
    // A known agent missing from the results is a state, said in one plain line (the Codex skill shows it as is);
    // only an id wasitme does not know is a usage error.
    for (const args of [["--no-scan", "--agent", "codex"], ["report", "--md", "--no-scan", "--agent", "codex"]]) {
      const missing = run(env, args);
      assert.deepEqual([missing.status, missing.stdout], [1, ""], args.join(" "));
      assert.equal(missing.stderr, "wasitme: No Codex sessions in the results yet, so there is nothing to show for Codex. wasitme looks for Codex logs in $WASITME_CODEX_DIR. Logs somewhere else? Set CODEX_HOME to their folder, or run: wasitme doctor\n", args.join(" "));
      noPath(env, missing.stderr, args.join(" "));
    }
    assert.equal(run(env, ["--no-scan", "--agent", "cursor"]).status, 2);
    // ... and that error names the agents that are there, so the retry needs no guessing
    assert.match(run(env, ["--no-scan", "--agent", "cursor"]).stderr, /^wasitme: --agent is not one of the agents in the results \(claude-code\)\n/);
    assert.equal(run(env, ["--lead", "sideways"]).status, 2);
    assert.match(run(env, ["--lead", "sideways"]).stderr, /--lead must be timeline or finding/);
  } finally {
    env.cleanup();
  }
});

test("wasitme with out-of-date results scans again (and --no-scan says so instead)", () => {
  const env = tempEnv("cli-stale");
  try {
    copyCorpus(env, join(TESTDATA, "seed", "tiny-both"));
    seed(env, "you", "2026-10-04T12:00:00Z");
    const stale = run(env, ["--no-scan"]);
    assert.match(stale.stdout, /out of date · checked Oct 4, 12:00/);
    assert.match(stale.stdout, /Finding {9}─╱─ Out of date/);
    const fresh = run(env, []);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.match(fresh.stdout, /Too early to tell/, "the stale file was replaced by a new scan of the logs");
    assert.doesNotMatch(fresh.stdout, /Out of date/);
  } finally {
    env.cleanup();
  }
});

test("results written by an uncalibrated engine still read as Timeline only: default report, status, doctor (row 1, from seeded results)", () => {
  // The CLI has no calibration switch by design (nothing a user could flip), so the uncalibrated path is covered from
  // results files the real pipeline wrote for an agent the calibration artifact did not pass (cases.ts "timeline-only").
  const env = tempEnv("cli-row1");
  try {
    seed(env, "timeline-only");
    const r = run(env, ["--no-scan"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Finding {9}·┄· Timeline only/);
    assert.match(r.stdout, /Findings for Claude Code are off until wasitme's tests pass\./);
    assert.doesNotMatch(r.stdout, /Too early to tell/);
    noPath(env, r.stdout, "row 1 default");
    assert.match(run(env, ["status"]).stdout, /^wasitme: timeline only\n$/);
    const text = run(env, ["doctor", "--redacted"]).stdout;
    assert.match(text, /agents +claude-code: timeline only \(not calibrated\)\n/);
    assert.match(text, /calibration +no artifact; claude-code not calibrated\n/);
    assert.match(text, /No problems found\./);
  } finally {
    env.cleanup();
  }
});

// ───────────────────────────── status ─────────────────────────────

test("status: one line from the results file, 'out of date' when old, exit 1 with a line when there is nothing", async () => {
  const env = tempEnv("cli-status");
  try {
    // The status line shows short words only (D59), on every stream when piped (the installed status line is piped);
    // a person at a terminal also gets the sentence saying what to do, on stderr.
    const none = run(env, ["status"]);
    assert.equal(none.status, 1);
    assert.equal(none.stdout, "wasitme: no results yet\n");
    assert.equal(none.stderr, "", "piped: no sentence on any stream");
    const tty = fakeContext({ env: { HOME: env.home, WASITME_HOME: env.wh }, stdoutIsTTY: true });
    assert.equal(await main(["status"], tty.ctx), 1);
    assert.deepEqual([tty.out.join(""), tty.err.join("")], ["wasitme: no results yet\n", "wasitme: No results yet. Run: wasitme scan\n"]);
    const noneJson = run(env, ["status", "--json"]);
    assert.equal(noneJson.status, 0, "--json callers always get exit 0");
    assert.deepEqual([JSON.parse(noneJson.stdout).statusLine, JSON.parse(noneJson.stdout).display, JSON.parse(noneJson.stdout).why], [null, "empty", "no_results"]);
    seed(env, "you");
    for (const cmd of [["status"], ["statusline"]]) {
      const r = run(env, cmd);
      assert.deepEqual([r.status, r.stdout], [0, "wasitme: your side\n"], cmd.join(" "));
    }
    const j = JSON.parse(run(env, ["status", "--json"]).stdout);
    assert.deepEqual([j.schema, j.display, j.statusLine, j.state, j.agents], ["wasitme.status/1", "ok", "wasitme: your side", "you", 1]);
    seed(env, "agent", "2026-10-04T12:00:00Z");
    assert.equal(run(env, ["status"]).stdout, "wasitme: out of date\n");
    writeFileSync(join(env.wh, "glance.json"), `${JSON.stringify({ ...outputsOf("you").glance, generatedAt: iso(), schema: "wasitme.glance/9" })}\n`);
    const mismatch = run(env, ["status"]);
    assert.equal(mismatch.status, 1);
    assert.equal(mismatch.stdout, "wasitme: update needed\n");
    const ttyMismatch = fakeContext({ env: { HOME: env.home, WASITME_HOME: env.wh }, stdoutIsTTY: true });
    await main(["status"], ttyMismatch.ctx);
    assert.match(ttyMismatch.err.join(""), /written by a different version of wasitme\. Run: wasitme scan\. If this comes back, parts of wasitme are out of sync: update it so every part is the same version \(wasitme update shows how\)/);
    // The command every "Update needed" surface names exists, downloads nothing, and says how to update.
    const upd = run(env, ["update"]);
    assert.equal(upd.status, 0);
    assert.ok(upd.stdout.startsWith(`wasitme ${ENGINE_VERSION} is installed.\nwasitme has no network code, so it never downloads an update itself. To update, run the installer of the newer`), upd.stdout);
    assert.deepEqual(JSON.parse(run(env, ["update", "--json"]).stdout), { schema: "wasitme.update/1", version: ENGINE_VERSION, downloads: false });
    // A failed last scan: the line keeps the last state; --json says the scan failed.
    writeFileSync(join(env.wh, "glance.json"), `${JSON.stringify({ ...outputsOf("you").glance, generatedAt: iso(), scanOk: false, scanError: "internal" })}\n`);
    const failed = JSON.parse(run(env, ["status", "--json"]).stdout);
    assert.deepEqual([failed.statusLine, failed.scanOk, failed.scanError], ["wasitme: your side", false, "internal"]);
  } finally {
    env.cleanup();
  }
});

// ───────────────────────────── report ─────────────────────────────

test("report: Markdown by default; --md --agent --json is the Mac app's exact call and returns {markdown}", () => {
  const env = tempEnv("cli-report");
  try {
    seed(env, "you");
    const md = run(env, ["report", "--md", "--no-scan"]);
    assert.equal(md.status, 0, md.stderr);
    assert.match(md.stdout, /^### wasitme report: your side changed \(Claude Code\)\n/);
    assert.deepEqual(run(env, ["report", "--no-scan"]).stdout, md.stdout, "markdown is the default");
    // EngineReportSource: node <cli> report --md --agent <id> --json (the runner appends --json), no --no-scan
    const app = run(env, ["report", "--md", "--agent", "claude-code", "--json"]);
    assert.equal(app.status, 0, app.stderr);
    const env2 = JSON.parse(app.stdout);
    assert.equal(typeof env2.markdown, "string");
    assert.ok(env2.markdown.length > 500);
    assert.equal(env2.markdown, md.stdout, "the envelope carries the same Markdown");
    assert.deepEqual([env2.schema, env2.format], ["wasitme.report/1", "md"]);
    // the app's argument allow-list: [A-Za-z0-9._:=,/@+-] only, at most 16 arguments, each ≤ 256 characters
    for (const a of ["report", "--md", "--agent", "claude-code", "--json"]) assert.match(a, /^[A-Za-z0-9._:=,/@+-]{1,256}$/);
    // html, json
    const html = run(env, ["report", "--html", "--no-scan"]);
    assert.match(html.stdout, /^<!doctype html>/);
    assert.match(JSON.parse(run(env, ["report", "--html", "--json", "--no-scan"]).stdout).html, /^<!doctype html>/);
    const raw = JSON.parse(run(env, ["report", "--format", "json", "--no-scan"]).stdout);
    assert.equal(raw.schema, "wasitme.snapshot/1");
    assert.deepEqual(JSON.parse(run(env, ["report", "--json", "--no-scan"]).stdout), raw, "--json alone is the snapshot");
    // errors
    assert.equal(run(env, ["report", "--md", "--html"]).status, 2);
    assert.equal(run(env, ["report", "--format", "pdf"]).status, 2);
    const nobody = run(env, ["report", "--md", "--agent", "nobody", "--json", "--no-scan"]);
    assert.equal(nobody.status, 2);
    assert.equal(nobody.stdout, "");
  } finally {
    env.cleanup();
  }
});

test("report: nothing to report is an error with a plain sentence, not an empty report", () => {
  const env = tempEnv("cli-report-empty");
  try {
    const r = run(env, ["report", "--no-scan"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /there is nothing to report\. No results yet\. Run: wasitme scan/);
    assert.equal(r.stdout, "");
    // After a scan that found no logs, the sentence says that, where it looked (by variable name, never a path) and
    // what to set; `status` gives the short form and the same sentence on stderr instead of "run: wasitme scan".
    assert.equal(run(env, ["scan"]).status, 0);
    const none = run(env, ["report", "--no-scan"]);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /No Claude Code or Codex logs found in \$WASITME_CLAUDE_DIR or \$WASITME_CODEX_DIR\. Logs somewhere else\? Set CLAUDE_CONFIG_DIR or CODEX_HOME to their folder, or run: wasitme doctor/);
    noPath(env, none.stderr, "no-logs sentence");
    const st = run(env, ["status"]);
    assert.deepEqual([st.status, st.stdout], [1, "wasitme: no logs found\n"]);
    assert.equal(st.stderr, "", "piped (as the status line runs it): the short words only");
    const agent = run(env, ["--agent", "codex", "--no-scan"]);
    assert.equal(agent.status, 1);
    assert.match(agent.stderr, /no results to select an agent from\. No Claude Code or Codex logs found/);
    assert.doesNotMatch(agent.stderr, /run wasitme scan/);
  } finally {
    env.cleanup();
  }
});

test("report --read-only and --until analyse in memory and write nothing at all", () => {
  const env = tempEnv("cli-readonly");
  try {
    copyCorpus(env, join(TESTDATA, "seed", "tiny-both"));
    mkdirSync(env.wh, { recursive: true });
    const before = treeDigest(env.wh);
    const agentsBefore = [treeDigest(env.claude), treeDigest(env.codex)];
    for (const args of [["report", "--md", "--read-only"], ["--read-only"], ["report", "--md", "--until", "2026-07-05T23:59"], ["--until", "2026-07-05T23:59", "--tz", "UTC"]]) {
      const r = run(env, args);
      assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
      assert.ok(r.stdout.length > 300);
    }
    assert.deepEqual(treeDigest(env.wh), before, "the wasitme home is unchanged");
    assert.deepEqual([treeDigest(env.claude), treeDigest(env.codex)], agentsBefore, "the agents' logs are untouched");
    assert.equal(run(env, ["--until", "yesterday"]).status, 2);
  } finally {
    env.cleanup();
  }
});

// ───────────────────────────── --json everywhere ─────────────────────────────

test("every command accepts the trailing --json the Mac app's runner appends", () => {
  const env = tempEnv("cli-json");
  try {
    copyCorpus(env, join(TESTDATA, "seed", "tiny-both"));
    assert.equal(run(env, ["scan", "--json"]).status, 0);
    for (const args of [["status", "--json"], ["statusline", "--json"], ["doctor", "--json"], ["exclude", "list", "--json"], ["demo", "--json"], ["report", "--md", "--json"], ["report", "--json"], ["--json"], ["--no-scan", "--json"]]) {
      const r = run(env, args);
      assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
      assert.doesNotThrow(() => JSON.parse(r.stdout), `${args.join(" ")} prints JSON`);
    }
    assert.equal(run(env, ["hook", "session-start", "--cwd", env.home, "--json"]).status, 0, "a hook never fails");
  } finally {
    env.cleanup();
  }
});

// ───────────────────────────── exclude ─────────────────────────────

test("exclude: dates, entry points and project folders, listed and removed; stored 0600; matched by id, never by name", () => {
  const env = tempEnv("cli-exclude");
  try {
    copyCorpus(env, join(TESTDATA, "seed", "tiny-both"));
    const proj = join(env.home, "code", "my-secret-client-project");
    mkdirSync(proj, { recursive: true });
    // before any scan there is no local id key
    const early = run(env, ["exclude", "add", proj]);
    assert.equal(early.status, 1);
    assert.match(early.stderr, /Run wasitme scan first/);
    assert.equal(run(env, ["exclude", "list"]).stdout, "Nothing is excluded.\n");
    assert.equal(run(env, ["scan"]).status, 0);

    assert.match(run(env, ["exclude", "add", "--dates", "2026-07-02..2026-07-03"]).stdout, /^Added\. Takes effect at the next scan/);
    assert.match(run(env, ["exclude", "add", "--dates", "2026-07-02..2026-07-03"]).stdout, /^Already excluded\./);
    assert.match(run(env, ["exclude", "add", "--entrypoint", "sdk-*"]).stdout, /^Added\./);
    assert.match(run(env, ["exclude", "add", proj]).stdout, /^Added\./);
    const list = run(env, ["exclude", "list"]).stdout;
    assert.match(list, /dates +2026-07-02 to 2026-07-03/);
    assert.match(list, /projects +1 folder \(ids only; folder names are never stored\)/, "folders are counted, not the 2–6 ids each one is stored as");
    // Two more folders, one of them not there (a deleted project, or a typo): added, with a note that names no path.
    const other = join(env.home, "code", "other");
    mkdirSync(other, { recursive: true });
    assert.equal(run(env, ["exclude", "add", other]).stderr, "");
    const gone = run(env, ["exclude", "add", join(env.home, "code", "since-deleted")]);
    assert.match(gone.stdout, /^Added\./);
    assert.match(gone.stderr, /there is no folder at that path now\. If it was a project folder you have since removed, its recorded sessions are excluded; otherwise check the path/);
    noPath(env, gone.stderr, "exclude note");
    assert.match(run(env, ["exclude", "list"]).stdout, /projects +3 folders \(/);
    assert.equal(JSON.parse(run(env, ["exclude", "list", "--json"]).stdout).folders, 3);
    assert.match(run(env, ["exclude", "remove", other]).stdout, /^Removed\./);
    assert.match(run(env, ["exclude", "remove", join(env.home, "code", "since-deleted")]).stdout, /^Removed\./);
    assert.match(run(env, ["exclude", "list"]).stdout, /projects +1 folder \(/);
    assert.match(list, /entrypoints +sdk-\*/);
    assert.ok(!list.includes("my-secret-client-project"));
    const file = join(env.wh, "state", "exclude.json");
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes("my-secret-client-project") && !text.includes(env.root), "no name and no path in the file");
    const parsed = loadExclude(file);
    assert.equal(parsed.error, null);
    assert.deepEqual([parsed.dates.length, parsed.entrypoints, parsed.projects.size > 0], [1, ["sdk-*"], true]);
    // JSON form
    const j = JSON.parse(run(env, ["exclude", "list", "--json"]).stdout);
    assert.deepEqual([j.dates, j.entrypoints], [[{ from: "2026-07-02", to: "2026-07-03" }], ["sdk-*"]]);
    // remove
    assert.match(run(env, ["exclude", "remove", proj]).stdout, /^Removed\./);
    assert.match(run(env, ["exclude", "remove", proj]).stdout, /^Nothing to remove\./);
    assert.match(run(env, ["exclude", "remove", "--dates", "2026-07-02..2026-07-03"]).stdout, /^Removed\./);
    assert.match(run(env, ["exclude", "remove", "--all"]).stdout, /^Removed\./);
    assert.equal(run(env, ["exclude", "list"]).stdout, "Nothing is excluded.\n");
    // usage errors
    for (const args of [["exclude"], ["exclude", "frob"], ["exclude", "add"], ["exclude", "add", "--dates", "soon"], ["exclude", "add", "--dates", "2026-02-30"], ["exclude", "add", "--entrypoint", "bad name!"], ["exclude", "add", proj, "--dates", "2026-07-01"], ["exclude", "list", "extra"]]) {
      assert.equal(run(env, args).status, 2, args.join(" "));
    }
    // a damaged exclude list is never overwritten
    writeFileSync(file, "{not json");
    const blocked = run(env, ["exclude", "add", "--dates", "2026-07-01"]);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /malformed; wasitme will not change it/);
    assert.equal(readFileSync(file, "utf8"), "{not json");
  } finally {
    env.cleanup();
  }
});

// ───────────────────────────── doctor ─────────────────────────────

test("doctor: counts, versions and enums only; the redacted form is safe to paste", () => {
  const env = tempEnv("cli-doctor");
  try {
    copyCorpus(env, join(TESTDATA, "seed", "tiny-both"));
    assert.equal(run(env, ["scan"]).status, 0);
    for (const args of [["doctor"], ["doctor", "--redacted"], ["doctor", "--redacted", "--toolchain"]]) {
      const r = run(env, args);
      assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
      noPath(env, r.stdout, args.join(" "));
      assert.match(r.stdout, new RegExp(`engine +${ENGINE_VERSION.replace(/\./g, "\\.")}, node v\\d+`));
      assert.ok(!r.stdout.includes("\x1b"));
    }
    const text = run(env, ["doctor", "--redacted"]).stdout;
    assert.match(text, /^wasitme doctor \(counts, versions and names only; safe to paste into an issue\)/);
    assert.match(text, /results +snapshot ok, \d+ min old|results +snapshot ok, 0 min old/);
    assert.match(text, /source claude-code +found in \$WASITME_CLAUDE_DIR, \d+ files?, \d+ unreadable lines?, /);
    assert.match(text, /source codex +found in \$WASITME_CODEX_DIR/);
    assert.match(text, /agents +claude-code: too early to tell · codex: too early to tell\n/);
    assert.match(text, /calibration +2026-10-05; claude-code calibrated, codex calibrated\n/);
    assert.doesNotMatch(text, /not calibrated/);
    // doctor prints the artifact date and each agent's flag; the estimator is in the results file it reads.
    assert.equal(readJson(join(env.wh, "snapshot.json")).calibration.methodId, "session-t95-cr2");
    assert.match(text, /exclusions +0 date ranges, 0 projects, 0 entry points/);
    assert.match(text, /scan lock +free/);
    assert.match(text, /No problems found\./);
    const jr = run(env, ["doctor", "--json"]);
    noPath(env, jr.stdout, "doctor --json");
    const j = JSON.parse(jr.stdout);
    assert.equal(j.schema, "wasitme.doctor/1");
    assert.ok(j.lines.every((l: { key: string; text: string }) => typeof l.key === "string" && typeof l.text === "string"));
    if (process.platform === "darwin") {
      const tc = run(env, ["doctor", "--toolchain", "--redacted"]).stdout;
      assert.match(tc, /toolchain +(no developer tools|Xcode|Command Line Tools)/);
      assert.ok(!tc.includes("/Library/") && !tc.includes(".app/"), "the developer folder's path is not printed when redacted");
    }
  } finally {
    env.cleanup();
  }
});

test("doctor on a hostile corpus never prints record-type names, canaries or paths (unknown types are counted, not named)", () => {
  const env = tempEnv("cli-doctor-hostile");
  try {
    copyCorpus(env, join(TESTDATA, "hostile"));
    assert.equal(run(env, ["scan"]).status, 0);
    const out = run(env, ["doctor"]).stdout + run(env, ["doctor", "--redacted"]).stdout + run(env, ["doctor", "--json"]).stdout;
    assert.match(out, /unrecognised record types? \(\d+ records?\)/);
    const check = spawnSync(process.execPath, [CHECK, "--require-canaries", "-"], { input: out, encoding: "utf8" });
    assert.equal(check.status, 0, check.stdout);
    noPath(env, out, "doctor (hostile)");
  } finally {
    env.cleanup();
  }
});

test("doctor reports problems in plain words; --repair fixes permissions, leftovers and a dead lock, then scans", () => {
  const env = tempEnv("cli-repair");
  try {
    copyCorpus(env, join(TESTDATA, "seed", "tiny-both"));
    assert.equal(run(env, ["scan"]).status, 0);
    chmodSync(env.wh, 0o755);
    chmodSync(join(env.wh, "salt"), 0o644);
    chmodSync(join(env.wh, "history"), 0o755);
    writeFileSync(join(env.wh, "glance.json.1234.deadbeef.tmp"), "x");
    const old = new Date(Date.now() - 4 * 3600_000);
    utimesSync(join(env.wh, "glance.json.1234.deadbeef.tmp"), old, old);
    writeFileSync(join(env.wh, "state", "scan.lock"), `${JSON.stringify({ pid: 2_000_000_000, token: "dead", uptime: 1 })}\n`, { mode: 0o600 });
    const sick = run(env, ["doctor"]).stdout;
    assert.match(sick, /The wasitme folder is readable by others\. Run: wasitme doctor --repair/);
    assert.match(sick, /The salt file is readable by others\./);
    assert.match(sick, /scan lock +left behind by a scan that is gone/);
    const fixed = run(env, ["doctor", "--repair"]).stdout;
    assert.match(fixed, /Repaired:/);
    assert.match(fixed, /tightened \d+ permissions? to owner-only/);
    assert.match(fixed, /removed 1 leftover temporary file/);
    assert.match(fixed, /ran a scan/);
    assert.match(fixed, /LaunchAgent plists and command shims are the installer's job and were not touched\./);
    assert.match(fixed, /No problems found\./);
    assert.ok(!existsSync(join(env.wh, "glance.json.1234.deadbeef.tmp")));
    for (const [rel, mode] of modes(env.wh)) {
      const isDir = lstatSync(join(env.wh, rel)).isDirectory();
      assert.equal(mode & 0o077, 0, `${rel} is owner-only (${mode.toString(8)})`);
      assert.ok(!isDir || mode === 0o700 || rel === ".", rel);
    }
  } finally {
    env.cleanup();
  }
});

test("doctor names every way a scan can be stuck, exits 1 when it lists problems (0 under --json), and --repair leaves the installed versions read-only", () => {
  const env = tempEnv("cli-doctor-states");
  try {
    copyCorpus(env, join(TESTDATA, "seed", "tiny-both"));
    assert.equal(run(env, ["scan"]).status, 0);
    const ok = run(env, ["doctor"]);
    assert.deepEqual([ok.status, /No problems found\./.test(ok.stdout)], [0, true], ok.stdout);

    // 1. A salt lost while history exists: every scan fails; both documents carry the failure; doctor says why and how out.
    const salt = readFileSync(join(env.wh, "salt"));
    rmSync(join(env.wh, "salt"));
    const failed = run(env, ["scan"]);
    assert.deepEqual([failed.status, failed.stderr], [1, "wasitme: scan failed (internal).\n"]);
    for (const f of ["glance.json", "snapshot.json"]) assert.deepEqual([readJson(join(env.wh, f)).scanOk, readJson(join(env.wh, f)).scanError], [false, "internal"], f);
    const sick = run(env, ["doctor"]);
    assert.equal(sick.status, 1, "problems listed: exit 1");
    assert.match(sick.stdout, /results +snapshot ok, \d+ min old, last scan failed \(internal\)/);
    assert.match(sick.stdout, /The salt file is missing or damaged, but stored history needs it, so every scan fails\. Restore the salt file .* from a backup; or, to start over, move the wasitme folder's history folder aside/);
    assert.match(sick.stdout, /The last scan failed \(internal\)\. The salt problem above is why\./);
    assert.equal(run(env, ["doctor", "--json"]).status, 0, "--json: always 0 (the Mac app's runner)");
    assert.ok(JSON.parse(run(env, ["doctor", "--json"]).stdout).problems.length >= 2);
    assert.match(run(env, ["--no-scan"]).stdout, /Last scan failed \(internal\); showing the last good result\. Run wasitme doctor to see why\./);
    writeFileSync(join(env.wh, "salt"), salt, { mode: 0o600 });
    assert.equal(run(env, ["scan"]).status, 0);
    assert.equal(readJson(join(env.wh, "snapshot.json")).scanOk, true, "the next good scan clears the flag");

    // 2. A scan lock no scan can take over (a folder): every scan skips; doctor names it; --repair removes it and scans.
    mkdirSync(join(env.wh, "state", "scan.lock"));
    assert.equal(run(env, ["scan"]).stdout, "wasitme: another scan is running; skipped.\n");
    const blocked = run(env, ["doctor"]);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /scan lock +blocked: a folder/);
    assert.match(blocked.stdout, /The scan lock is a folder, which no scan can take over, so every scan is skipped\. Run: wasitme doctor --repair/);
    // The installed versions are read-only on purpose (D46); --repair must not make them writable.
    const ver = join(env.wh, "versions", "0.1.0");
    mkdirSync(join(ver, "scripts"), { recursive: true });
    writeFileSync(join(ver, "scripts", "uninstall.sh"), "#!/bin/sh\n");
    chmodSync(join(ver, "scripts", "uninstall.sh"), 0o444);
    chmodSync(join(ver, "scripts"), 0o555);
    chmodSync(ver, 0o555);
    const repaired = run(env, ["doctor", "--repair"]);
    assert.equal(repaired.status, 0, repaired.stdout);
    assert.match(repaired.stdout, /removed a scan lock that blocked every scan \(it was a folder\)/);
    assert.match(repaired.stdout, /ran a scan/);
    assert.ok(!existsSync(join(env.wh, "state", "scan.lock")));
    assert.match(run(env, ["scan"]).stdout, /^wasitme: scanned /);
    assert.deepEqual([lstatSync(ver).mode & 0o777, lstatSync(join(ver, "scripts")).mode & 0o777, lstatSync(join(ver, "scripts", "uninstall.sh")).mode & 0o777], [0o555, 0o555, 0o444]);
    chmodSync(join(ver, "scripts"), 0o755);
    chmodSync(ver, 0o755);

    // 3. An oversized lock file and an unreadable one block the same way.
    for (const [what, make] of [["too large to be a lock", () => writeFileSync(join(env.wh, "state", "scan.lock"), "x".repeat(5000), { mode: 0o600 })],
      ["not readable", () => { writeFileSync(join(env.wh, "state", "scan.lock"), '{"pid":1,"token":"t","uptime":1}\n', { mode: 0o600 }); chmodSync(join(env.wh, "state", "scan.lock"), 0); }]] as const) {
      make();
      assert.match(run(env, ["doctor"]).stdout, new RegExp(`scan lock +blocked: ${what}`));
      assert.match(run(env, ["doctor", "--repair"]).stdout, new RegExp(`removed a scan lock that blocked every scan \\(it was ${what}\\)`));
      assert.ok(!existsSync(join(env.wh, "state", "scan.lock")), what);
    }
  } finally {
    env.cleanup();
  }
});

test("no logs, or logs that cannot be read: doctor names where it looked (never a path) and counts it as a problem", () => {
  const env = tempEnv("cli-doctor-nologs");
  try {
    mkdirSync(env.claude, { recursive: true });
    mkdirSync(env.codex, { recursive: true });
    assert.match(run(env, ["scan"]).stdout, /^wasitme: scanned 0 sources/);
    const snap = readJson(join(env.wh, "snapshot.json"));
    assert.deepEqual(snap.agents, [], "no agent to analyse: the documents stay empty");
    assert.deepEqual(snap.health.sources.map((s: { agent: string; found: boolean; error: string }) => [s.agent, s.found, s.error]), [["claude-code", false, "not_found"], ["codex", false, "not_found"]]);
    const d = run(env, ["doctor"]);
    assert.equal(d.status, 1);
    assert.match(d.stdout, /source claude-code +no logs found in \$WASITME_CLAUDE_DIR/);
    assert.match(d.stdout, /No Claude Code or Codex logs were found in \$WASITME_CLAUDE_DIR or \$WASITME_CODEX_DIR\. If your logs are somewhere else, set CLAUDE_CONFIG_DIR \(Claude Code\) or CODEX_HOME \(Codex\)/);
    noPath(env, d.stdout, "doctor, no logs");
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      // A log folder that exists but cannot be listed is "not readable", never "no logs".
      mkdirSync(join(env.claude, "projects"));
      chmodSync(env.claude, 0);
      try {
        assert.equal(run(env, ["scan"]).status, 0);
        assert.equal(readJson(join(env.wh, "snapshot.json")).health.sources[0].error, "permission_denied");
        const u = run(env, ["doctor"]);
        assert.match(u.stdout, /source claude-code +not readable \(permission_denied\) in \$WASITME_CLAUDE_DIR/);
        assert.match(u.stdout, /Claude Code logs in \$WASITME_CLAUDE_DIR could not be read \(permission denied\)\. Check that folder's permissions\./);
        assert.match(run(env, ["--no-scan"]).stdout, /wasitme could not read Claude Code logs in \$WASITME_CLAUDE_DIR \(permission denied\)\. Run: wasitme\s+doctor/);
        assert.equal(run(env, ["status"]).stdout, "wasitme: logs not readable\n");
      } finally {
        chmodSync(env.claude, 0o700);
      }
    }
  } finally {
    env.cleanup();
  }
});

test("--version prints the version the installer's self-check looks for; usage errors name a plain argument once", () => {
  const env = tempEnv("cli-version");
  try {
    for (const args of [["--version"], ["-V"], ["-v"], ["version"]]) {
      const r = run(env, args);
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, `wasitme ${ENGINE_VERSION}\n`, ""], args.join(" "));
    }
    assert.deepEqual(JSON.parse(run(env, ["--version", "--json"]).stdout), { schema: "wasitme.version/1", version: ENGINE_VERSION });
    assert.match(run(env, ["help"]).stdout, /wasitme --version/);
    const extra = run(env, ["status", "extra"]);
    assert.equal(extra.status, 2);
    assert.match(extra.stderr, /^wasitme: unexpected argument "extra"\n/);
    const path = run(env, ["status", join(env.home, "secret")]);
    assert.match(path.stderr, /^wasitme: unexpected argument\n/, "an argument that could be a path is not echoed");
    const sub = run(env, ["statusline", "frob"]);
    assert.equal(sub.stderr.match(/usage:/g)?.length, 1, "the usage is printed once");
  } finally {
    env.cleanup();
  }
});

// ───────────────────────────── the status line, through the CLI ─────────────────────────────

test("statusline install / show / uninstall edit one key of a temp settings file and restore it exactly", () => {
  const env = tempEnv("cli-sl");
  try {
    const claude = join(env.root, "claude-config");
    mkdirSync(claude);
    const settings = join(claude, "settings.json");
    const original = `${JSON.stringify({ model: "opus", statusLine: { type: "command", command: "echo mine", padding: 0 } }, null, 2)}\n`;
    writeFileSync(settings, original);
    assert.equal(run(env, ["statusline", "show", "--script", SCRIPT]).stdout, "Status line: other\n");
    const missing = run(env, ["statusline", "install", "--wrap", "--script", join(env.root, "nope.sh")]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /status-line script was not found/);
    assert.match(missing.stderr, /run the installer, or pass --script/, "says where the script comes from, not only which flag to pass");
    assert.equal(readFileSync(settings, "utf8"), original);
    // Yours is never changed unless you ask (README, and the installer refuses the same way).
    const refused = run(env, ["statusline", "install", "--script", SCRIPT]);
    assert.deepEqual([refused.status, refused.stdout], [1, ""]);
    assert.match(refused.stderr, /you already have a Claude Code status line, so wasitme left it alone\. To show wasitme's next to yours, run: wasitme statusline install --wrap/);
    assert.equal(readFileSync(settings, "utf8"), original, "refused: byte for byte");
    assert.equal(run(env, ["statusline", "uninstall", "--wrap", "--script", SCRIPT]).status, 2, "--wrap belongs to install only");
    const inst = run(env, ["statusline", "install", "--wrap", "--script", SCRIPT]);
    assert.equal(inst.status, 0, inst.stderr);
    assert.equal(inst.stdout, "Status line: installed. Your previous status line is kept and wrapped.\n");
    assert.equal(run(env, ["statusline", "show", "--script", SCRIPT]).stdout, "Status line: wasitme\n");
    assert.equal(run(env, ["statusline", "install", "--script", SCRIPT]).stdout, "Status line: already installed.\n");
    // and it works: the wrapped command's output, then the segment (a fresh results file)
    seed(env, "none");
    const sh = spawnSync("/bin/sh", [SCRIPT], { env: { HOME: env.home, WASITME_HOME: env.wh, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    assert.equal(sh.stdout, "mine · wasitme: no detectable change\n");
    const un = run(env, ["statusline", "uninstall", "--script", SCRIPT]);
    assert.equal(un.stdout, "Status line: restored to what it was before wasitme.\n");
    assert.equal(readFileSync(settings, "utf8"), original, "byte for byte");
    assert.equal(run(env, ["statusline", "uninstall", "--script", SCRIPT]).stdout, "Status line: left alone (it is not wasitme's any more).\n");
    assert.equal(run(env, ["statusline", "bogus"]).status, 2);
    assert.equal(run(env, ["statusline", "install", "--script", "relative.sh"]).status, 2);
  } finally {
    env.cleanup();
  }
});

// ───────────────────────────── usage and in-process terminal modes ─────────────────────────────

test("usage: help, unknown commands and options exit 2 with the usage text, never a stack trace", () => {
  const env = tempEnv("cli-usage");
  try {
    const help = run(env, ["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /wasitme doctor \[--redacted\] \[--toolchain\] \[--repair\]/);
    // `--help` / `-h` after a command is what a new user tries first: the usage on stdout, exit 0, not "unknown option".
    for (const args of [["report", "--help"], ["report", "--md", "-h"], ["doctor", "--help"], ["status", "--help"], ["exclude", "add", "--help"], ["statusline", "install", "-h"], ["scan", "--help"], ["--no-scan", "--help"], ["update", "--help"], ["demo", "-h"]]) {
      const r = run(env, args);
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, help.stdout, ""], args.join(" "));
    }
    assert.ok(!existsSync(env.wh), "asking for help scans and writes nothing");
    // after `--`, "--help" is an argument (a folder could be named that), not a request for help
    assert.equal(run(env, ["status", "--", "--help"]).status, 2);
    // the hook prints nothing, whatever it is given
    assert.deepEqual([run(env, ["hook", "session-start", "--help"]).status, run(env, ["hook", "session-start", "--help"]).stdout], [0, ""]);
    // an unknown command is named when it is a plain word (a typo is easy to spot), never when it could be a path
    assert.match(run(env, ["repot"]).stderr, /^wasitme: unknown command "repot"\n/);
    assert.match(run(env, [join(env.home, "x")]).stderr, /^wasitme: unknown command\n/);
    for (const args of [["frobnicate"], ["report", "--bogus"], ["demo", "--lead"], ["doctor", "--nope"], ["status", "extra"], ["compare"], ["scan", "--until", "soon"], ["scan", "--tz", "Mars/Olympus"]]) {
      const r = run(env, args);
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, /^wasitme: /);
      assert.doesNotMatch(r.stderr, /\n\s+at |Error:|\/Users\//);
    }
  } finally {
    env.cleanup();
  }
});

function fakeContext(over: Partial<CliContext> & { env?: Record<string, string> } = {}): { ctx: CliContext; out: string[]; err: string[] } {
  const out: string[] = [], err: string[] = [];
  const ctx: CliContext = {
    env: {}, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, stdoutIsTTY: true, columns: 100, platform: "darwin", now: () => new Date("2026-10-04T14:24:00Z"),
    ...over,
  };
  return { ctx, out, err };
}

test("colour follows the terminal: NO_COLOR, TERM=dumb and a pipe print no escape codes; a 256-colour terminal gets stickers; WASITME_ASCII=1 prints ASCII", async () => {
  const cases: [Record<string, string>, boolean, RegExp | null][] = [
    [{ TERM: "xterm-256color" }, true, /\x1b\[38;5;16;48;5;(221|117)m /],
    [{ TERM: "xterm-256color", NO_COLOR: "1" }, true, null],
    [{ TERM: "dumb" }, true, null],
    [{ TERM: "xterm-256color" }, false, null],
    [{ TERM: "screen" }, true, /\x1b\[7m /],
    [{ TERM: "xterm", COLORTERM: "truecolor" }, true, /\x1b\[38;2;27;28;33;48;2;/],
  ];
  for (const [env, tty, want] of cases) {
    const { ctx, out } = fakeContext({ env, stdoutIsTTY: tty });
    assert.equal(await main(["demo", "--case", "unclear"], ctx), 0);
    const text = out.join("");
    if (want === null) assert.ok(!text.includes("\x1b"), JSON.stringify(env));
    else assert.match(text, want, JSON.stringify(env));
  }
  const ascii = fakeContext({ env: { WASITME_ASCII: "1" }, stdoutIsTTY: false });
  await main(["demo", "--case", "you"], ascii.ctx);
  assert.match(ascii.out.join(""), /^[\x0a\x20-\x7e]*$/);
  const linux = fakeContext({ env: { TERM: "linux" }, stdoutIsTTY: true });
  await main(["demo", "--case", "you"], linux.ctx);
  assert.match(stripAnsi(linux.out.join("")), /Finding +Your side/, "ASCII: the sticker alone names the side (no \"[you]\" glyph before it)");
  assert.doesNotMatch(stripAnsi(linux.out.join("")), /\[you\]/);
  assert.match(stripAnsi(linux.out.join("")), /Claude Code 2\.1\.266 -> 2\.1\.270/, "ASCII: the arrow is \"->\", never \">\" (greater-than)");
  // the width follows the terminal, down to a floor
  const narrow = fakeContext({ env: {}, stdoutIsTTY: true, columns: 70 });
  await main(["demo"], narrow.ctx);
  for (const line of stripAnsi(narrow.out.join("")).split("\n")) assert.ok([...line].length <= 70, line);
});

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// ───────────────────────────── leaks ─────────────────────────────

test("no canary from the hostile corpus reaches any command's stdout or stderr, and no output holds a path", () => {
  const env = tempEnv("cli-leak");
  try {
    copyCorpus(env, join(TESTDATA, "hostile"));
    // canaries in the config the collectors read, and in a project the exclude command is pointed at
    writeFileSync(join(env.claude, "CLAUDE.md"), `# rules\n${CANARIES[0]}\n`);
    writeFileSync(join(env.claude, "settings.json"), JSON.stringify({ model: CANARIES[1], env: { SECRET: CANARIES[2] }, statusLine: { type: "command", command: CANARIES[3] } }));
    const proj = join(env.home, "code", String(CANARIES[4]).replace(/[^A-Za-z0-9._-]/g, "-"));
    mkdirSync(proj, { recursive: true });
    const seen: string[] = [];
    const go = (args: string[], extra: Record<string, string> = {}): void => {
      const r = run(env, args, extra);
      seen.push(`#${seen.length} exit ${String(r.status)}\n${r.stdout}\n${r.stderr}`);
    };
    go(["scan"]);
    go([]);
    go(["--lead", "verdict"]);
    go(["--no-scan"]);
    go(["--read-only"]);
    go(["status"]);
    go(["statusline"]);
    go(["report"]);
    go(["report", "--md", "--json"]);
    go(["report", "--html"]);
    go(["report", "--format", "json"]);
    go(["doctor"]);
    go(["doctor", "--redacted", "--toolchain"]);
    go(["exclude", "add", proj]);
    go(["exclude", "list"]);
    go(["exclude", "remove", proj]);
    go(["demo"]);
    go(["statusline", "show"]);
    go(["definitely-not-a-command"]);
    go(["report", "--agent", String(CANARIES[5])]);
    const all = seen.join("\n=====\n");
    const check = spawnSync(process.execPath, [CHECK, "--require-canaries", "-"], { input: all, encoding: "utf8" });
    assert.equal(check.status, 0, check.stdout);
    assert.match(check.stdout, /0 hits/);
    noPath(env, all, "all commands");
    // a status-line run over the same home prints a plain label
    const sh = spawnSync("/bin/sh", [SCRIPT], { env: { HOME: env.home, WASITME_HOME: env.wh, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    assert.match(sh.stdout, /^(wasitme: [a-z' +0-9:-]+\n)?$/);
    const check2 = spawnSync(process.execPath, [CHECK, "--require-canaries", "-"], { input: sh.stdout, encoding: "utf8" });
    assert.equal(check2.status, 0);
  } finally {
    env.cleanup();
  }
});

test("the engine's own sample of a hostile scan: every format of the snapshot is escape-free and bounded", () => {
  const env = tempEnv("cli-hostile-formats");
  try {
    copyCorpus(env, join(TESTDATA, "hostile"));
    assert.equal(run(env, ["scan"]).status, 0);
    const snap = readJson(join(env.wh, "snapshot.json"));
    assert.equal(snap.privacy.containsText, false);
    for (const args of [[], ["report"], ["report", "--html"]]) {
      const r = run(env, [...args, "--no-scan"]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(r.stdout), `${args.join(" ") || "default"}: no control or bidi character`);
    }
  } finally {
    env.cleanup();
  }
});

test("the words every other command prints (doctor, status, exclude, status line, usage, errors) pass the copy lints", () => {
  const env = tempEnv("cli-chrome");
  try {
    copyCorpus(env, join(TESTDATA, "seed", "tiny-both"));
    mkdirSync(join(env.root, "claude-config"));
    const proj = join(env.home, "p");
    mkdirSync(proj);
    const outputs: string[] = [];
    for (const args of [["scan"], ["doctor"], ["doctor", "--redacted", "--toolchain"], ["status"], ["exclude", "list"], ["exclude", "add", "--dates", "2026-07-02"], ["exclude", "add", proj], ["exclude", "list"], ["exclude", "remove", "--all"],
      ["statusline", "show", "--script", SCRIPT], ["statusline", "install", "--script", SCRIPT], ["statusline", "uninstall", "--script", SCRIPT], ["--help"], ["bogus"], ["report", "--agent", "nobody"], ["exclude", "add", "--dates", "x"], ["statusline", "install", "--script", "/nope"]]) {
      const r = run(env, args);
      outputs.push(r.stdout, r.stderr);
    }
    seed(env, "none", "2026-10-04T12:00:00Z");
    outputs.push(run(env, ["status"]).stdout, run(env, ["--no-scan"]).stdout);
    let lines = 0;
    for (const line of outputs.join("\n").split("\n")) {
      lines++;
      assert.deepEqual(lintCopy(line), [], `copy lint: ${line}`);
      assert.deepEqual(tokensBanned(line), [], `tokens.json banned list: ${line}`);
      // "verdict" is only the contract's internal name for the finding-led variant: no output line says it (help names
      // `--lead finding`; `--lead verdict` is a hidden alias).
      assert.ok(!/\bverdicts?\b/i.test(line), `says "verdict": ${line}`);
    }
    assert.ok(lines > 60);
  } finally {
    env.cleanup();
  }
});
