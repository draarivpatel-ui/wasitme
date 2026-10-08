- **The installed status line runs in plain shell, not Node.** The installer ships `packaging/statusline.sh` and points
  Claude Code at `~/.local/bin/wasitme-statusline`, a small shim that runs it in plain shell (measured faster than Node
  can even start). That is the path `wasitme statusline install|show|uninstall` expect, so they work on an installed
  copy. If you already have a status line, the installer leaves it alone and names the command that wraps it, and the
  uninstaller hands a wrapped status line back to the engine before removing it.
