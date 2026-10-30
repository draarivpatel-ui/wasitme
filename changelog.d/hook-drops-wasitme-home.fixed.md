- **The SessionStart hook always keeps its project snapshot in the install's own folder.** Its engine took the data
  folder from `WASITME_HOME` whenever the session's environment set it (a project's own settings can set variables for
  its sessions), so the snapshot went to a folder the scan never reads, or was refused by the hook's sandbox and not
  kept at all. The hook now drops `WASITME_HOME` before the engine starts, as the report skill's wrapper already did,
  so the snapshot always lands in `~/.wasitme`.
