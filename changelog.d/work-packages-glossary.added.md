- **A public glossary of the `WP-##` ids that code comments cite.** `docs/WORK-PACKAGES.md` has one row per work-package
  id a shipped file mentions, saying in plain words which part of the code it names (the store and scan pipeline, the
  attribution layer, the installer, and so on), linked from `CONTRIBUTING.md` and `AGENTS.md`. A repository test keeps
  it complete: every id cited in a shipped file must have a row, and every row must still be cited.
