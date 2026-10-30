- **Read-only and `--until` reports leave out the projects you excluded.** `wasitme exclude add <project folder>`
  stores the project's id made with your local salt, but read-only runs (`--read-only`, `--until`, the plugin-only
  report) use a throwaway salt, so an excluded project was still counted there. They now read the stored salt only to
  recognise the excluded projects; their own ids stay throwaway, and they still never create, write or change any file
  (reading the salt no longer tightens its permissions either: only a normal scan does that). Without a stored salt
  (wasitme never scanned here) project exclusions cannot apply; date and entry-point exclusions always do.
