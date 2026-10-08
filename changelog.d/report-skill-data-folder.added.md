- **The report skill's engine always uses the install's own data folder.** `/wasitme:report` (and the Codex skill) run
  the engine through the plugin's `run.sh`, which already refused to take its code from a folder the session's
  environment named. It now drops `WASITME_HOME` as well, so a project cannot point the report's scan at a data folder
  of its own choosing: the results are written to the install's `~/.wasitme`, as the hooks and the installed command
  do. The bundled read-only engine now runs `status` without `--read-only`, which `status` does not accept.
