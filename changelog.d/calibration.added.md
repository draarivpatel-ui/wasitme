- **Findings are on for Claude Code and for Codex.** wasitme's own tests passed for both agents, on synthetic logs only
  (`docs/calibration/2026-10-05.json`): in each of seven profiles, 1,000 users whose setup and agent did not change in
  effect were followed for 90 daily evaluations, and none ever saw a false change or a false agent-side finding (95%
  upper bound 0.37%, against limits of 6% and 2%). So a new install shows "Too early to tell", with what is still
  missing, rather than "Timeline only". Power is low for people with a few very long sessions, sparse failures, or
  Codex (a planted doubling was found in 7 to 10 of 40 runs, against 34 to 39 of 40 for many short sessions). Not yet
  measured: how often the rules misfire on real logs, the coverage of the printed range, and the attribution limits
  on the final decider (`docs/METHOD.md`).
