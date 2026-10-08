# Spikes S-CX and S-NODEPERM (WP-03 mini-spikes)

Date: 2026-10-04. Tool versions: Codex CLI 0.160.0, macOS 27 (arm64). Node 26.8.1 and 24.16.0 were already installed; Node 22.23.3 and 22.12.0 were fetched (see "What was downloaded").
Everything ran in temp directories: an isolated `CODEX_HOME` and `HOME` for Codex, and a fully synthetic temp `HOME` for the scan. No real `~/.codex`, `~/.claude`, `~/.wasitme`, LaunchAgent or session log was read or written. No model was called and nothing was logged in to.

Tags used here: **[ran]** = it was run and the output is in `spikes-tracked/codex-node/evidence/`. **[docs]** = read from a generated protocol schema or a docs lookup, not live-run. **[inferred]** = reasoning from something that was run; not run itself.

The build plan these spikes tested is an internal planning document and is not published; where this note quotes it, the quote is the plan's wording at the time. The scripts and raw evidence under `spikes-tracked/`, and the commits this note names (0df2c4b, 2d27fec), stayed in the development tree and are not published either.

How this was checked: the first agent wrote the scripts and the first draft and was stopped before it finished. A second agent finished it and **re-ran every `[ran]` claim in a fresh scratch directory**: the S-CX transcript and the S-NODEPERM matrix, grant-semantics and wildcard tables came out identical to the committed evidence (apart from process ids); the matrix is also identical on a build of `main` at 0df2c4b (it carries the D39 reader fixes), so the result does not depend on the older reader code; the overhead numbers were re-measured and one range in the first draft was corrected (§3.7). Four gaps were closed with new probes (§2.8, §3.5, §3.9, and the claims in §2.1 and §2.3 that had no evidence file). Both Node 22 binaries were checked again by their code signature (§7).

## 1. Answers first

| | Result | What it changes in the build plan |
|---|---|---|
| **S-CX** | **Works, with three plan corrections.** The command names in the plan's install section are right and the install leaves no `hooks.json`. But Codex stores the *resolved* marketplace path, so the `current` symlink does not carry an update to Codex. | Update becomes "remove marketplace, add it again, `plugin add`". Uninstall order matters. A pruned version dir breaks `codex plugin list`. See §2.5 to §2.7. |
| **S-NODEPERM** | **Partly works.** The log readers and the hook snapshot work under the sandbox on all four Node versions tried. The config-snapshot collector does **not**: under the plan's flags it reports every config source as `unreadable`. It works with one small engine change plus a different flag spelling. A log root that is a symlink (dotfile managers do this) needs the link **and** its target granted, or the readers silently return nothing (§3.9). | The "whenever `--allow-net` is listed" rule would switch the sandbox off on Node 22 and 24. Replace it with a feature test. See §3.6, §3.9 and §4. |

Three things I did not expect, all **[ran]**:
1. A Node permission flag list with a path that is a string prefix of another (`~/.claude` and `~/.claude.json`) makes the directory itself unreadable. That is exactly the shape the plan needs.
2. The sandbox does not stop a symlink inside an allowed folder from reaching a file outside it. The reader follows file symlinks, so a hostile symlink in a log folder is read.
3. Grants are matched on the **spelling** of a path, not on where it resolves to. Granting `~/.claude` covers reads through `~/.claude/...` but not through the real directory it links to, and the config collector opens the resolved path. So a symlinked `~/.claude` needs both spellings granted (§3.9).

## 2. S-CX: Codex plugin install, update, uninstall

Setup: `spikes-tracked/codex-node/s-cx/run.sh` (33 assertions, all ok; transcript `evidence/s-cx-run.txt`). The marketplace root is built by `mk-roots.sh` in the shape the plan's install section gives: `.agents/plugins/marketplace.json` (name `wasitme-codex`, one plugin `wasitme`, `source: "./"`), `.codex-plugin/plugin.json`, a root `plugin.json` with the agent-plugins `$schema`, and `skills/report/SKILL.md`. No hooks directory.

### 2.1 Command names [ran]

| Step | Command | Output (verbatim) |
|---|---|---|
| Register | `codex plugin marketplace add <root>` | ``Added marketplace `wasitme-codex` from <resolved root>.`` |
| Install | `codex plugin add wasitme@wasitme-codex [--json]` | ``Added plugin `wasitme` from marketplace `wasitme-codex`.`` and `Installed plugin root: …/plugins/cache/wasitme-codex/wasitme/0.1.0` |
| Inspect | `codex plugin list` · `codex plugin marketplace list` | table with `installed, enabled  0.1.0` |
| Update | **there is none for a local root** (see 2.5) | `codex plugin marketplace upgrade` prints `No configured Git marketplaces to upgrade.` |
| Uninstall | `codex plugin remove wasitme@wasitme-codex` then `codex plugin marketplace remove wasitme-codex` | ``Removed plugin `wasitme` from marketplace `wasitme-codex`.`` / ``Removed marketplace `wasitme-codex`.`` |

