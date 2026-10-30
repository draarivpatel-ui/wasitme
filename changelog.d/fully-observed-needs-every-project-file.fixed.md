- **A day counts as fully observed only when every project file was actually read.** Attribution by elimination ("the
  agent changed, because nothing on your side did") needs every day around the change to be fully observed. A
  session-start snapshot that could not read one project file (a symlinked `CLAUDE.md`, a denied or half-written file)
  still counted as long as it saw some other file, so a change in the unread file was invisible yet ruled out. Now each
  of the six project files must be read definitively (absent, or present and hashed); a file that is unreadable or too
  large to hash leaves that session's day partially observed. Changes in the files that were read still show on the
  timeline. Projects with a symlinked instruction file will see more days marked "not fully observed".
  Verdicts saved by an earlier version are worked out again on the first scan after the update, for both agents, so
  a verdict held from the looser rule does not stay on screen.
