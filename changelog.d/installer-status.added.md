- **`install.sh --status --json` says which parts are installed and which could be added here.** Run from the
  installed copy, it prints one JSON document (`wasitme.install-status/1`): the installed version and, for the app, the
  Claude Code plugin, the status line, the Codex skill and the scan agent, `on`, `off`, `own` (your own status line,
  which wasitme leaves alone), `unavailable` with a reason code (`agent_missing`, `not_supported`) or `unknown` when
  nothing is installed. It only reads, prints no path and exits 0. `--update`, `--add` and `--status` also reuse the
  `--prefix` the install recorded, so the command is never written to a second place.
