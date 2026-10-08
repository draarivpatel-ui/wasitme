// Runs an installer action the Mac app started (install.sh --update / --add, uninstall.sh ... --from-app), detached
// from the app, and records how it ended. node: built-ins only, no network; it runs exactly the command it is given.
//
//   node from-app.mjs <action> <wasitme-home> -- <sh> <script> <args...>
//
// Why: the app quits (uninstall) or is quit and started again (update) while the action runs. launchd kills what is
// left of a LaunchAgent's process group when the job ends (launchd.plist: AbandonProcessGroup), and a write to a closed
// pipe would kill the shell (SIGPIPE). So the action runs in a NEW session (detached: setsid), with stdin from /dev/null
// and stdout/stderr in a file, never tied to the app. The command returns at once: exit 0 once the run has started,
// exit 1 with nothing started when the folder is not usable or another action the app started is still running.
//
// Files, in <wasitme-home>/state/ (0700; created if missing), both 0600 and replaced on every run:
//   last-action.log    everything the action printed (paths of wasitme's own install locations, like a terminal run)
//   last-action.json   { "schema": "wasitme.action/1", "action": "update" | "add" | "uninstall" | "remove",
//                      "state": "running" | "done" | "partial" | "stopped" | "failed", "code": <exit code> | null,
//                      "summary": "<its last line>", "pid": <the detached run's pid while running> | null,
//                      "started": "<ISO time>", "finished": "<ISO time>" | null }
//                      A "running" file whose pid is gone (kill -0 fails) was cut short (a restart, say).
//                      state from the exit code: 0 done, 3 partial (a part failed and was rolled back), 4 stopped (the
//                      new plugin asks for more; nothing changed), anything else failed.
// After a full uninstall both files are deleted (the app that would read them is gone, and a later install must not
// show an old result); after --purge the folder itself is gone.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ACTIONS = new Set(["update", "add", "uninstall", "remove"]);

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function parse(argv) {
  const run = argv[0] === "--run";
  const rest = run ? argv.slice(1) : argv;
  const [action, home, sep, ...cmd] = rest;
  if (!ACTIONS.has(action) || !home || !path.isAbsolute(home) || sep !== "--" || cmd.length < 2) fail("from-app.mjs: bad arguments");
  return { run, action, home, cmd };
}

function files(home) {
  const dir = path.join(home, "state");
  return { dir, log: path.join(dir, "last-action.log"), json: path.join(dir, "last-action.json") };
}

/** A real folder of ours (never a symlink), as the engine requires (store/home.ts). */
function ownDir(dir) {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && (typeof process.getuid !== "function" || st.uid === process.getuid());
  } catch {
    return false;
  }
}

function writeJson(file, doc) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The action's last line worth showing: its final summary, or its error (not the "undoing" note after an error). */
function summaryOf(log) {
  let text = "";
  try { text = fs.readFileSync(log, "utf8"); } catch { return ""; }
  const lines = text.split("\n").map((l) => l.replace(/[\u0000-\u001f\u007f]/g, "").trim()).filter(Boolean)
    .filter((l) => !/^error: stopped early \(exit \d+\)/.test(l));
  return (lines.at(-1) ?? "").slice(0, 400);
}

/**
 * Another action the app started is still running: its result file says "running" and either names a live pid, or
 * names none yet and was started under a minute ago (stage 2 writes its pid a moment after stage 1 returns). Starting a
 * second one would overwrite its result file (the installer's own lock would stop the second run anyway).
 */
function busy(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return false; }
  if (!doc || doc.state !== "running") return false;
  if (Number.isInteger(doc.pid) && doc.pid > 0) {
    try { process.kill(doc.pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
  }
  const t = Date.parse(doc.started ?? "");
  const age = Date.now() - t;
  return Number.isFinite(age) && age >= 0 && age < 60_000;
}

function stateOf(code) {
  if (code === 0) return "done";
  if (code === 3) return "partial";
  if (code === 4) return "stopped";
  return "failed";
}

const { run, action, home, cmd } = parse(process.argv.slice(2));
const f = files(home);

if (!run) {
  // Stage 1 (what the app calls): set up the two files, start stage 2 in a new session, return at once.
  if (!ownDir(home)) fail(`${home} is not a wasitme folder of yours; nothing was started`);
  if (!ownDir(f.dir)) {
    try { fs.mkdirSync(f.dir, { mode: 0o700 }); } catch { /* checked next */ }
    if (!ownDir(f.dir)) fail(`could not use ${f.dir}; nothing was started`);
  }
  if (busy(f.json)) fail("another wasitme action started from the app is still running; nothing was started");
  const started = new Date().toISOString();
  writeJson(f.json, { schema: "wasitme.action/1", action, state: "running", code: null, summary: "", pid: null, started, finished: null });
  try { fs.rmSync(f.log, { force: true }); } catch { /* replaced below */ }
  const fd = fs.openSync(f.log, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  const child = spawn(process.execPath, [SELF, "--run", action, home, "--", ...cmd], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, WASITME_FROM_APP_STAGE: "run", WASITME_FROM_APP_STARTED: started },
  });
  child.unref();
  process.stdout.on("error", () => {}); // a caller that stopped reading changes nothing: the run is already on its way
  process.stdout.write(`Started in the background; its result will be in ${f.json}\n`);
  process.exit(0);
}

// Stage 2 (detached): say who is running, run the action, then record how it ended.
const started = process.env.WASITME_FROM_APP_STARTED ?? null;
try {
  writeJson(f.json, { schema: "wasitme.action/1", action, state: "running", code: null, summary: "", pid: process.pid, started, finished: null });
} catch { /* the final write below still happens */ }
const r = spawnSync(cmd[0], cmd.slice(1), { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, WASITME_FROM_APP_STAGE: "inner" } });
const code = typeof r.status === "number" ? r.status : 1;
if (!ownDir(f.dir)) process.exit(0); // --purge took the folder: nothing left to write into
const fullyUninstalled = action === "uninstall" && code === 0 && !fs.existsSync(path.join(home, "install-manifest"));
if (fullyUninstalled) {
  for (const x of [f.json, f.log]) { try { fs.rmSync(x, { force: true }); } catch { /* best effort */ } }
  // Folders only these two files kept alive go too (rmdir removes nothing but an empty folder).
  for (const d of [f.dir, home]) { try { fs.rmdirSync(d); } catch { /* not empty: the history the uninstall kept */ } }
  process.exit(0);
}
writeJson(f.json, {
  schema: "wasitme.action/1",
  action,
  state: stateOf(code),
  code,
  summary: summaryOf(f.log),
  pid: null,
  started,
  finished: new Date().toISOString(),
});
process.exit(0);
