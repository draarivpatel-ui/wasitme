- **`--dry-run` now says when a planned part would fail.** A dry run that already ran into a refusal while planning (for
  example a menu bar agent plist that the installer did not write) exited with status 3, yet its summary listed only the
  parts it was not going to install and ended with "The [dry-run] lines above are exactly what a real run would do". It
  now lists each part that would fail under "Would fail" and says that a real run would fail there too and roll that
  part back on its own.
