- **Refreshing a stale wasitme status line no longer puts later edits to `settings.json` at risk.** When the installer
  moved its own status line to the current command (an update from an older installer, or a moved `--prefix`), it
  re-recorded the file's checksum as if nothing else had changed since the first install. An uninstall then restored the
  original backup over everything written in between (Claude Code's own plugin keys, a theme change), or deleted a
  `settings.json` the installer had created. The refresh now records that the file changed, so the uninstaller only ever
  removes wasitme's `statusLine` key in that case; a file untouched otherwise is still restored byte for byte.
