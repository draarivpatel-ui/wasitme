- **The installer's download URL comes from `--url` or its stamped release, never from the environment.** An
  undocumented `WASITME_TARBALL_URL` variable could point a released `install.sh` at another tarball, which then skipped
  the stamped SHA-256 check without a word. The variable is gone, and `--url` without `--sha256` on a released installer
  now says that no checksum is being checked and how to pass one.
