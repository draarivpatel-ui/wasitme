- **The Claude Code plugin draws the design system's case line, and `/wasitme:report` runs the installed engine.**
  `/wasitme` opens a pane with the buttons first, then (timeline-led by default) what changed: your changes on numbered
  canary stickers above a dashed rule, the agent's on lettered blue stickers below it, with each day's counts under
  it; then the Finding with its state glyph, what is still missing (never a projected date) and the signals. The
  report skill runs the plugin's own `scripts/run.sh`, which uses only the absolute engine the installer recorded
  (never a `wasitme` found on PATH) and prints one plain line when wasitme is not installed. The mod's frozen list of
  calls is fixed at ten.
