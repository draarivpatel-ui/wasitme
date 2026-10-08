- **The Mac app finds a custom Claude Code or Codex folder even when you open it yourself.** If you keep an agent's
  files somewhere other than `~/.claude` or `~/.codex` (you set `CLAUDE_CONFIG_DIR` or `CODEX_HOME`), the installer
  records that folder in `~/.wasitme/engine.json`. The app now uses the recorded folder whenever it was started without
  those variables, which is the case when you open it from Finder or Spotlight instead of letting its login item start
  it; before, only the login-item copy knew about the folder and a scan started from a hand-opened app looked in the
  default folders. A value in the variables always wins, a recorded value that is not an absolute path is ignored, and
  nothing changes if you use the default folders.
