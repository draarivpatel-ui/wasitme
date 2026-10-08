### wasitme report: your side changed (Claude Code)

`■──` **Your side.** Your numbers moved around the time of your model change from m1 to m2 (Sep 24).

Tool errors (×2.4) and edits without reading first (×1.7) rose; nothing recorded changed on Claude Code's side in the same window.

Based on 168 exchanges over 168 session-days (168 sessions) on this Mac. Sessions on other machines aren't visible.

_One person’s logs on one Mac. These indicators don't measure answer quality. Evidence, not proof._

**What was checked**

| checked | what wasitme found |
|---|---|
| Your setup | 1 change recorded on your side: Model m1 → m2 (Sep 24). |
| Workload | No sign that your work changed between the windows (project mix, prompt length, long-context share and more). |
| The shift | Starts between Sep 21 and Sep 27. Lines up with: Model m1 → m2. |
| Sample | 168 exchanges, 168 session-days, 168 sessions (both windows). |
| Not visible | Sessions on other machines aren't visible. Some days weren't fully observed. 0 of 7 days in the onset window were fully observed. |

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

- Sep 24  ■1  Model m1 → m2 (lines up with the shift)

**How wasitme decided**

- Findings for Claude Code are calibrated: wasitme's tests pass for Claude Code logs.
- Each kind of indicator has one with enough data.
- No indicators moved in opposite directions.
- The shift holds when your projects and setup are compared like with like.
- Every change in the onset window has a known side.
- Nothing on the agent's side but routine updates is in the onset window.
- Your model change from m1 to m2 (Sep 24) falls in the onset window and wasn't ruled out; on the agent's side there are only routine updates. (this decided it)

**Next:** To check, switch the model back to m1.

<sub>Generated locally by wasitme 0.1.0 on Oct 4 · numbers only: no prompts, code or paths · method: docs/METHOD.md</sub>
