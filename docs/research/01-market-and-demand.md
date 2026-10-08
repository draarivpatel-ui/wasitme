# Research synthesis — 2026-10-04

Five Sonnet research agents + local checks. Key claims marked ✓ were re-checked by hand
(GitHub API, HN API, npm API, official docs). Everything else is the agents' sourced claim.

## Verdict

**Worth building, but not as the original spec, and not as a quick money-maker.**
Demand is real and loud; payment evidence is absent; the space is filling up fast.

## Demand — real, but tied to evidence

- ✓ anthropics/claude-code#42796 (2026-04-02, 583 comments, HN 1,364 pts) is a user's before-and-after analysis:
  thousands of local session logs mined by hand for read:edit ratio, interrupts, stop-hook violations.
  **That is exactly the fitness-tracker metric set, done by hand** — and it's the most-engaged
  artifact in the whole space. Anthropic responded and published a postmortem.
- ✓ Anthropic's April 23 postmortem thread: HN 942 pts. Causes were harness-level
  (effort default, thinking-cache bug, verbosity prompt) — invisible locally except "version changed".
- "Is it just me?" Ask HN posts with no data get 2-3 points. **The question only gets attention when
  backed by data.**
- Counter-evidence: placebo/vibes claims are common; small-n trackers get torn apart on noise
  (a viral "67% drop" was 6 tasks vs 30).
- A counts-only check of one real setup's logs: per-day correction/interrupt counts are in the single digits → too
  noisy for one user day-to-day. Signals need pooling across many sessions or many users.

## Competition (fast-moving — new repos weekly)

| Layer | State |
|---|---|
| Cost/usage tracking | Solved & free. ✓ ccusage 18.9k★, 544k npm downloads/month; ✓ codeburn 11.3k★ (also flags unused MCP / oversized config) |
| Synthetic "is it nerfed" benchmarks | Crowded. ✓ livenerf 1,241★ in 12 days; MarginLab daily SWE-Bench-Pro tracker |
| Config checkup (L1) | ✓ **Claude Code ships `/doctor`** (unused skills/MCP vs context cost, slow hooks) and `/insights` (session report incl. "where things go wrong"). Linters have ~0 traction. |
| Personal quality tracker (L2) | Thin: inspecto (0★), claude-session-analyzer (15★) |
| Real crowd telemetry (L3) | Nobody. ✓ nerf-watch (created 2026-10-03, 0★) reads Claude+Codex logs, version-correlates, menu bar, opt-in share via GitHub issues — closest rival, no config tracking, no behavioural signals |

**Open gap:** "Did *my* change help or hurt — or was it the vendor?" across tools, with evidence
good enough to post. Window: weeks, not months.

## Feasibility

- Easy: Claude Code (JSONL), Codex (JSONL, clean `turn_aborted`), OpenCode (SQLite).
  Medium: Cursor, Copilot (OTel route), Gemini CLI. Hard: Windsurf, Aider.
- No format is documented or stable. Claude Code deletes transcripts after 30 days by default
  (`cleanupPeriodDays`) → must ingest continuously.
- Claude Code log gotcha: usage repeats across lines of one response → dedupe by `requestId`
  (~2.3x inflation otherwise). Subagent files exist and are easy to miss.
- Mods (Claude Code v2.1.287+): live panes, bands, toasts in terminal + desktop. No Codex equivalent.
- No study validates correction-rate as a quality measure. Treat raw counts as indicators,
  compare within-user over time, never call it a "quality score" without evidence.

## Money & costs

- Individuals pay ~$5/mo or ~$35-50 once for polished personal tools; analogues (ccusage) live on
  sponsorship. Teams pay $29-60/seat but need sales/SSO. **No evidence anyone pays for this specific thing.**
- $0 infra: Cloudflare Workers (100k req/day) + D1 (100k writes/day) fits ~10k daily contributors.
- Apple Developer Program $99/yr for a smooth menu bar app; Homebrew casks must pass Gatekeeper.
  Claude Code plugin marketplace: free (a git repo).
- Any data collection needs a privacy policy.

## Recommended direction

1. **Wedge = one command that produces an evidence report like #42796's** from your own logs:
   what changed (Claude Code version, model, effort, config files, MCP/skills) and how your
   sessions behaved before vs after — with honest noise bands. Shareable (that's the growth loop:
   every report posted on GitHub/HN carries the tool's name).
2. Cross-tool from the design up; ship Claude Code + Codex first (both easy), then OpenCode, Cursor.
3. Surfaces: Claude Code plugin/mod first ($0), status line; menu bar app later ($99 gate).
4. Network (L3) later, fed by opt-in report summaries, once single-player value exists.
5. Don't compete on cost tracking, benchmarks, or static linting.
6. Money: plan for open-source + sponsorship/credibility first; test paid Pro/team demand by talking
   to real users before building any paid tier.

## Sources (selected)
- https://github.com/anthropics/claude-code/issues/42796
- https://www.anthropic.com/engineering/april-23-postmortem
- https://hn.algolia.com/api/v1/items/47878905
- https://github.com/Abelo9996/nerf-watch
- https://github.com/ninjahawk/livenerf
- https://marginlab.ai/trackers/claude-code
- https://github.com/ryoppippi/ccusage , https://github.com/getagentseal/codeburn
- https://github.com/rahulbhardwaj94/inspecto
- https://code.claude.com/docs/en/commands (`/doctor`, `/insights`)
- https://code.claude.com/docs/en/monitoring-usage
- https://code.claude.com/docs/en/plugins/mods/overview
- https://dev.to/tznthou/parsing-claude-codes-jsonl-patterns-for-a-schema-that-keeps-moving-2dcj
- https://developers.cloudflare.com/workers/platform/limits/ , https://developers.cloudflare.com/d1/platform/pricing/
- https://developer.apple.com/programs/whats-included/
- https://github.com/clacky-ai/openclacky (Clacky inspiration: one hero metric, public telemetry page)
