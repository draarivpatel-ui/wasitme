- **A skills-only Codex plugin, `wasitme@wasitme-codex`.** It lives in its own marketplace root (`plugin-codex/`) with
  no hooks, and its one skill runs the installed wasitme's report for Codex. It needs the full install. Both of its
  manifests are generated from one source with the engine's version, and updates re-register the marketplace, because
  Codex records the resolved folder rather than the `current` link.
