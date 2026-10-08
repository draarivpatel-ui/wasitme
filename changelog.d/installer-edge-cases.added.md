- **The installer and uninstaller handle the edge cases.** A symlinked or foreign `~/.wasitme` is refused up front with
  the fix (the engine refuses it too, so an install there could never scan); `wasitme doctor` problems found right after
  an install are reported, not hidden behind "ok"; a custom `CLAUDE_CONFIG_DIR` or `CODEX_HOME` reaches the menu bar
  app's scans as well as the background scan; a `--home` sandbox install never names the real LaunchAgent, so the
  plugin's hooks cannot kick it; and after an uninstall that keeps your history, the last line gives a command that
  works (`--purge` from a source checkout also deletes such leftover history). The report skill answers "no results
  yet" without an extra "exit status 1" line, and the installed engine leaves out the development-only folders the npm
  package leaves out.
