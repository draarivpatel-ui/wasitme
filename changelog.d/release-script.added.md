- **Release assets that match what the installer downloads.** `scripts/release.sh` builds `wasitme-<version>.tgz` from a
  commit with the engine and the Control Center page already built (installing it runs no npm and downloads nothing),
  writes the same bytes as `wasitme.tar.gz` (the name `install.sh` downloads by default), an `install.sh` asset with
  that tarball's address and SHA-256 built in, and `SHA256SUMS`. It refuses a tarball with anything outside the
  published file list, a home path or a private address in it, then installs it into a throwaway home, uses it and
  uninstalls it again. It never publishes anything; the release workflow runs it with `--strict`.
