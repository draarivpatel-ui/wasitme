- **`install.sh --update` installs a newer version with exactly the parts you have, asking nothing.** It reads the
  install record, updates those parts and adds none, rebuilds the Mac app when it is installed, and keeps the previous
  version for a rollback. A running app is quit before its bundle is replaced and started again in the background (by
  its LaunchAgent, or `open -g`, which does not take focus); an app you had quit stays quit, and `--no-relaunch` leaves
  a running one closed too. The last line says what happened in one sentence and names any installed part it could not
  update. If the new Claude Code plugin would hook or call more than the installed one, the update stops before
  changing anything, with exit 4, until you add `--accept-plugin-changes`. To update from a checkout, run
  that checkout's installer: `sh DIR/scripts/install.sh --from DIR --update`.
