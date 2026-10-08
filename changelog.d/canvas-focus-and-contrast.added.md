- **The Control Center's keyboard focus ring shows on every control, and dimmed markers stay readable in dark mode.**
  The focus ring on the sidebar's page buttons and on the agent switcher was clipped by the sidebar (only its top and
  bottom, or one side, showed); it is now drawn inside those buttons, light on the selected segment. In the stale
  "last known" state on the dark theme, a marker's letter was near-black on a dark tint (1.2:1); it is now muted ink
  (5.0:1 or better in both themes). The wordmark is read as one word, "wasitme". `ui/test/a11y.mjs` checks the
  accessibility tree Chrome exposes, the contrast of every text run as rendered, the focus ring's pixels and motion.
