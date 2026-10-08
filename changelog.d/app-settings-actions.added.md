- **The Mac app's Settings actions run from the app, each after a native confirmation.** Adding or removing a part
  (the Claude Code plugin, the status line, the Codex skill, the background scan, the menu bar app), clearing the saved
  history, uninstalling everything and updating now go through the installer, the uninstaller or the engine with a fixed
  command, and only after you say yes in a macOS sheet that names what happens and what is kept. Destructive ones are
  drawn as such, with Cancel as the default; uninstalling offers "Also delete my saved history", off by default. Removing
  the app or uninstalling quits the app once the change has started. Update stays unavailable until the first public
  release. Showing or hiding the desktop panel and "Show in Finder" for the saved history work without a sheet. The page
  is sent what is installed (from `install.sh --status --json`) so it can show each control's state.
