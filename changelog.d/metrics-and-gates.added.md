- **Metrics and minimum-data gates for the health check.** The engine turns exchanges into per-session-day
  totals for every indicator (tool errors, reads per edit, edits without reading first, interruptions, pushback and
  context counts), compares the last two, three or four weeks of complete days with the weeks before, and only
  reports a comparison when both windows hold enough independent evidence. Only sessions you drive yourself count:
  scripted runs (`codex exec`, print mode, the Agent SDK) and threads another agent started are left out. When
  there is not enough data yet, it says what is still missing as counts ("31 of 40 edits so far") and gives no
  date: its date estimates failed their own accuracy test for people with a few very long sessions.
