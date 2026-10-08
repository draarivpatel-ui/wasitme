- **A project cannot choose what Node runs inside the plugin's hooks and report skill.** A project can set environment
  variables for its Claude Code sessions, so both scripts drop the variables Node reads at startup (`NODE_OPTIONS`,
  `NODE_PATH` and the rest) before Node starts: a `--require <file>` there never runs inside wasitme's Node, and an
  `--allow-fs-write` there never widens the hook's sandbox. When the recorded Node has moved, the report skill never
  takes a `node` from inside the session's folder on `PATH`.
