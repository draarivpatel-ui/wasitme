- **The Codex report says plainly when wasitme has no Codex sessions yet.** `wasitme report --agent codex` (what the
  Codex skill runs) on results that hold only Claude Code used to stop with a usage error and the whole help text; it
  now prints one line saying the results hold no Codex sessions yet, where wasitme looks for Codex logs, and that
  `wasitme doctor` helps. An agent id wasitme does not know is still a usage error. The Codex skill now tells a report
  from a message by the report's "wasitme report:" heading, and says first when a report is out of date.
