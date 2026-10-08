- **`scripts/ci-local.sh` can check the Mac app's memory budgets.** The new `app-capture` step builds the app in release
  mode, runs its offscreen capture against the contract fixtures and the canvas, and fails when a memory budget is over,
  when a capture check fails, or when no enforced budget was reported. It takes minutes, so it is opt-in (`--capture`,
  `CI_LOCAL_CAPTURE=1` or `--only app-capture`) and macOS-only; otherwise it is listed as skipped.