`plugin add` and `marketplace upgrade` take `--json`. `plugin add --json` returns `pluginId`, `name`, `marketplaceName`, `version`, `installedPath`, `authPolicy` (`"ON_INSTALL"`). There is no `plugin update` or `plugin upgrade` subcommand: `codex plugin --help` lists add, list, marketplace, remove (`evidence/s-cx-extra.txt` §4). `plugin remove` of a plugin that is **not installed** (fresh config, no marketplace) still prints ``Removed plugin `wasitme` from marketplace `wasitme-codex`.`` and exits 0, so the uninstaller can call it unconditionally; do not treat that line as proof that something was installed.

### 2.2 TOML keys Codex writes [ran]

```toml
[marketplaces.wasitme-codex]
source_type = "local"
source = "<resolved path of the marketplace root>"

[plugins."wasitme@wasitme-codex"]
enabled = true
```

Against a seeded user `config.toml` (comments, an inline-comment `notify` line, an `[mcp_servers.demo]` table with an inline `env`), add then remove left the file **byte-identical** to the seed, mode 0600 [ran]. The two tables are inserted before a trailing comment. So the plan's 0600 byte-copy backup is a belt-and-braces fallback here, not a likely need; keep it, since a different Codex version could rewrite differently.

### 2.3 Cache layout and hooks [ran]

Installed files live at `plugins/cache/<marketplace>/<plugin>/<version>/` and are a copy of the whole marketplace root: `.agents/plugins/marketplace.json`, `.codex-plugin/plugin.json`, `plugin.json`, `skills/report/SKILL.md`. **No `hooks.json`, and nothing named `hooks*`, exists anywhere under `CODEX_HOME`.**

That result is only meaningful because of a positive control: the same plugin with a `hooks/hooks.json` added **does** get `hooks/hooks.json` copied into the cache (variant `v4`). So the check can fail, and it passes for wasitme because wasitme ships none. I did not test whether Codex would run such a hook.

Installed read-only sources work: from the installer's layout (version dir `a-w`: files `0444`, directories `0555`) the cache copy keeps the file modes (`plugin.json` stays `0444`) but creates directories `0755`, so `plugin remove` and re-install can delete it (`evidence/s-cx-extra.txt` §4).

### 2.4 Which manifest files are required [ran]

| Variant | Marketplace manifest | Plugin manifest | `marketplace add` | `plugin add` |
|---|---|---|---|---|
| ctrlA | none | root `plugin.json` | **fails**: `marketplace root does not contain a supported manifest` | n/a |
| v0 | `.agents/plugins/marketplace.json` | none | ok | **fails**: `Error: missing plugin.json` |
| v1 | `.agents` | root `plugin.json` only | ok | ok |
| v2 | `.agents` | `.codex-plugin/plugin.json` only | ok | ok |
| plan | `.agents` | both | ok | ok |
| v5 | `.agents` | both, **different versions** (`.codex-plugin` says 0.1.0, root says 9.9.9) | ok | installs **9.9.9**: the root `plugin.json` wins |
| sub | `.agents` with `source: "./plugin-codex"` | both, in the subdirectory | ok | ok (only the subdirectory is copied) |
| v6, v7 | legacy `.claude-plugin/marketplace.json` | root `plugin.json` only (v6) · `.claude-plugin/plugin.json` (v7) | ok | ok |

The plan's claim "a root-only `plugin.json` failed with 'missing plugin.json' [reviewer]" **did not reproduce** on 0.160.0: root-only installs fine under both the `.agents` and the legacy `.claude-plugin` marketplace (v1, v6). The text `missing plugin.json` appears only when the plugin has no manifest at all (v0). I do not know what the reviewer ran.

In every variant that installed, the skill appeared in the app-server `skills/list`, including v1 whose manifest has no `skills` key. So the `skills/` directory is found by default.

Practical rule: keep both manifests (cheap, and it matches the OpenAI native and legacy locations), generate them from one source, and add a CI check that their `version` fields are equal. When they differ, the root file decides.

### 2.5 Update [ran]

