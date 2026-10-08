# Fresh checks, 2026-10-04 (GPT-6 Luna ×3, GPT-6.1 Sol ×1, public web only)

Codex output is UNVERIFIED data. Each item says what it changes for us and which work package owns it.

## Claude Code changelog (latest 2.1.289; the changelog has no dates)
- **2.1.288 fixed transcripts that were truncated or dropped their last response during concurrent rewrites.**
  - This means transcript files are not always append-only. Older files on disk can still be truncated.
  - **WP-12:** the cache fingerprint must detect a shrunk or rewritten file and re-parse it in full, never resume from a stale offset.
  - **Readers:** keep the `truncatedTail` handling.
- **2.1.289 adds `agent.spawn` and agent identity across plugin hook events.** This is context for WP-60 hooks. No action unless S-INST shows the hook payload changed.
- Luna found no documented change to the transcript JSONL, `requestId`/usage fields, or hook names in 2.1.270–2.1.289. Undocumented changes remain possible, so the acceptance suites stay the guard.

## Codex (latest release found: 0.162.0-alpha.13, 2026-10-04; release notes thin)
- **OpenAI's Claude-plugin migration guidance says not to rely on `.claude-plugin/marketplace.json`.**
  - Our local test showed Codex 0.160 reads it, but that is undocumented behaviour.
  - This confirms D32: Codex gets its own `.codex-plugin` root (WP-61). Never ship Codex support that depends on the Claude marketplace file.
- Non-managed plugin hooks need user trust (already in the plan). The rollout format and `--ephemeral` had no documented versioned changes.

## Competitors since 2026-08-01
- **CodeBurn** (already tracked in research/01, 04, 05) shipped desktop v0.9.25 on 2026-09-21. Its quality-adjacent metrics:
  - one-shot rate and retries;
  - self-correction;
  - cost per edit;
  - committed vs abandoned work.
  - It is still a cost tracker with no before/after attribution.
- **staxtrace** (MIT, Rust, 2 stars, v1.0.0 on 2026-08-24) covers 20 providers. Its metrics are one-shot/retry, cost, cache hit, and productive/reverted/abandoned sessions. No attribution.
- **Positioning stands:** no known tool answers "my setup or the agent?" with calibrated uncertainty.
- **Public complaint themes**, useful for copy and for which metrics we surface first:
  - more tokens and time for the same task;
  - more wrong assumptions and repeated corrections;
  - tool calls that hang.

## Statistics method check (Sol, with citations)
Our stats code already implements a real CR2: a leverage correction plus Bell–McCaffrey df, not just a scalar K/(K−1). It also calibrates "count" against "cr2" (D29). Sol's points that add to the plan:
1. **Calibration candidate (WP-23):** a null-imposed, studentized wild cluster bootstrap with Webb six-point weights, as a sensitivity or alternative. Sources: MacKinnon & Webb 2017/2020; Webb 2023; MacKinnon, Nielsen & Webb 2023.
2. **Randomization inference:** permuting before/after labels needs an exchangeability argument that a chronological split does not supply. Keep `permutation.ts` as a diagnostic only.
3. **Dominant-cluster guard (WP-20b):** leave-one-cluster-out estimates and each cluster's share of tool calls, on top of D23's "largest session < 50%".
4. **Degrees-of-freedom floor:** small-sample t approximations degrade below roughly 4–5 effective df (Pustejovsky & Tipton 2018). That is a diagnostic boundary, not a guarantee. When effective df is below 4, calibration reports the result as `insufficient`.
5. **MDE (WP-20a/20b):** `exp((t.995 + t.80)·SE)` is a planning approximation.
   - Under Holm across 3 voting metrics, the conservative single-metric critical value is t at 1 − 0.01/6.
   - Holm-adjusted p-values with plain 99% intervals are not simultaneous 99% intervals. The copy already says "range", never "99%" (D31).
   - Whether to use the Holm-adjusted critical value in the ETA is decided by calibration (WP-23).
6. **Pseudo-count sensitivity:** the +0.5 continuity correction can move sparse results. Calibration includes sparse-failure profiles and a pseudo-count sensitivity run.
