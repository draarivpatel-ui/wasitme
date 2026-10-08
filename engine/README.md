# wasitme

*Was it me, or the model?* wasitme reads your own Claude Code and Codex session logs on your machine, builds a timeline of what
changed on your side (model, effort, instruction files, MCP servers, skills) and on the agent's side (version updates, which model
was served), and compares your recent weeks with the weeks before. It says which side your numbers moved with only when the
evidence supports it; otherwise it says "Too early to tell" and still shows you the timeline.

**Local only.** No network code, no account, no telemetry, and no runtime dependencies. It reads your session logs read-only and keeps
only counts, durations, short allow-listed labels and salted hashes: never prompt or reply text, tool input or output, code, file
paths, project names or secrets.

This package is the engine and the `wasitme` command line. It needs **Node.js 22 or newer**. The menu bar app, the Claude Code
plugin, the Codex skill and the background scan come from the repository's installer, which sets all of them up and asks before each
step.

```sh
wasitme              # the findings for each agent
wasitme status       # one line
wasitme report       # a shareable, numbers-only evidence report (Markdown; --html for one file)
wasitme demo         # sample output, clearly marked as demo data
wasitme doctor       # what state wasitme is in (add --redacted before pasting it into an issue)
```

Counts are indicators, not a measure of answer quality. The method, the privacy rules and the threat model are documented in the
repository: <https://github.com/draarivpatel-ui/wasitme> (`docs/METHOD.md`, `docs/PRIVACY.md`, `SECURITY.md`).

MIT licensed. wasitme is an independent project, not affiliated with or endorsed by Anthropic or OpenAI.
