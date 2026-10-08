- **The report works inside sandboxes that block reading the system uptime.** In Codex's macOS workspace-write
  sandbox the scan lock used to fail with "report failed (internal)"; it now judges a leftover lock by its holder's
  process alone when uptime is unavailable.
