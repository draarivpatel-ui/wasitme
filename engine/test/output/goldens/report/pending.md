### wasitme report: no detectable change (Claude Code)

`───` **No detectable change.** Changes bigger than about ×1.4 in 3 indicators would have shown.

wasitme compared tool errors, reads per edit and edits without reading first over your last 14 days against the 28 before.

Based on 168 exchanges over 168 session-days (168 sessions) on this Mac. Sessions on other machines aren't visible.

_One person’s logs on one Mac. These indicators don't measure answer quality. Evidence, not proof._

**What was checked**

| checked | what wasitme found |
|---|---|
| Your setup | 1 change recorded on your side: Model m1 → m2 (Sep 24). |
| Workload | No sign that your work changed between the windows (project mix, prompt length, long-context share and more). |
| The shift | No shift met wasitme's rule for a change. |
| Sample | 168 exchanges, 168 session-days, 168 sessions (both windows). |
| Not visible | Sessions on other machines aren't visible. |

**What moved (recent Sep 20 – Oct 3 against Aug 23 – Sep 19)**

| signal | recent | before | change | range | status |
|---|---:|---:|---:|---|---|
| Tool errors (context) | 272 / 2,800 | 224 / 5,600 | ×2.43 | ×1.93–×3.05 | context |
| Tool errors (excl. commands) | 272 / 2,800 | 224 / 5,600 | ×2.43 | ×1.93–×3.05 | moved, more |
| Reads per edit | 2,240 / 1,120 | 4,480 / 2,240 | ×1.00 | ×0.93–×1.08 | not detected |
| Edits without reading first | 192 / 1,120 | 224 / 2,240 | ×1.71 | ×1.35–×2.18 | moved, more |
| Interruptions (context) | 0 / 56 | 0 / 112 |  |  | context: only 0 in the recent window |
| Pushback prompts (context) | 0 / 56 | 0 / 112 |  |  | context: prompts are not in English |
| Files edited 3+ times (context) | 0 / 56 | 0 / 112 |  |  | context: only 0 in the recent window |

Counts are events / opportunities per window. Range: where the ratio could be at this volume (see docs/METHOD.md). “Not detected” means any change was too small to show at this volume. At this volume, changes under ×1.1 in reads per edit might not show.

**Tool errors (excl. commands) per day, last 14 days**

```text
           Sep 20                      Sep 27
errors        8   8   8   8  24  24  24  24  24  24  24  24  24  24
tool calls  200 200 200 200 200 200 200 200 200 200 200 200 200 200
                             ■1
```

**Timeline (■ your side, ▲ Claude Code, ? origin unknown)**

- Sep 24  ■1  Model m1 → m2

**How wasitme decided**

- Findings for Claude Code are calibrated: wasitme's tests pass for Claude Code logs.
- Each kind of indicator has one with enough data.
- No indicators moved in opposite directions.
- Not a change by wasitme's rule, which needs indicators of 2 kinds moving the same way.
- No indicator moved on its own.
- Nothing moved, and each kind of indicator would have shown a change bigger than about ×1.4. (this decided it)

<sub>Generated locally by wasitme 0.1.0 on Oct 4 · numbers only: no prompts, code or paths · method: docs/METHOD.md</sub>
