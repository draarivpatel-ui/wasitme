# Work packages: the `WP-##` ids in code comments

wasitme was built as a set of numbered **work packages**, one per part of the code, from an internal build plan that is
not part of this repository. Code comments, tests and a few documents cite them the way they cite decisions (`D##`,
listed in [DECISIONS.md](DECISIONS.md)): `WP-12` means "the store and the scan pipeline" wherever it appears. This file
is the public key: one row per id that a shipped file cites, saying in plain words which part of the code it names.
A test (`scripts/test/repo-docs.test.mjs`) keeps the two in step: every id cited in a shipped file has a row here, and
every row here is still cited somewhere.

Two spellings you will meet. A `Δ` after an id (`WP-10Δ`) marks a second pass over the same part, made after the first
version was merged; it names the same code. `WP-10/11` means both ids. "WP-12 review" is the review that followed
WP-12; the fixes it produced carry the same id.

| Id | What it is | Where |
|---|---|---|
| WP-01 | Repository scaffolding and hygiene: `scripts/ci-local.sh`, the copy lint, the source scans (no network code, no home paths, no remote assets), and the tests of those scripts. `WP-01Δ` is the review round of the checks. | `scripts/`, `scripts/test/` |
| WP-02 | The contract freeze: the `glance.v1` and `snapshot.v1` schemas, their golden fixtures, and the matching TypeScript and Swift types. | `contract/`, `engine/src/types.ts`, [CONTRACT.md](CONTRACT.md) |
| WP-03 | Mini-spikes: short, isolated experiments that checked an assumption before the code depending on it was written (how Claude Code installs a plugin and runs its hooks, the Codex plugin root, the Node permission model, the canvas in a real web view). Their write-ups are the public record. | [docs/spikes/](spikes/) |
| WP-10 | The Claude Code reader: session logs to the engine's neutral records (exchanges, events, counts), with the tool-error split, per-field label shapes, parser versions and the interactive-session classifier. `WP-10Δ` is its second pass. | `engine/src/readers/claude/` |
| WP-11 | The Codex reader: the same for Codex session logs. `WP-11Δ` is its second pass. | `engine/src/readers/codex/` |
| WP-12 | The store and the scan pipeline: file fingerprints and the cache, cross-file dedupe, per-source shards, the history that survives deletion of the logs, the scan lock and the salt, the exclude list, `--until` and `--read-only`, the SessionStart hook's project snapshot, per-family parser versions with re-derivation, the privacy probe and the performance harness. | `engine/src/store/`, `engine/src/hook/` |
| WP-20a | Metrics and gates: exchanges to per-metric cells, the eligibility and sensitivity gates, materiality, tiers, the minimum detectable effect, pace and progress. | `engine/src/analysis/metrics/`, `engine/src/analysis/gates/` |
| WP-20b | Confounders: directly standardised ratios, the projects rules, fragility (leave one session or day out), the degrees-of-freedom floor and the single-metric note. | `engine/src/analysis/confounders/` |
| WP-21 | Attribution: onset, the strata rule-out, the version-boundary test, the decision table ([METHOD.md §11](METHOD.md)), persistence and the `calibrated` flag; `attributeAgent` and `decide`. "The WP-21 decider" is this pipeline as the calibration harness runs it. | `engine/src/analysis/attribution/`, `engine/src/analysis/calibration/wp21.ts` |
| WP-22 | Words: every engine-owned string of glance and snapshot in both lead variants, the trace sentences, the copy lints that run on real output, and `buildOutputs`, which assembles the two documents. | `engine/src/words/` |
| WP-23 | Calibration: the harness that runs the whole pipeline over synthetic users (null sequences, planted changes, the G-MDE, G-onset and G-attr checks), its runner, and the dated artifact the scan reads to learn whether an agent is calibrated. | `engine/src/analysis/calibration/`, `engine/scripts/calibration-run.mjs`, [docs/calibration/](calibration/) |
| WP-24a | "G0": the engine's first counts-only run over real logs, done locally to fix the tool-error definition and to check the classifier mix against real counts. Its output is not in the repository: [D61](DECISIONS.md) records the decisions it led to, with coarse, qualitative reasons only. | a maintainer-only script, not in the public repository |
| WP-30 | The command line and its outputs: the terminal report, the Markdown, HTML and JSON reports, the status-line files, the demo, `doctor` and `exclude`. | `engine/src/cli/`, `engine/src/output/` |
| WP-40 | The brand and design system: one token source (`tokens.json`: colours, type, glyphs, labels) that `Tokens.swift`, `tokens.css` and `tokens.ts` are generated from, the glyph set, the contrast report, and the mockups made from labelled demo data. | `design/system/` |
| WP-41 | The Control Center canvas: the web page the Mac app shows in a locked-down web view, built to `ui/dist/`. | `ui/` |
| WP-50 | The Swift menu bar app: status item, popover panel, desktop panel, the Control Center window and its bridge to the canvas, the single-instance guard, `--capture`. | `macos/` |
| WP-51 | The app build script: `swift build`, assembling the `.app` (the design-token sync check, the canvas from `ui/dist`, the icon), re-stamping the SDK version, ad-hoc signing and verification. | `macos/scripts/build-app.sh` |
| WP-60 | The Claude Code plugin: the mod, the SessionStart and SessionEnd hooks, the report skill and its `run.sh`. | `plugin/` |
| WP-61 | The Codex plugin: the skill and manifest Codex installs from its own plugin root. | `plugin-codex/` |
| WP-62 | The status line for Claude Code: the shell script that prints the glance state, and its install into and removal from Claude Code's settings. | `packaging/statusline.sh`, `engine/src/statusline/` |
| WP-70 | The installer: install, update, uninstall, `doctor --repair`, the versioned install directories with the `current` link, and the LaunchAgent for the background scan. | `scripts/install.sh`, `scripts/uninstall.sh`, `scripts/lib/` |
| WP-95 | The release script: the release tarball from a commit, its file allow-list, `SHA256SUMS` and the stamped installer. It never publishes anything. | `scripts/release.sh` |
