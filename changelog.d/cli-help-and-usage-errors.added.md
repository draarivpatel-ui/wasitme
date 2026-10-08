- **`--help` works after any command, and usage errors say what to type instead.** `wasitme report --help` (or `-h`,
  after any command) prints the usage and exits 0 instead of failing as an unknown option; `-v` prints the version like
  `--version`; an unknown command is named when it is a plain word (`unknown command "repot"`); `--agent` with an agent
  that is not in the results lists the ones that are; and `statusline install` without the status-line script says that
  the installer puts it in place.
