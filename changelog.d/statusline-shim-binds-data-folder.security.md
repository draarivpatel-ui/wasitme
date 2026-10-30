- **The status line always reads the install's own data folder.** The status-line script took its folder from
  `WASITME_HOME`, or from `HOME`, in Claude Code's environment, and runs the wrapped status line it finds in that
  folder's `backups/statusline.cmd`. A project's own settings can set variables for its sessions, so they could point it
  at a folder of their choosing. The installer's status-line command (`~/.local/bin/wasitme-statusline`) now names the
  install's folder itself; reinstall or update to get the new command.
