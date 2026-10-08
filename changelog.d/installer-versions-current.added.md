- **The installer keeps each version in its own read-only folder and switches with one link.** wasitme installs
  into `~/.wasitme/versions/<version>` and points `~/.wasitme/current` at it; the command, the Claude Code plugin
  (registered at `current`) and the Codex plugin all go through that link, so an update or a rollback moves them
  together. Updating the Claude Code plugin never uninstalls it (your plugin options survive): run `/reload-plugins` in
  open sessions afterwards. The background scan runs every 15 minutes under Node's permission sandbox, setup writes the
  plugin's glance path for you and shows exactly what the in-session part may call, `engine.json` is private to you
  (0600), and Linux gets the command and plugins without a background scan. Installing from a local checkout
  (`npm run build && sh scripts/install.sh --from .`) warns when the checkout's built engine is older than its
  sources.
