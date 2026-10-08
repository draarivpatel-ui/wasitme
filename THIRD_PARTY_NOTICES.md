# Third-party notices

wasitme's own code is released under the [MIT license](LICENSE), Copyright (c) 2026 Aariv Patel.

**No third-party source code has been copied into this repository yet.** The projects below shaped wasitme through their
ideas, metric definitions and the bugs they taught us to avoid, and they deserve credit for that. wasitme re-implements
everything from definitions. If code is ever adapted from one of them, its full license text and copyright notice will be
added to this file in the same change (the MIT license requires that), and the entry will move from "ideas" to "code".

None of these projects is affiliated with or endorses wasitme.

## Ideas, definitions and lessons (no code copied)

| Project | License | Copyright holder | What we learned from it |
|---|---|---|---|
| [anthropics/claude-code issue #42796](https://github.com/anthropics/claude-code/issues/42796) (a user's before-and-after analysis of thousands of session logs) | An issue thread, not licensed software | n/a | The metric definitions that started this whole genre: Read-to-Edit ratio, research-to-mutation ratio, edits without a prior read, interrupts and reasoning loops per 1,000 tool calls, thinking depth from signature length, frustration phrases. Also the vendor's replies on what the logs can and cannot show. Credited here, nothing copied. |
| [nerf-watch](https://github.com/Abelo9996/nerf-watch) | MIT | Copyright (c) 2026 Abel Yagubyan | Comparing before and after across Claude Code and Codex; minimum-data rules; requiring a change to show up across several projects; requested-versus-served model mismatch; scanning at version boundaries. |
| [nerfwatch](https://github.com/lukejacobsen7/nerfwatch) (a different project from nerf-watch) | MIT | Copyright (c) 2026 Luke Jacobsen | Bootstrap intervals and CUSUM-style monitoring for model-quality probes. wasitme reads organic logs rather than running probes, so only the statistical vocabulary carried over. |
| [codeburn](https://github.com/getagentseal/codeburn) | MIT | Copyright (c) 2026 AgentSeal | The "retry" definition (an edit, then a non-read command, then another edit of the same file), one-shot success rate, cohort comparisons that show their sample size; and two bug lessons: subagent transcripts inflating session counts, and streaming token snapshots inflating cache counts. |
| [agentsview](https://github.com/kenn-io/agentsview) | MIT | Copyright (c) 2026 Kenn Software LLC | Edit churn (repeated edits to one file within a short window), repeated-call retry signals, and a long list of parser edge cases (double-ingested background sessions, subagent messages mislabelled as the user's). |
| [ccusage](https://github.com/ccusage/ccusage) | MIT | Copyright (c) 2025 ryoppippi | The catalogue of de-duplication mistakes: keeping the first of several streamed lines, resumed sessions replaying history, forked Codex sessions counted twice, repeated token-count events. |
| [claude-code-log](https://github.com/daaain/claude-code-log) | MIT | Copyright (c) 2025 Daniel Demmel | Documentation of Claude Code's message formats and conversation structure. |
| [inspecto](https://github.com/rahulbhardwaj94/inspecto) | MIT | Copyright (c) 2026 Rahul Bhardwaj | Reads per edit, rewrite ratio, retry density from prompt similarity, and calibrating metrics against outcomes. Also a bug lesson: treating only string-typed message content as a human prompt misses most real prompts. |
| [sniffly](https://github.com/chiphuyen/sniffly) | MIT | Copyright (c) 2025 Chip Huyen | Which interrupt and aborted-request message texts to recognise. |

For each licensed project above, the license and the copyright holder were read from its `LICENSE` file on 2026-10-07.
Re-check the upstream license before adapting any code.

## Codex Router (patterns, re-implemented)

[Codex Router](https://github.com/duolahypercho/codex-router) is licensed under the MIT license, Copyright (c) 2026
codex-router contributors (from its `LICENSE` file, read on 2026-10-07). wasitme borrows **patterns, not
code**: the shape of a one-line installer with a guided setup, building the macOS app locally and signing it ad hoc
instead of shipping a binary, a menu bar item plus panel fed by a small snapshot file, a supervised launch agent,
changelog fragments (`changelog.d/`), a `SECURITY.md` that is a real threat model, and release preflight checks. The
scripts in `scripts/` were written independently and differ in their rules (categories, versioned release sections,
release verification).

Codex Router's name, icon and any provider logos are not covered by its MIT license and are not used here.

## Contributor Covenant

[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) adopts the [Contributor Covenant](https://www.contributor-covenant.org),
version 2.1, by reference and credits it there. The Covenant is licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); its text is not reproduced in this repository.

## Build and test tools (development only, not shipped)

The engine has **zero runtime dependencies**; nothing below is part of what you install or run. These tools are used to
build and test it, at the versions in `package-lock.json` when this file was written.

| Package | Version | License | Copyright holder |
|---|---|---|---|
| [TypeScript](https://github.com/microsoft/TypeScript) | 5.9.3 | Apache-2.0 | Microsoft Corporation |
| [@types/node](https://www.npmjs.com/package/@types/node) | 22.20.5 | MIT | Copyright (c) Microsoft Corporation |
| [undici-types](https://www.npmjs.com/package/undici-types) (installed by @types/node, type declarations only) | 6.21.0 | MIT | Copyright (c) Matteo Collina and Undici contributors |

## Fonts, icons and artwork

| Font | Files | License | Copyright holder |
|---|---|---|---|
| [IBM Plex](https://github.com/IBM/plex) Serif (Regular, Italic, Bold, Bold Italic) and Plex Mono (Regular, Bold) | `design/system/fonts/app/*.ttf` (unmodified, for the Mac app) and `design/system/fonts/web/*.woff2` (subsets, renamed "Wasitme Serif" / "Wasitme Mono" because "Plex" is a Reserved Font Name; also inlined in `design/system/generated/tokens.inline.css`) | SIL Open Font License 1.1, full text in [`design/system/fonts/OFL.txt`](design/system/fonts/OFL.txt); changes listed in [`design/system/fonts/MODIFICATIONS.txt`](design/system/fonts/MODIFICATIONS.txt) | Copyright 2017 IBM Corp. (Plex Mono) and 2020 IBM Corp. (Plex Serif), with Reserved Font Name "Plex" |

The OFL lets the fonts be bundled and embedded with software as long as the license travels with them and a modified
version doesn't use the reserved name. Anything that ships the font files (the app bundle, a release archive) must carry `OFL.txt`
alongside. The self-contained HTML report is a single file with nothing beside it, so there the license travels in the fonts' own
metadata: the subset fonts keep the upstream copyright, license and designer name records as written (see
`MODIFICATIONS.txt`), which the OFL permits in place of a separate text file, and the report's inlined CSS names the license and
points at `OFL.txt` in this repository.

The glyphs, mark and app icon in `design/system/glyphs/` are wasitme's own, under the MIT license above. The wordmark
(`wordmark*.svg`) is set in IBM Plex Mono Bold and converted to outlines.
