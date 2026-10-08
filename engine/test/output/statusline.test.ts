/**
 * packaging/statusline.sh (WP-62): the status line prints `wasitme: <state>[ +n]` from glance.json, goes "out of date" by
 * the contract's rule, wraps the user's own status line, never lets stdin or a tampered glance reach the terminal, and
 * is fast. Every run uses a temp WASITME_HOME and a fixed clock (WASITME_STATUSLINE_NOW); the real ~/.wasitme is never
 * read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { outputsOf, CASES, readJson, ROOT } from "./cases.js";

const SCRIPT = `${ROOT}packaging/statusline.sh`;
const GEN = "2026-10-04T12:00:00Z";
const GEN_S = Date.parse(GEN) / 1000;

interface Home { root: string; wh: string; cleanup(): void }
function home(): Home {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wasitme-slsh-")));
  const wh = join(root, ".wasitme");
  mkdirSync(join(wh, "backups"), { recursive: true });
  return { root, wh, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeGlance(h: Home, doc: unknown, text?: string): void {
  writeFileSync(join(h.wh, "glance.json"), text ?? `${JSON.stringify(doc)}\n`, { mode: 0o600 });
}

function run(h: Home, over: { now?: number; stdin?: string | Buffer; env?: Record<string, string>; cwd?: string } = {}) {
  const env: Record<string, string> = { HOME: h.root, WASITME_HOME: h.wh, PATH: "/usr/bin:/bin", WASITME_STATUSLINE_NOW: String(over.now ?? GEN_S + 60), ...over.env };
  // stdin comes from a file, like Claude Code's pipe it can be large, and the script never reads it
  const inFile = join(h.root, "stdin.bin");
  writeFileSync(inFile, over.stdin ?? "");
  const fd = openSync(inFile, "r");
  try {
    const r = spawnSync("/bin/sh", [SCRIPT], { env, stdio: [fd, "pipe", "pipe"], encoding: "utf8", cwd: over.cwd, maxBuffer: 64 << 20 });
    return { out: r.stdout, err: r.stderr, status: r.status };
  } finally {
    closeSync(fd);
  }
}

const glanceOf = (name: string) => ({ ...outputsOf(name).glance });

// ───────────────────────────── the segment ─────────────────────────────

for (const c of CASES) {
  test(`status line (${c.name}): prints exactly the engine's statusLine for the first agent`, () => {
    const h = home();
    try {
      const g = glanceOf(c.name);
      writeGlance(h, g);
      const r = run(h);
      assert.equal(r.status, 0);
      assert.equal(r.err, "");
      assert.equal(r.out, `${g.agents[0]!.statusLine}\n`);
      assert.match(r.out, /^wasitme: [a-z' ]+\n$/);
    } finally {
      h.cleanup();
    }
  });
}

test("status line: a '+n' for new changes is printed as the engine wrote it; two agents → the first speaks", () => {
  const h = home();
  try {
    const g = glanceOf("you");
    g.agents = [{ ...g.agents[0]!, statusLine: "wasitme: your side +2" }, { ...g.agents[0]!, agent: "codex", statusLine: "wasitme: timeline only" }];
    writeGlance(h, g);
    assert.equal(run(h).out, "wasitme: your side +2\n");
  } finally {
    h.cleanup();
  }
});

test("status line: the contract fixtures (compact) print their statusLine", () => {
  const h = home();
  try {
    const manifest = readJson(`${ROOT}contract/fixtures/manifest.json`);
    let checked = 0;
    for (const f of manifest.fixtures) {
      if (f.contract !== "glance" || !f.valid || f.covers.includes("hostile") || f.expect.display !== "ok" || f.expect.agents.length === 0) continue;
      const g = readJson(`${ROOT}contract/fixtures/${f.file}`);
      writeGlance(h, g);
      const r = run(h, { now: Date.parse(f.now) / 1000 });
      assert.equal(r.out, `${g.agents[0].statusLine}\n`, f.file);
      checked++;
    }
    assert.ok(checked >= 15, `checked ${checked} fixtures`);
  } finally {
    h.cleanup();
  }
});

// ───────────────────────────── out of date: the contract's rule ─────────────────────────────

test("status line: out of date exactly when now − generatedAt > staleAfterSec, or generatedAt is more than 300 s ahead", () => {
  const h = home();
  try {
    writeGlance(h, glanceOf("none"));
    const fresh = "wasitme: no detectable change\n";
    const stale = "wasitme: out of date\n";
    assert.equal(run(h, { now: GEN_S }).out, fresh);
    assert.equal(run(h, { now: GEN_S + 7200 }).out, fresh, "exactly at the limit");
    assert.equal(run(h, { now: GEN_S + 7201 }).out, stale);
    assert.equal(run(h, { now: GEN_S - 300 }).out, fresh, "300 s ahead is tolerated");
    assert.equal(run(h, { now: GEN_S - 301 }).out, stale, "301 s ahead is not");
    const g = glanceOf("none");
    g.staleAfterSec = 600;
    writeGlance(h, g);
    assert.equal(run(h, { now: GEN_S + 600 }).out, fresh);
    assert.equal(run(h, { now: GEN_S + 601 }).out, stale);
    // a missing or absurd staleAfterSec falls back to 7,200
    writeGlance(h, null, JSON.stringify(glanceOf("none")).replace('"staleAfterSec":7200,', "") + "\n");
    assert.equal(run(h, { now: GEN_S + 7200 }).out, fresh);
    assert.equal(run(h, { now: GEN_S + 7201 }).out, stale);
    writeGlance(h, null, JSON.stringify({ ...glanceOf("none"), staleAfterSec: 99999999999 }) + "\n");
    assert.equal(run(h, { now: GEN_S + 7201 }).out, stale);
    // an unparseable generatedAt is out of date, never fresh
    for (const bad of ["yesterday", "2026-13-04T12:00:00Z", "2026-10-04T25:00:00Z", "2026-10-04T12:00:00+05:00", "0999-10-04T12:00:00Z", ""]) {
      writeGlance(h, { ...glanceOf("none"), generatedAt: bad });
      assert.equal(run(h).out, stale, `generatedAt ${JSON.stringify(bad)}`);
    }
  } finally {
    h.cleanup();
  }
});

test("status line: the date arithmetic agrees with Date.UTC for 250 dates 2020–2099 (month ends, leap days, boundaries)", () => {
  const h = home();
  try {
    const dates: number[] = [];
    for (const y of [2020, 2024, 2028, 2032, 2096, 2099]) for (const [m, d] of [[1, 1], [2, 28], [2, 29], [3, 1], [12, 31]] as const) dates.push(Date.UTC(y, m - 1, d, 0, 0, 0));
    let seed = 12345;
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    while (dates.length < 250) dates.push(Date.UTC(2020 + rnd(80), rnd(12), 1 + rnd(28), rnd(24), rnd(60), rnd(60)));
    for (const ms of dates) {
      const iso = new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
      if (Number.isNaN(ms) || iso.length !== 20) continue;
      writeGlance(h, { ...glanceOf("none"), generatedAt: iso });
      const s = ms / 1000;
      assert.equal(run(h, { now: s + 7200 }).out, "wasitme: no detectable change\n", `${iso} at the limit`);
      assert.equal(run(h, { now: s + 7201 }).out, "wasitme: out of date\n", `${iso} past the limit`);
    }
  } finally {
    h.cleanup();
  }
});

// ───────────────────────────── nothing trustworthy → nothing printed ─────────────────────────────

test("status line: no glance, another schema, a file that does not promise numbers only, a pretty-printed or damaged file → silent", () => {
  const h = home();
  try {
    assert.deepEqual(run(h), { out: "", err: "", status: 0 }, "no file");
    const g = glanceOf("you");
    writeGlance(h, { ...g, schema: "wasitme.glance/2" });
    assert.deepEqual(run(h), { out: "", err: "", status: 0 }, "another schema");
    writeGlance(h, { ...g, privacy: { containsText: true } });
    assert.equal(run(h).out, "", "containsText:true is refused");
    writeGlance(h, g, `${JSON.stringify(g, null, 2)}\n`);
    assert.equal(run(h).out, "", "only the engine's compact form is read");
    writeGlance(h, g, '{"schema":"wasitme.glance/1","generatedAt":"2026-10-04T12:00:00Z"');
    assert.equal(run(h).out, "", "truncated");
    writeGlance(h, g, "");
    assert.equal(run(h).out, "", "empty");
    writeGlance(h, g, `${"x".repeat(30000)}${JSON.stringify(g)}\n`);
    assert.equal(run(h).out, "", "over the size bound");
    writeGlance(h, g, "\u0000\u0001garbage\n");
    assert.equal(run(h).out, "");
    // a glance that is a symlink is not followed
    rmSync(join(h.wh, "glance.json"));
    writeFileSync(join(h.root, "real.json"), `${JSON.stringify(g)}\n`);
    symlinkSync(join(h.root, "real.json"), join(h.wh, "glance.json"));
    assert.equal(run(h).out, "", "symlink");
    // no HOME and no WASITME_HOME → nothing
    rmSync(join(h.wh, "glance.json"));
    const r = spawnSync("/bin/sh", [SCRIPT], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    assert.deepEqual([r.stdout, r.status], ["", 0]);
    // a relative WASITME_HOME is ignored
    const rel = spawnSync("/bin/sh", [SCRIPT], { env: { WASITME_HOME: "relative", PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    assert.deepEqual([rel.stdout, rel.status], ["", 0]);
  } finally {
    h.cleanup();
  }
});

// ───────────────────────────── hostile glance and hostile stdin ─────────────────────────────

test("status line: a tampered statusLine is never echoed; the label is rebuilt from the state (unknown states are 'can't tell which')", () => {
  const h = home();
  try {
    const evil = [
      "\u001b[2J\u001b[Hwasitme: your side", "wasitme: $(touch pwned)", "wasitme: `id`", "wasitme: a;b", "wasitme: x\\ny", "wasitme: <b>x</b>", "wasitme: ../../etc",
      "wasitme: ", "other: your side", "wasitme: Your Side", "wasitme: " + "a".repeat(100), "wasitme: tab\\there", "wasitme: \u202eevil", "wasitme: a\\\"b", "wasitme: 100%", "wasitme: *",
    ];
    for (const s of evil) {
      const g = glanceOf("you");
      g.agents = [{ ...g.agents[0]!, statusLine: s }];
      writeGlance(h, g);
      const r = run(h, { cwd: h.root });
      assert.equal(r.out, "wasitme: your side\n", JSON.stringify(s));
      assert.ok(!r.out.includes("\u001b"));
    }
    const states: [string, string | null, string][] = [
      ["insufficient", "needs_data", "wasitme: too early to tell"], ["insufficient", "calibration_pending", "wasitme: timeline only"],
      ["none", null, "wasitme: no detectable change"], ["unclear", "mixed", "wasitme: can't tell which"], ["you", null, "wasitme: your side"],
      ["agent", null, "wasitme: agent side"], ["from the future", null, "wasitme: can't tell which"], ["\u001b[31myou", null, "wasitme: can't tell which"],
    ];
    for (const [state, reason, want] of states) {
      const g = glanceOf("you");
      g.agents = [{ ...g.agents[0]!, state, reason, statusLine: "bad" } as never];
      writeGlance(h, g);
      assert.equal(run(h).out, `${want}\n`, `${state}/${reason}`);
    }
    assert.ok(!require_exists(join(h.root, "pwned")));
  } finally {
    h.cleanup();
  }
});

function require_exists(path: string): boolean {
  try { readFileSync(path); return true; } catch { return false; }
}

test("status line: the hostile contract fixture prints only a plain label", () => {
  const h = home();
  try {
    const g = readJson(`${ROOT}contract/fixtures/glance/hostile-labels.json`);
    writeGlance(h, g);
    const r = run(h, { now: Date.parse("2026-10-04T18:30:00Z") / 1000 });
    assert.match(r.out, /^wasitme: [a-z' +0-9:-]+\n$/);
    assert.equal(r.out, "wasitme: your side\n");
  } finally {
    h.cleanup();
  }
});

test("status line (hostile stdin): Claude Code's JSON is never read by the script, so nothing in it can change the output", () => {
  const h = home();
  try {
    writeGlance(h, glanceOf("agent"));
    const baseline = run(h, { stdin: "" });
    assert.equal(baseline.out, "wasitme: agent side\n");
    const nested = (n: number): string => `${'{"a":'.repeat(n)}1${"}".repeat(n)}`;
    const hostile: (string | Buffer)[] = [
      '{"model":{"id":"../../../etc/passwd","display_name":"\\u001b[2J"},"effort":{"level":"high; rm -rf ~"}}',
      '{"model":{"id":"$(touch /tmp/wasitme-pwned)","display_name":"`id`"},"workspace":{"current_dir":"/\\n/etc"}}',
      "\u001b]0;title\u0007\u001b[31m\u009b31m\u202e",
      nested(5000),
      Buffer.from([0xff, 0xfe, 0x00, 0x00, 0xc3, 0x28, 0xa0, 0xa1, 0xed, 0xa0, 0x80]),
      "\n".repeat(100000),
      Buffer.alloc(8 << 20, 0x61),
      '{"model":{"id":"a\\"b"},"x":"\\\\","y":"\\"}","z":"{"}',
      "",
    ];
    for (const stdin of hostile) {
      const t0 = Date.now();
      const r = run(h, { stdin });
      assert.deepEqual([r.out, r.status], [baseline.out, 0], "output unchanged by stdin");
      assert.equal(r.err, "");
      assert.ok(Date.now() - t0 < 5000);
    }
    assert.ok(!require_exists("/tmp/wasitme-pwned"));
    // stdin closed or a terminal-less launch: still fine
    const noStdin = spawnSync("/bin/sh", [SCRIPT], { env: { HOME: h.root, WASITME_HOME: h.wh, PATH: "/usr/bin:/bin", WASITME_STATUSLINE_NOW: String(GEN_S + 60) }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    assert.equal(noStdin.stdout, baseline.out);
  } finally {
    h.cleanup();
  }
});

test("status line: a hostile PATH or working directory cannot substitute its own `date` or `sh`", () => {
  const h = home();
  try {
    const evil = join(h.root, "evil");
    mkdirSync(evil);
    for (const name of ["date", "sh", "cat"]) {
      writeFileSync(join(evil, name), "#!/bin/sh\necho 0\necho pwned > pwned.txt\n", { mode: 0o755 });
      chmodSync(join(evil, name), 0o755);
    }
    writeGlance(h, glanceOf("none"));
    const env = { HOME: h.root, WASITME_HOME: h.wh, PATH: `${evil}:.:/usr/bin:/bin` };
    // real clock path (no seam): the glance is from 2026-10-04, so it is out of date by the real `date`, not the fake one
    const r = spawnSync("/bin/sh", [SCRIPT], { env, cwd: evil, encoding: "utf8" });
    assert.equal(r.stdout, "wasitme: out of date\n");
    assert.ok(!require_exists(join(evil, "pwned.txt")));
  } finally {
    h.cleanup();
  }
});

// ───────────────────────────── wrapping the user's own status line ─────────────────────────────

function wrap(h: Home, cmd: string): void {
  writeFileSync(join(h.wh, "backups", "statusline.cmd"), `${cmd}\n`, { mode: 0o600 });
}

test("status line (wrapping): the user's line is printed unchanged and the segment is appended to its LAST line", () => {
  const h = home();
  try {
    writeGlance(h, glanceOf("you"));
    wrap(h, "printf 'first line\\nsecond \\033[1mline\\033[0m\\n'");
    assert.equal(run(h).out, "first line\nsecond \u001b[1mline\u001b[0m · wasitme: your side\n");
    wrap(h, "printf 'one'");
    assert.equal(run(h).out, "one · wasitme: your side\n");
    wrap(h, "true");
    assert.equal(run(h).out, "wasitme: your side\n", "an empty line → the segment alone");
    wrap(h, "exit 3");
    assert.deepEqual([run(h).out, run(h).status], ["wasitme: your side\n", 0], "a failing wrapped command does not matter");
    wrap(h, "echo user");
    // no wasitme segment (no glance) → the user's line, untouched
    rmSync(join(h.wh, "glance.json"));
    assert.equal(run(h).out, "user\n");
    // out of date → the segment says so, still appended
    writeGlance(h, glanceOf("you"));
    assert.equal(run(h, { now: GEN_S + 99999 }).out, "user · wasitme: out of date\n");
  } finally {
    h.cleanup();
  }
});

test("status line (wrapping): stdin is passed through to the user's command, byte for byte; the user's PATH and env are theirs", () => {
  const h = home();
  try {
    writeGlance(h, glanceOf("none"));
    wrap(h, "cat");
    assert.equal(run(h, { stdin: '{"model":{"id":"opus"}}' }).out, '{"model":{"id":"opus"}} · wasitme: no detectable change\n');
    wrap(h, 'printf "%s|%s" "$MY_VAR" "$(command -v ls)"');
    const r = run(h, { env: { MY_VAR: "kept", PATH: "/bin:/usr/bin" } });
    assert.equal(r.out, "kept|/bin/ls · wasitme: no detectable change\n");
    // a multi-line command is run whole
    writeFileSync(join(h.wh, "backups", "statusline.cmd"), "a=1\nb=2\necho \"$a$b\"\n", { mode: 0o600 });
    assert.equal(run(h).out, "12 · wasitme: no detectable change\n");
  } finally {
    h.cleanup();
  }
});

test("status line (wrapping): a command file that is a symlink, or oversize, is ignored", () => {
  const h = home();
  try {
    writeGlance(h, glanceOf("none"));
    writeFileSync(join(h.root, "real.cmd"), "echo from-symlink\n");
    symlinkSync(join(h.root, "real.cmd"), join(h.wh, "backups", "statusline.cmd"));
    assert.equal(run(h).out, "wasitme: no detectable change\n");
    rmSync(join(h.wh, "backups", "statusline.cmd"));
    wrap(h, `echo ${"x".repeat(9000)}`);
    assert.equal(run(h).out, "wasitme: no detectable change\n");
  } finally {
    h.cleanup();
  }
});

// ───────────────────────────── shell hygiene and speed ─────────────────────────────

test("status line: the script is valid POSIX sh (sh -n, and every other POSIX shell and shellcheck found here)", () => {
  assert.equal(spawnSync("/bin/sh", ["-n", SCRIPT]).status, 0);
  for (const sh of ["dash", "bash", "ksh", "busybox"]) {
    const found = spawnSync("/usr/bin/env", ["which", sh], { encoding: "utf8" });
    if (found.status !== 0) continue;
    const args = sh === "busybox" ? ["sh", "-n", SCRIPT] : ["-n", SCRIPT];
    assert.equal(spawnSync(found.stdout.trim(), args).status, 0, `${sh} -n`);
  }
  const sc = spawnSync("/usr/bin/env", ["which", "shellcheck"], { encoding: "utf8" });
  if (sc.status === 0) {
    const r = spawnSync(sc.stdout.trim(), ["-s", "sh", SCRIPT], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout);
  }
  const text = readFileSync(SCRIPT, "utf8");
  assert.ok(text.startsWith("#!/bin/sh\n"));
  assert.ok(!/\b(curl|wget|nc|ssh)\b/.test(text.replace(/#.*$/gm, "")), "no network command");
});

test("status line: it never starts node and is several times faster than node's own startup (own part, real clock)", () => {
  const h = home();
  try {
    writeGlance(h, { ...glanceOf("you"), generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
    const env = { HOME: h.root, WASITME_HOME: h.wh, PATH: "/usr/bin:/bin" };
    const time = (cmd: string, args: string[], n: number): number => {
      spawnSync(cmd, args, { env }); // warm up
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < n; i++) spawnSync(cmd, args, { env, input: "{}" });
      return Number(process.hrtime.bigint() - t0) / 1e6 / n;
    };
    const sh = time("/bin/sh", [SCRIPT], 60);
    const node = time(process.execPath, ["-e", "0"], 15);
    const empty = time("/bin/sh", ["-c", ":"], 60);
    const out = spawnSync("/bin/sh", [SCRIPT], { env, encoding: "utf8" }).stdout;
    assert.equal(out, "wasitme: your side\n", "the timed run printed the segment (fresh, real clock)");
    console.log(`# status line: ${sh.toFixed(1)} ms per run (an empty sh: ${empty.toFixed(1)} ms; node -e 0: ${node.toFixed(1)} ms); own part ≈ ${(sh - empty).toFixed(1)} ms`);
    assert.ok(sh < node / 2, `the script (${sh.toFixed(1)} ms) should be far below node's startup (${node.toFixed(1)} ms)`);
  } finally {
    h.cleanup();
  }
});
