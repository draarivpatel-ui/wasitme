- **Uninstalling keeps a status line you set after the install when `wasitme statusline install --wrap` wrapped it.**
  If you installed with the status line, then set your own, then ran `wasitme statusline install --wrap`, the
  uninstaller restored the settings file from before the install (or removed the key) first, so your newer status line
  was lost. When the engine's backup holds a status line it replaced in the settings file being uninstalled and the
  line is still wasitme's, the engine now puts yours back first; in every other case the uninstaller works as before.
  The backup records which settings file it belongs to, so a backup made for another configuration (`--claude-dir`)
  is never restored into this one and is kept. A backup from an earlier version names no file, so the uninstaller
  keeps its usual order for it.
