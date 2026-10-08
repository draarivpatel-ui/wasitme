- **`--from-app` runs an update, an add, a removal or a full uninstall detached from the Mac app.** With it,
  `install.sh --update`, `install.sh --add`, `uninstall.sh --yes --only` and `uninstall.sh --yes` return at once and carry
  on in their own session, so quitting or unloading the app cannot cut them short, and the uninstaller waits for the app
  to quit before removing it. The result (running, done, partial, stopped or failed, with the exit code and a one-line
  summary) is written to `~/.wasitme/state/last-action.json` and the output to `last-action.log`, both private; only one
  such action runs at a time. After a full uninstall both files are deleted.
