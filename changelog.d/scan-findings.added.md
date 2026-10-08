- **`wasitme scan` writes findings.** Each scan runs the attribution table and the engine's own words for every agent
  and writes glance.json and snapshot.json from them, in the layout set by `lead` in engine.json (timeline first unless
  it says `verdict`). An agent whose calibration did not pass would show "Timeline only", without the numbers on the
  snapshot. A new outcome is held until a later scan with fresh data confirms it; that state lives in
  `~/.wasitme/state/decisions.json` (numbers and ids only). If the finished files would break the published format,
  nothing is written and the last good files stay, marked as a failed scan.
