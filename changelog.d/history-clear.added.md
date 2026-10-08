- **`wasitme history clear` deletes your saved history without uninstalling.** It removes the results and everything
  wasitme derived from your logs (`history/`, `glance.json`, `snapshot.json`, the saved decisions and pending project
  snapshots) and keeps the salt, your exclusions, `engine.json`, the backups, the logs and the install, so the next scan
  starts fresh from the logs your agents still keep. It asks first on a terminal; without one it needs `--yes`
  (exit 2 otherwise), and it waits for a running scan instead of racing it.
