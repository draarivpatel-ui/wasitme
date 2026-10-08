### wasitme report: too early to tell (Claude Code)

`·┄·` **Too early to tell.** One indicator moved (tool errors ×2.4); a second kind has to agree.

The move in tool errors holds up with all the indicators checked together; reads per edit and edits without reading first show no detectable change.

Based on 168 exchanges over 168 session-days (168 sessions) on this Mac. Sessions on other machines aren't visible.

_One person’s logs on one Mac. These indicators don't measure answer quality. Evidence, not proof._

**What was checked**

| checked | what wasitme found |
|---|---|
| Your setup | Nothing recorded changed on your side in the windows compared. |
| Workload | No sign that your work changed between the windows (project mix, prompt length, long-context share and more). |
| Sample | 168 exchanges, 168 session-days, 168 sessions (both windows). |
| Not visible | Sessions on other machines aren't visible. |

**What moved (recent Sep 20 – Oct 3 against Aug 23 – Sep 19)**

| signal | recent | before | change | range | status |
|---|---:|---:|---:|---|---|
| Tool errors (context) | 272 / 2,800 | 224 / 5,600 | ×2.43 | ×1.93–×3.05 | context |
| Tool errors (excl. commands) | 272 / 2,800 | 224 / 5,600 | ×2.43 | ×1.93–×3.05 | moved, more |
| Reads per edit | 2,240 / 1,120 | 4,480 / 2,240 | ×1.00 | ×0.93–×1.08 | not detected |
| Edits without reading first | 112 / 1,120 | 224 / 2,240 | ×1.00 | ×0.75–×1.34 | not detected |
| Interruptions (context) | 0 / 56 | 0 / 112 |  |  | context: only 0 in the recent window |
| Pushback prompts (context) | 0 / 56 | 0 / 112 |  |  | context: prompts are not in English |
| Files edited 3+ times (context) | 0 / 56 | 0 / 112 |  |  | context: only 0 in the recent window |

Counts are events / opportunities per window. Range: where the ratio could be at this volume (see docs/METHOD.md). “Not detected” means any change was too small to show at this volume. At this volume, changes under ×1.1 in reads per edit might not show.

**Tool errors (excl. commands) per day, last 14 days**

```text
           Sep 20                      Sep 27
errors        8   8   8   8  24  24  24  24  24  24  24  24  24  24
tool calls  200 200 200 200 200 200 200 200 200 200 200 200 200 200
```

**How wasitme decided**

- Findings for Claude Code are calibrated: wasitme's tests pass for Claude Code logs.
- Each kind of indicator has one with enough data.
- No indicators moved in opposite directions.
- Not a change by wasitme's rule, which needs indicators of 2 kinds moving the same way.
- Exactly one indicator moved (tool errors ×2.4), and it stands out even with all the indicators checked together. (this decided it)

**Next:** Keep working normally; wasitme checks every 15 minutes.

<sub>Generated locally by wasitme 0.1.0 on Oct 4 · numbers only: no prompts, code or paths · method: docs/METHOD.md</sub>
