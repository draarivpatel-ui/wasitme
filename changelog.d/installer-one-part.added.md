- **Add or remove one part without reinstalling: `install.sh --add PART` and `uninstall.sh --only PART`.** The parts
  are `app`, `scan-agent` (or `scan`), `claude-plugin`, `codex-plugin` and `statusline`. `--only` removes a part by the
  full uninstall's rules (your status line is restored only if it is still wasitme's) and keeps the install record,
  `engine.json` and `engine.env` in step, so nothing still names a part that is gone; folders the installer made that the
  part leaves empty go too. `--add` installs a part into the installed version from its own read-only copy, with no
  download; the app needs its sources (`--from DIR` of the same version). A part that is already there is left alone,
  and one that cannot be installed here stops the run with the reason and nothing changed.
