- **A token-shaped value in a Claude Code log's model field is kept as "other".** The Claude Code reader kept any
  lowercase id that fit the model shape, so a key pasted where a model name goes (one that happened to be lowercase)
  could be stored as a model label and shown as a model change. It now applies the same token check as the Codex
  reader and the config collector. A label stored by an earlier scan is never shown either: reports and snapshot fields
  refuse token-shaped values themselves (the snapshot's setup leaves such a model out), and change events are
  re-derived from the logs that still exist.
