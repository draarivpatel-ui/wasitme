- **Sessions moved into a git worktree stay with their project.** When Claude Code moves a session's log into a
  worktree's folder, wasitme keeps counting it under the project it started in, counts the work from before the move
  once, and does not report the move's marker as an unknown log format.
