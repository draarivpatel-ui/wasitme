# Claude Code edit tools, `relocated`, delegation (GPT-6.1 Sol, 2026-10-05; UNVERIFIED data)

1. **File-editing tools: no documented rename, merge, split, or replacement in 2.1.240–2.1.289.** Exact names remain `Edit` (targeted string replacement), `Write` (create/overwrite), and `NotebookEdit` (notebook cells). [Tool reference](https://code.claude.com/docs/en/tools-reference)

   Version evidence: **2.1.277** fixes `Edit`/`Write`; **2.1.281** explicitly fixes `Read`, `Write`, `Edit`, and `NotebookEdit`; **2.1.288** fixes instruction loading triggered by `Write`/`Edit`. These are fixes to existing tools. A transition involving `MultiEdit`, `apply_patch`, `Update`, or `Patch`, or mandatory delegation of edits, is **UNCONFIRMED** in this range. [Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

2. **`relocated`: publicly reported, but its formal JSONL schema and exact introduction version are UNCONFIRMED.** Issue **#91465**, reporting **2.1.258**, explicitly describes `"type":"relocated"` records when `EnterWorktree` moves the transcript. Issue **#75929**, reporting **2.1.204**, describes relocation markers pointing to the worktree directory. These are community reports, not a documented schema guarantee. [#91465](https://github.com/anthropics/claude-code/issues/91465), [#75929](https://github.com/anthropics/claude-code/issues/75929)

   The underlying **transcript-moving feature is officially documented from 2.1.198**: entering/exiting a Claude-created git worktree moves the session’s recorded location so `/desktop` and `--resume` find it under the new working directory, like `/cd`. An introduction around **2.1.270–2.1.289 is therefore unsupported**. [Worktree docs](https://code.claude.com/docs/en/worktrees)

   Compaction is separately documented with `type: "system"` and `subtype: "compact_boundary"`; identifying `relocated` as a compaction entry is **UNCONFIRMED**. [Subagent compaction docs](https://code.claude.com/docs/en/sub-agents#auto-compaction)

3. **More delegation by default in this range: UNCONFIRMED.** Related documented changes:
   - **2.1.271:** smaller default dynamic workflows on Pro.
   - **2.1.274:** fewer review subagents for models without tuned review settings.
   - **2.1.287:** an explicitly enabled “You should know” side agent. [Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

   The relevant earlier default change was **2.1.232**: interactive sessions enable fork mode and run spawned subagents in the background. That governs how spawned agents run; it does not establish increased delegation frequency. [Fork-mode docs](https://code.claude.com/docs/en/sub-agents#turn-fork-mode-on-or-off)
