- **The installer refuses symbolic links in every file it copies into a version folder.** The plugin folders were
  already checked; the install scripts (`scripts/install.sh`, `scripts/uninstall.sh`, `scripts/lib/`), `LICENSE` and
  `engine/package.json` were copied as they came. A link there would have been run again later by the uninstaller or
  `--repair`, pointing wherever the source said. Now the install stops before anything is written.
