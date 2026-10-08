- **Open-source repository files and automated checks.** MIT `LICENSE`, `SECURITY.md` (a real threat model and how to
  report a vulnerability), `CONTRIBUTING.md`, `AGENTS.md` (the short rules for contributors and AI coding agents), a Code
  of Conduct, third-party credits, issue and pull-request templates, and GitHub Actions workflows for CI and a
  draft-only release. Dependency-free scripts guard the project's promises: `check-no-network` (engine code cannot use
  the network or pull in dependencies, and may start another program only at two marked places with fixed arguments),
  `check-privacy` (fails if a planted canary string leaks into any output), `check-repo` (home paths, forbidden
  e-mail addresses, remote assets) and `assemble-changelog` (the changelog-fragment system you are reading).
  `scripts/dev/export-public.sh` builds the public tree as one fresh commit with a noreply identity.