- `codex plugin marketplace upgrade` does nothing for a local root ("No configured Git marketplaces to upgrade.").
- Re-running `codex plugin add wasitme@wasitme-codex` installs whatever the registered root now contains: a version bump gives a new cache dir and removes the old one, and `config.toml` is unchanged. A changed file with **no** version bump is also refreshed.
- **The symlink does not help.** `marketplace add ~/.wasitme/current/plugin-codex` makes Codex print and store the *resolved* path (`…/versions/0.1.0/plugin-codex`), not the symlink. After flipping `current` to 0.2.0, `plugin add` still installs 0.1.0. This differs from the Claude Code behaviour the plan's install section describes, which keeps the symlink path.
- Re-adding the same marketplace name from the new resolved path is refused: `marketplace 'wasitme-codex' is already added from a different source; remove it before adding this source`.
- **The working update recipe:** `codex plugin marketplace remove wasitme-codex` → `codex plugin marketplace add ~/.wasitme/current/plugin-codex` → `codex plugin add wasitme@wasitme-codex`. After it: version 0.2.0, only the new cache dir, `enabled = true` kept.

### 2.6 Uninstall order and a pruned version dir [ran]

- `plugin remove` first, then `marketplace remove` (the plan table's order) leaves `config.toml` exactly as it was before install.
- **The other order leaves an orphan:** after `marketplace remove` alone, `[plugins."wasitme@wasitme-codex"] enabled = true` and the cache copy remain, and `skills/list` still offers `wasitme:report` to the model. A later `plugin remove` still works and cleans up.
- **If the registered version dir is deleted** (for example by pruning old versions after an update), `codex plugin list`, `codex plugin marketplace list` and `codex plugin add` all exit 1 (``failed to load configured marketplace snapshot(s): … marketplace root does not contain a supported manifest``). `plugin remove` and `marketplace remove` still work, and the already-installed skill keeps working from the cache.
  - So the installer must either re-register Codex's marketplace on every update before pruning, or never prune a version dir that `config.toml` still points at; `doctor` should detect this (`codex plugin list` exit code) and repair it with the recipe above.

### 2.7 How the skill is invoked

- **[ran]** The skill is listed as **`wasitme:report`** (plugin name, colon, skill name), with `pluginId: "wasitme@wasitme-codex"` and `scope: "user"`, by `codex app-server` `skills/list` (`evidence/s-cx-extra.txt` §4). Codex's own system skills carry default prompts written as `Use $imagegen to …` and `Use $review-agent to …`, so the mention form is `$<name>`. The wasitme skill itself has no default prompt (its manifest does not set one).
- **[docs]** The protocol schema has a `UserInput` item `{type: "skill", name, path}` (this is what a client sends when you pick a skill). A docs lookup (sourced, not verified by me; output in the session only) says an explicit mention is `$<skill-name>` or the `/skills` picker, and that a plugin skill's identity is `plugin-name:skill-name`, so **`$wasitme:report`**.
- **Not verified:** actually running it. That needs a model turn and a real login, which this task does not use. `codex debug prompt-input` does **not** expand a mention: for four prompts (`please run the wasitme report`, `$wasitme:report`, `use $wasitme:report now`, `$report`) no `<skill>` block appears and the SKILL.md body is not in the prompt (`invoke-test.sh`, `evidence/s-cx-extra.txt` §3), so there is no model-free way to see the invocation.
- The README line should say "type `$wasitme:report`" only after the first real run (S-DESK-style check) confirms it.

### 2.8 Side effects worth knowing [ran]

- The CLI-only flow (`marketplace add`, `plugin add`) leaves in `CODEX_HOME` exactly: `config.toml`, `plugins/cache/…`, `.tmp/marketplaces` and `tmp/arg0` (listed unfiltered in `evidence/s-cx-extra.txt` §1; `show.sh` hides `.tmp`). Nothing is written to the temp `HOME`. After `plugin remove` the cache is empty again.
- Running `codex app-server` or `codex debug …` is heavier: it creates five SQLite state databases (`state_5`, `logs_2`, `goals_1`, `memories_1`, `queue_1`, each with `-shm`/`-wal`), `installation_id`, the `skills/.system` skills, and a `.tmp/git-<id>` folder with `plugins.sync.lock` (`evidence/s-cx-extra.txt` §4). That is Codex's own behaviour, and it is why only the verification script uses it, never the installer.
- **No network is needed.** The whole flow (`marketplace add`, `plugin add --json`, `plugin list`, `marketplace list`, `marketplace upgrade`, `plugin remove`, `marketplace remove`) succeeds with every network operation denied for the `codex` process (macOS `sandbox-exec` with `(deny network*)`; a `curl` under the same profile fails, so the denial is real; `evidence/s-cx-extra.txt` §2, 10 assertions). That shows the commands do not **need** the network; it does not show that they never **try** (a swallowed failed attempt would look the same). The installer can therefore be tested offline.

## 3. S-NODEPERM: a scan under `node --permission`

Setup: `spikes-tracked/codex-node/s-nodeperm/`. `mk-fixture.mjs` builds a synthetic temp `HOME` with the repo's own test builders: 4 Claude session files in 3 project folders (9 prompts, one subagent transcript, one session file that is a symlink to a file outside the allow-list), 2 Codex rollouts (5 prompts), config files for both agents, a project folder with `CLAUDE.md` for the hook, and negative-control files outside the allowed paths. It installs the built engine as the installer will: `~/.wasitme/versions/0.0.0-spike/engine/` (read-only), a `current` symlink, a 0600 salt file created on first run.

`scan.mjs` runs the built readers and the config collector, then writes its result under `~/.wasitme` (tmp file plus rename, a lock file, the salt). **Exit status is not the evidence**, because `engine/src/readers/fs.ts` swallows every filesystem error (`entries()` returns `[]`, `stamp()` returns `undefined`). `check.mjs` therefore compares the recovered **counts against the planted ones** and a **digest of everything derived against an unsandboxed baseline**, separately for the readers and for the config collector.

Runs: `run.sh` (matrix), `semantics.sh` (what a flag grants), `wildcard-chars.sh`, `bench.sh`, and three added in the finishing pass: `realpath-probe.sh` (which path-resolution calls work under the grants), `symlink-roots.sh` and `symlink-scan.sh` (symlinked log roots). Transcripts are in `evidence/`.

The scan flags are specified in the plan's privacy and security section (hooks and "Node sandbox"); its install section only says the LaunchAgent runs "with the permission flags". Every run uses one `--allow-fs-read` / `--allow-fs-write` flag per path, as the plan says.

### 3.1 Node versions [ran]

| Node | `--permission` | `--experimental-permission` | `--allow-net` in `--help` | `--permission-audit` |
|---|---|---|---|---|
| 22.12.0 | **rejected**: `bad option: --permission`, exit 9 | works (prints an `ExperimentalWarning` to stderr) | no | no |
| 22.23.3 | works | works | no | no |
| 24.16.0 | works | not tested separately | **no** | no |
| 26.8.1 | works | not tested separately | yes | yes |

The flag name changes inside the 22 line, so D24's "Node ≥ 22" is **not** enough to promise `--permission`. A hook that passes `--permission` on 22.12.0 dies with exit 9; run async, nobody would see it. Earlier 22.x releases very likely behave like 22.12.0 **[inferred]**: only 22.12.0 and 22.23.3 were run, so the exact release where `--permission` appeared is unknown (release-note dates from a docs lookup are **[docs]**, unverified). That is why proposal A below is a feature test, not a version check.

### 3.2 Flags exactly as the plan specifies, results [ran]

All four Node versions behave the same in every row (R = the log readers, C = the config collector; "FAIL" for C means it reported sources as `unreadable`, not that it returned wrong data):

| Scenario | Result on 22.12 / 22.23 / 24.16 / 26.8 |
|---|---|
| **A**: read `~/.claude`, `~/.codex`, `~/.wasitme`; write `~/.wasitme` (one flag per path) | R pass, C **fail** |
| **B**: A plus `~/.claude.json` | R pass, C **fail** |
| B with the entry script run through the `current/` symlink | same as B |
| B plus read all of `$HOME` | R pass, C **fail** (the ancestors of `$HOME` are still ungranted) |
| **Hook snapshot** with the plan's flags (`~/.wasitme`, `<cwd>`; write `~/.wasitme`) | **pass**: per-file states and hashes equal the baseline; `<cwd>` itself is stat-able |
| One comma-joined `--allow-fs-read=a,b,c` | **crash**, exit 1, `ERR_ACCESS_DENIED` (the whole string is one literal path) |
| No `--allow-fs-write` | **crash**, exit 1, `ERR_ACCESS_DENIED` at the first write (the salt) |
| **D**: read list missing `~/.codex` (a typo) | **exit 0**, readers recover 0 of 2 Codex sources and 0 of 5 prompts; reported only by the count check |

So: a full scan of the **logs** works under the exact flags. A full scan including the **config snapshot** does not.

### 3.3 Why the config collector fails [ran]

`engine/src/extract/configsnap/safefs.ts` `resolveSafe()` walks a path one component at a time from `/`, calling `lstat` on every ancestor (`/`, `/Users`, the home dir). Under `--permission` those ancestors are not readable, so the walk returns `unreadable` before it reaches `~/.claude`. The collector degrades loudly, not silently: `config-dir:unreadable` for both agents, no items. That is better than reporting "no config", but the config half of every scan would be empty.

The permission-audit run on Node 26 lists the violations, and the first ones are `FileSystemRead /private`, the temp parent, and `$HOME`: exactly the ancestors (`evidence/s-nodeperm-audit-node26.txt`; audit mode logs violations and enforces nothing).

### 3.4 What a flag actually grants [ran: `semantics.sh`, identical on all four versions]

- `--allow-fs-read=<dir>`, `<dir>/` and `<dir>/*` are the same: the directory itself and everything below it. A sibling that merely shares the name prefix (`<dir>-other`, `<dir>.json`) is **not** granted.
- `--allow-fs-read=<dir>*` also grants prefix siblings (`<dir>-other`, `<dir>.json`).
- **Two flags where one path is a string prefix of the other** (`<dir>` and `<dir>.json`, i.e. `~/.claude` and `~/.claude.json`): both children and the file are readable, but **the directory itself is denied** (`stat`, `readdir`). This is why flag set B fails for `~/.claude` even apart from the ancestors. It looks like a Node quirk, not intended behaviour; I did not look at Node's source.
- Only `*` is special in a value. `?` and `[…]` are taken literally (`wildcard-chars.sh`). A project directory whose name contains `*` would therefore widen the hook's grant to its prefix siblings.
- Paths given to different flags are not joined by commas (since Node 20.7, [docs]); a comma-joined value is one literal path, as the crash row shows.

### 3.5 A tested way to make the config collector pass [ran]

Two changes together, nothing else:

1. **Spell the grants as single prefix wildcards:** `--allow-fs-read=<home>/.claude*` and `--allow-fs-read=<home>/.codex*` (plus `<home>/.wasitme`, and `--allow-fs-write=<home>/.wasitme`). One flag per agent, no prefix pair, and `~/.claude.json` is covered by the first.
2. **Let `resolveSafe` skip an ancestor the sandbox refuses to `lstat`:**

```diff
     try {
       isLink = lstatSync(next).isSymbolicLink();
     } catch (e) {
+      // Under `node --permission`, an ancestor outside the granted paths (/, /Users, the home dir) cannot be lstat'ed.
+      // Treat it as a plain directory and keep walking; the leaf is still checked.
+      if (code(e) === "ERR_ACCESS_DENIED" && stack.length > 0) { cur = next; continue; }
       return { status: accessOfError(e) };
     }
```

I applied this only to the **installed copy** of `safefs.js` in the temp home (`patch-safefs.mjs`); `engine/` is not mine to change. Result on all four Node versions: **readers pass and the config collector passes with a digest identical to the unsandboxed baseline.** With the patch but the old flag spelling the collector still fails (A: `claude-json:unreadable`; B: `config-dir:unreadable`), so both changes are needed.

Cost of the wildcard spelling: `<home>/.claude*` also grants `~/.claude-<anything>` and `~/.claude.json.<anything>`, and `.codex*` likewise. In practice those are Claude's own backup files and other `.claude-*` folders; still, it is broader than "the log roots".

**What the patch gives up, and one alternative** [ran: `realpath-probe.sh`, `evidence/s-nodeperm-realpath-probe.txt`]. The walk exists so that no path component is touched before it has been checked against the avoid list (macOS-protected folders) and so that symlinks are resolved one hop at a time. The patch stops *checking* only the components the sandbox will not let the process `lstat`: `/`, `/Users` and the home directory itself. None of them is on the avoid list, but an ancestor that is itself a symlink is no longer followed by the walker (the OS still follows it when the file is opened **[inferred]**). Everything inside the granted roots is still walked and checked hop by hop. The alternative is a single `fs.realpathSync(root)`: under the wildcard grants it works on all four versions for the root, for files below it and even for `<home>` (whose `stat` and `lstat` are denied, but the JS `realpathSync` is not). `realpathSync.native` works for the root only under the wildcard spelling (under the prefix pair it is denied on 22.23, 24 and 26) and is denied for `<home>` on 22.23 and later. The price of the one-call alternative: `realpathSync` follows symlinks with no avoid check, so a root that is a symlink into `~/Documents` would be touched, and could raise the macOS privacy prompt, before it could be refused. The patch keeps the guard; the one-call version is simpler. This is a call for the config collector's owner; both were run only as probes, and only the patch was run as a full scan.

### 3.6 What the sandbox does and does not buy [ran]

Probe table (`evidence/s-nodeperm-probes.txt`, flag set B; `true` means the operation succeeded):

| Operation | 22.12 | 22.23 | 24.16 | 26.8 |
|---|---|---|---|---|
| Read a file outside the allow-list; list `~/Documents`; write outside `~/.wasitme`; write into `~/.claude` | denied | denied | denied | denied |
| Write into `~/.wasitme` | ok | ok | ok | ok |
| Spawn a child process; start a worker thread | denied | denied | denied | denied |
| **Open a symlink inside `~/.claude` that points outside the allow-list** | **succeeds** | **succeeds** | **succeeds** | **succeeds** |
| **The reader's own `stamp()` on such a symlink** | **succeeds** | **succeeds** | **succeeds** | **succeeds** |
| Loopback `net.connect` to a closed port | `ECONNREFUSED` (not blocked) | not blocked | not blocked | **`ERR_ACCESS_DENIED`** |

- The planted symlinked session file was **read through** (`badLines=1`) in every sandboxed run, the same as unsandboxed. So the sandbox is **defence in depth, not a boundary**: it does not replace the config collector's hop-by-hop symlink guard, and the plan's "symlinks inside them are never followed" is only true for directories (`fs.ts` `stamp()` follows file symlinks). A symlink into a macOS-protected folder would still trigger the OS privacy prompt.
- **Network blocking exists only where `--allow-net` exists.** On Node 22 and 24 a network connection is attempted normally, and `process.permission.has("net")` returns `false` anyway, so it must not be used to infer a block. The "no networking" promise on 22/24 rests on `scripts/check-no-network.mjs` plus review, not on the sandbox.
- `process.permission.has("fs.read", path)` works under the flag and could drive a "Sources" self-report; it reports the directory inode of `~/.claude` as not readable in set B, matching the quirk above.

### 3.7 Overhead [ran, micro-benchmark, `evidence/s-nodeperm-bench.txt` and `-rerun.txt`]

Per 10,000 calls, three rounds each on Node 22.23 / 24.16 / 26.8 (nine rounds per row; the re-run, taken later through `heavy.sh`, agrees):

| Call | no sandbox (ms per 10k) | `--permission` (ms per 10k) | extra per call |
|---|---|---|---|
| `stat` | 7.5 to 10.6, median 7.9 | 94.6 to 126.2, median 96.2 | about 9 µs |
| `readFile` of a tiny file | 98 to 111, median 100 | 189 to 259, median 192 | about 9 µs |
| `readdir` | 127 to 185, median 128 | 217 to 334, median 222 | about 9 µs |

So the sandbox adds a fixed cost of roughly 9 to 10 µs per filesystem call, whatever the call (a scan that makes 100,000 file calls pays about one second). The first draft of this section said "+12 µs per `stat` and +100 µs per file read" and quoted wider ranges than its own evidence file; both were wrong (the read figure by a factor of ten) and are corrected here. I did not measure a scan of real-sized data; the plan's scan time budget should be re-measured with the sandbox on.

### 3.8 Fallback if the engine change is not made

The plan's cut #7 ("sandbox off by default") is **not needed**. Cheaper options, in order:
1. Make the one-line `resolveSafe` change and use the wildcard grants (§3.5). Verified on all four versions.
2. If the config collector must stay as is: run the log scan under the sandbox and the config collector in a second, unsandboxed `node` step started by the same shell wrapper (it cannot be started from inside the sandbox, because child processes are denied). The collector's own guard already avoids protected folders.

Both options need the symlink rule in §3.9.

### 3.9 Symlinked log roots and path spelling [ran: `symlink-roots.sh`, `symlink-scan.sh`]

Node matches a grant against the **spelling** of the path the process uses, not against where that path leads (`evidence/s-nodeperm-symlink-roots.txt`; identical on 22.12, 22.23, 24.16 and 26.8). With `~/.claude` a symlink to a directory elsewhere (what dotfile managers create):

| Grant | read through the link | read through the real path |
|---|---|---|
| the link (`~/.claude`) | ok | **denied** |
| the target | **denied** | ok |
| both | ok | ok |
| the link as `~/.claude/*` | ok | **denied** |

The same holds for a non-canonical spelling of a canonical directory (an alias symlink standing in for `/tmp` and `/private/tmp`): granting one spelling does not cover the other. That is why every fixture here uses `/private/tmp/...` paths.

It matters for a real scan because the two halves use different spellings. The readers use the root path as given, so their reads go through the link. The config collector's `resolveSafe` returns the **resolved** path and opens that. A full scan of the fixture with `~/.claude` and `~/.codex` replaced by symlinks (`evidence/s-nodeperm-symlink-scan.txt`, wildcard grants, collector patched as in §3.5, all four Node versions):

| Grants | Readers | Config collector |
|---|---|---|
| link only (`~/.claude*`, `~/.codex*`) | pass | **fail** (`config-dir:unreadable`) |
| target only | **fail, silently: 0 of 4 Claude and 0 of 2 Codex sources** | fail |
| link **and** target, one flag each | pass | pass |

So the launcher (the shell wrapper or LaunchAgent script, which runs outside the sandbox) must resolve each root with `realpath` before it starts node and pass **both** spellings as separate flags (one flag if they are equal). The same applies to the `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `WASITME_*_DIR` overrides, which the readers honour. A wrong or missing grant fails the readers without any error, which is why the count self-test (§3.2, row D) has to stay. The hook is not affected: it receives `<cwd>` from Claude Code and reads through that same spelling **[inferred]**.

## 4. Proposed DECISIONS.md lines (numbers provisional; the orchestrator assigns them)

Two proposed entries, called A and B here. Both were later recorded together as D49.

- **A — Sandbox detection is a feature test, not `--allow-net`.** Pick the flag by running `node --permission -e 0`, falling back to `node --experimental-permission -e 0`; record the working flag in `engine.json` and re-test in `doctor`. Node 22.12.0 (the oldest 22.x tested) has only the experimental name and rejects `--permission` with exit 9; earlier 22.x probably the same **[inferred]**. `--allow-net` (Node 26 here; not on 22.12, 22.23, 24.16) only decides whether we may claim network enforcement. fs, child-process and worker limits work on all four tested versions. *Source: S-NODEPERM [ran].*
- **B — Sandbox flag shape, scope and symlinks.** One `--allow-fs-read` / `--allow-fs-write` per path (comma lists are one literal path). Grants for a config directory and its sibling state file use a single prefix wildcard (`~/.claude*`, `~/.codex*`), never a prefix pair. Grants match the spelling of a path, so the launcher (outside the sandbox) resolves each root with `realpath` and passes **both** the link spelling and the resolved path (§3.9); otherwise a symlinked `~/.claude` makes the readers return nothing, silently. The hook snapshot uses the plan's flags unchanged but skips the snapshot when `cwd` contains `*` or is `$HOME` or an ancestor of it **[inferred]**. The config collector tolerates an ancestor that the sandbox will not `lstat` (§3.5; the one-call `realpathSync` alternative is the owner's choice). The sandbox is defence in depth, not a boundary: it follows symlinks out of an allowed folder, so the no-follow and guard rules stay mandatory. It costs about 9 µs per filesystem call. A scan self-test compares recovered counts with the allow-list (exit status alone is not enough, because the readers swallow errors). *Source: S-NODEPERM [ran].*
- **D44 — Codex plugin lifecycle.** Codex stores the resolved marketplace path, so a `current` flip does not reach it. Update = `plugin marketplace remove` → `marketplace add current/plugin-codex` → `plugin add`. Uninstall = `plugin remove` then `marketplace remove` (never the reverse; `plugin remove` is safe to call when nothing is installed). The installer never prunes a version dir that Codex's `config.toml` still points at (`doctor` repairs it with the update recipe). `.codex-plugin/plugin.json` and the root `plugin.json` are generated from one source with equal versions (the root file wins on conflict). The `codex plugin` commands work with the network denied, so install tests can run offline. The skill is `wasitme:report` (invoked as `$wasitme:report` only after a live check with a real login). *Source: S-CX [ran] except the invocation text [docs].*

## 5. Proposed changes to the build plan

- Privacy and security, "Node sandbox": replace "whenever `node --help` lists `--allow-net`" with feature test A; replace "Whether a full scan works under these exact flags is untested" with the §3.2 result and recipe B; add `~/.claude.json` (or the `.claude*` wildcard) to what the scan may read, because the collector reads it; add the symlinked-root rule (§3.9) and the ~9 µs per-call cost.
- Privacy and security, hook step 2: keep the flags; add the `cwd` guard; "the engine lives under `~/.wasitme`" stays true. Replace "S-NODEPERM checks the exact flag syntax on Node 22 and 26" with "verified on 22.12 (experimental name), 22.23, 24.16, 26.8".
- Privacy and security, hostile input: "symlinks inside them are never followed" → "directory symlinks are never followed; file symlinks are, so `fs.ts` should `lstat` and skip them (or the reader's `stamp()` should reject links)". This is a code finding for the readers owner, not something S-NODEPERM can fix. (Also checked on `main` at 0df2c4b: `readers/fs.ts` and `configsnap/safefs.ts` are unchanged since this branch's base, so the finding still applies.)
- The hostile-input part also says log roots "are resolved with `realpath` once". The readers on `main` at 0df2c4b do not do that (no `realpath` call under `engine/src/readers`; only the config collector resolves paths). Either is workable under the sandbox, but the launcher must grant what the engine will actually open: if the readers are changed to resolve the root first, a link-only grant breaks them (§3.9).
- Install, Codex block: drop "(required: a root-only `plugin.json` failed … [reviewer])"; say either manifest installs on 0.160.0, `missing plugin.json` means neither exists, and the root file wins a version conflict. Replace "S-CX confirms" with the §2.1 names. The plan's update journey, step 7 "use the command S-CX settles" → the §2.5 recipe.
- Install, uninstall table: keep the Codex rows and order; add "never `marketplace remove` first".
- Performance budgets: re-measure with the sandbox on (§3.7).
- `engine/package.json` said `"engines": {"node": ">=18.18"}` on this branch, which contradicted D24; `main` already has `>=22` (2d27fec), so nothing to do.

## 6. What was not verified

Node 20, 22.0 to 22.11, 23, 25; Intel Macs; a real LaunchAgent (the flags were run directly); macOS privacy (TCC) prompts; Codex versions other than 0.160.0; Codex Desktop; a git or remote marketplace; whether Codex runs a shipped hook; the skill actually executing (it needs a model turn and a real Codex login, so it was **not attempted**; AGENTS.md says to stop and report such a step, and the README line stays unconfirmed until a live check); whether `codex plugin` *tries* the network (it works with the network denied, §2.8); a `$HOME` that is itself reached through a symlink, end to end (only the grant-spelling probe, §3.9); the sandbox on a large scan; and anything against real logs or the real `~/.codex`.

## 7. What was downloaded

The first agent fetched two Node tarballs from the official `nodejs.org/dist/` for macOS arm64, each checked against that release's `SHASUMS256.txt` before use: `v22.23.3` (49,963,763 bytes, sha256 `23b25245…5922f53`) and `v22.12.0` (48,568,612 bytes, sha256 `293dcc6c…0f3e13`). Only `bin/node` was extracted, into the scratch directory (`mk-nodes.sh`); nothing was installed system-wide. It deliberately did not use `npx node@X`, because its installer runs package scripts. `npm ci` ran the repo's lockfile (4 packages).

The finishing agent downloaded nothing. Before re-running the two binaries it checked their code signature (`codesign -dv`): both are signed `Developer ID Application: Node.js Foundation (HX7739G8FX)` and report `v22.12.0` and `v22.23.3`. It also built a copy of `main`'s engine from `git archive` into the scratch directory with the repo's own TypeScript.

## 8. Re-running

```
SCRATCH=<canonical temp dir>            # on macOS use /private/tmp/..., not /tmp/... (grants match the spelling of a path, §3.9)
sh spikes-tracked/codex-node/s-cx/run.sh                                # 33 assertions
sh spikes-tracked/codex-node/s-cx/extra.sh                              # 13 assertions; uses macOS sandbox-exec for the network-denied part
sh spikes-tracked/codex-node/s-nodeperm/mk-nodes.sh 22.23.3 22.12.0     # downloads two Node tarballs; ask first, or place the binaries by hand
ENGINE=<repo>/engine sh spikes-tracked/codex-node/s-nodeperm/run.sh     # after: scripts/dev/heavy.sh npm ci && npm run build -w engine
sh spikes-tracked/codex-node/s-nodeperm/semantics.sh
sh spikes-tracked/codex-node/s-nodeperm/wildcard-chars.sh
sh spikes-tracked/codex-node/s-nodeperm/realpath-probe.sh               # needs run.sh's fixture
sh spikes-tracked/codex-node/s-nodeperm/symlink-roots.sh
ENGINE=<repo>/engine sh spikes-tracked/codex-node/s-nodeperm/symlink-scan.sh
scripts/dev/heavy.sh sh spikes-tracked/codex-node/s-nodeperm/bench.sh
SCRATCH=<dir> sh spikes-tracked/codex-node/scrub.sh <log> <out>         # before committing any captured log
```
