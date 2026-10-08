### wasitme report: no detectable change (Claude Code)

`───` **No detectable change.** Changes bigger than about ×1.5 in 3 indicators would have shown.

wasitme compared tool errors, reads per edit and edits without reading first over your last 14 days against the 28 before.

Based on 168 exchanges over 168 session-days (168 sessions) on this Mac. Sessions on other machines aren't visible.

_One person’s logs on one Mac. These indicators don't measure answer quality. Evidence, not proof._

**What was checked**

| checked | what wasitme found |
|---|---|
| Your setup | Nothing recorded changed on your side in the windows compared. |
| Workload | No sign that your work changed between the windows (project mix, prompt length, long-context share and more). |
| The shift | No shift met wasitme's rule for a change. |
| Sample | 168 exchanges, 168 session-days, 168 sessions (both windows). |
| Not visible | Sessions on other machines aren't visible. |

**What moved (recent Sep 20 – Oct 3 against Aug 23 – Sep 19)**

| signal | recent | before | change | range | status |
|---|---:|---:|---:|---|---|
| Tool errors (context) | 112 / 2,800 | 224 / 5,600 | ×1.00 | ×0.74–×1.35 | context |
| Tool errors (excl. commands) | 112 / 2,800 | 224 / 5,600 | ×1.00 | ×0.74–×1.35 | not detected |
| Reads per edit | 2,240 / 1,120 | 4,480 / 2,240 | ×1.00 | ×0.93–×1.08 | not detected |
| Edits without reading first | 112 / 1,120 | 224 / 2,240 | ×1.00 | ×0.75–×1.34 | not detected |
| Interruptions (context) | 0 / 56 | 0 / 112 |  |  | context: only 0 in the recent window |
| Pushback prompts (context) | 0 / 56 | 0 / 112 |  |  | context: prompts are not in English |
| Files edited 3+ times (context) | 0 / 56 | 0 / 112 |  |  | context: only 0 in the recent window |

Counts are events / opportunities per window. Range: where the ratio could be at this volume (see docs/METHOD.md). “Not detected” means any change was too small to show at this volume. At this volume, changes under ×1.5 in tool errors might not show.

**Tool errors (excl. commands) per day, last 14 days**

```text
           Sep 20                      Sep 27
errors        8   8   8   8   8   8   8   8   8   8   8   8   8   8
tool calls  200 200 200 200 200 200 200 200 200 200 200 200 200 200
```

**How wasitme decided**

- Findings for Claude Code are calibrated: wasitme's tests pass for Claude Code logs.
- Each kind of indicator has one with enough data.
- No indicators moved in opposite directions.
- Not a change by wasitme's rule, which needs indicators of 2 kinds moving the same way.
- No indicator moved on its own.
- Nothing moved, and each kind of indicator would have shown a change bigger than about ×1.5. (this decided it)

<sub>Generated locally by wasitme 0.1.0 on Oct 4 · numbers only: no prompts, code or paths · method: docs/METHOD.md</sub>
