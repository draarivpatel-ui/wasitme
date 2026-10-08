# wasitme design system: Case File, final

This folder is the brand guide and the single source for every surface. `tokens.json` is the only place a
colour, size, font, glyph, label or VoiceOver string is defined. Everything else is generated from it or
built only from what it generates.

Every image in `screens/` is a mockup made from **analytic demo data** (`demo-data.v3.json`) and says so in
its footer, with the version: "demo data v3 (analytic) — not engine output". For rendering, v3 supersedes
`design/demo-data.v2.json` (which D21 names); every number that changed is listed in §11. README and launch
images must be re-rendered from `wasitme demo` engine output before release (DECISIONS D21).

---

## 1. Concept

**Case File** (D44). wasitme keeps a calm case file on your setup: what changed, on which side, and what the
numbers did around it. It reads like a typed form with an editor's finding on top.

Everything hangs on one device: **the case line**, a rule between the two sides.

- **Your side sits above the line.** Your changes are canary-yellow square stickers, numbered 1, 2, 3.
- **The agent's side hangs below it.** Its updates are blue pointed tags, lettered A, B, C.
- **The finding sits on its side of the line.**
  - A your-side finding is set above it.
  - An agent-side finding is set below it.
  - A finding that names neither side comes before both.

The same line is the menu-bar glyph, the hero of the Finding page, the axis of every chart, the mod pane's
timeline and the CLI's. If you learn it once, you can read every surface.

Party is encoded four ways at once, so no single channel carries meaning alone:

| Channel | Your side | The agent's side |
|---|---|---|
| Colour | canary | blue |
| Shape | square | triangle / pointed tag |
| Label | numbered | lettered |
| Position | above the line | below the line |

The one bold thing is the pair of stickers. Everything around them is paper, ink and hairlines, so the yellow
and the blue mean something every time they appear. There is no red and no green anywhere: `you` and `agent`
are answers, not good or bad.

---

## 2. What changed from the judged v2 (D44 checklist)

| D44 item | Done | Where |
|---|---|---|
| (1) Glyphs: you/agent not mirror images; none/unclear unambiguous; mark distinct; no toggle/info look-alikes | Done. New grammar: a square above the rule for you, a triangle below it for the agent, a bare rule for none, both shapes for unclear. Measured at true 1× (§6). | `glyphs/`, `screens/menubar-glyphs-*.png` |
| (2) Neutral vocabulary | Done. No exhibits, no suspects, no "likely cause". The code lints copy against a banned list. | §3, `tokens.json` copy.banned |
| (3) One harmonized type system, OFL, embedded woff2 | Done. IBM Plex Serif + IBM Plex Mono, one superfamily with identical vertical metrics. | §4, `fonts/` |
| (4) Banned copy | Done. "Nothing leaves your Mac" became the no-network line. "Nothing changed on your side" became "Nothing recorded changed on your side". "99%" became "range". Glance strings have no worse/better. | `gen/test.mjs` copy lint |
| (5a) Mirror graft: the finding sits on its side of the rule | Done | `cc-you`, `cc-agent`, the neutral states |
| (5b) Mirror graft: "What was checked" on shareable agent screens | Done | `cc-agent` side panel, `report-agent.md` |
| (5c) Mirror graft: "Moved, more / fewer" status words | Done | ledgers, CLI, report |
| (5d) Mirror graft: k / n rows under strips | Done | Finding pages, README hero, mod pane, CLI, report |
| (5e) Mirror graft: "Open as Markdown" | Done | Control Center top bar |
| (6) Tagline "Measure twice, blame once." | Done | README hero, `tokens.json` copy.tagline |
| (7) One tokens.json → Swift / CSS / ANSI / mod generators | Done, plus a contrast/CVD report and a test | `gen/` |

---

## 3. Voice and vocabulary

The voice is candid, precise, calm and a little wry. The wit lives in the tagline and the question, never in a
number or a finding. Lead with the finding, give every number its N, and name the next move. Errors say what
happened and how to fix it; they don't apologize.

### State vocabulary

There is one label per state, used on every surface (D22).

| State | Label (chips, glance) | Headline (Finding page, popover) |
|---|---|---|
| `insufficient` | Too early to tell | Too early to tell. |
| `none` | No detectable change | No detectable change. |
| `unclear` | Can't tell which | Can't tell which. |
| `you` | Your side | Your side changed. |
| `agent` | Agent side | The agent changed. |
| `stale` (display only) | Out of date | Out of date. |
| An agent whose calibration has not passed (none today: Claude Code and Codex both have, D69) | Timeline only | Timeline only, for now. |

The deck under each headline is the engine-owned sentence (D67), for example: "wasitme can already rule
out changes bigger than about ×2.5 in tool errors." The `none` deck uses the engine template: "Changes bigger
than about ×1.9 in 3 indicators would have shown."

The fixed disclaimer ends every `none`, `you` and `agent` body, verbatim: "These indicators don't measure answer
quality. Evidence, not proof." It closes the side panel on `cc-none`, `cc-you` and `cc-agent` (under "What was
checked"), the metric rows of the `none` and `you` popovers, and the finding paragraph of the evidence report. The
string is byte-identical in `tokens.json`, the demo data and the engine's `DISCLAIMER` (ASCII apostrophe), and the
test fails if any of these screens lacks it. Only the full sentence pair is exempt from the "quality" ban; the
engine's `lintCopy` splits on the same string.

The engine's **confidence line** (D59) is printed under the ledger of every Finding page with metrics, in the report,
and in the CLI: "Based on 1,195 exchanges over 87 session-days (24 sessions) on this Mac. Sessions on other machines
aren't visible." The demo numbers are both windows added together.

### Allowed and banned words

| Use | Instead of |
|---|---|
| finding | verdict (in the UI), ruling, judgment |
| change, update | exhibit, piece of evidence |
| candidate, "lines up with the shift" | suspect, likely cause, culprit, caused by |
| moved, more / moved, fewer | worse, better, degraded, improved |
| no detectable change, not detected | no change, nothing changed |
| range | 99%, confidence interval (in UI copy) |
| Nothing recorded changed on your side | Nothing changed on your side |
| No network code. Only the installer downloads, and only when you run it. / "local only" | Nothing leaves your Mac |
| evidence, not proof | proves, shows that |

Also banned: quality (except in the fixed disclaimer), score, dumber, smarter, nerf, "look(s) like", "after …
rose/fell/doubled", blame/guilty/accuse (except the tagline). The machine-readable list is
`tokens.json → copy.banned`. The test runs it over every screen, the report and the demo copy.

**Glance strings** carry only the state plus "+n" new changes. This applies to the menu bar, status line,
desktop panel, chips and VoiceOver. They never name a cause and never use a quality word
(`copy.glanceBanned`). The popover's "It feels worse…" button is a prompt for the user, not a
glance string, so it stays.

**Naming decision.** The engine and contract keep the word "verdict". The UI says **"Finding"**: the nav item,
the sticker and the Codex line ("Findings for Codex are off until…"). D57 made this the rule, and no string the
engine writes says "verdict" (D59).

The nav: Timeline, Finding, Compare, Setup, Report, Sources, Settings.

**Voice samples**

- Tagline: "Measure twice, blame once." (from On the Level, D44(6))
- The question: "Was it me, or the model?"
- Onboarding: "Before you file an issue, check your side." (marketing only)
- Empty: "No Claude Code or Codex logs found in ~/.claude or ~/.codex. Different place? ~/.local/bin/wasitme doctor"
- Error: "Last scan failed — see Sources." over the last good state

---

## 4. Type: one superfamily (D44(3))

| Role | Family | Where |
|---|---|---|
| The finding: headlines, decks, prose, navigation | **IBM Plex Serif** (Regular, Italic, Bold, Bold Italic) | App, report, README |
| The evidence: every number, date, version, count, button, sticker label | **IBM Plex Mono** (Regular, Bold) | App, report, README |
| Terminal surfaces | the user's own terminal font (mocks use Menlo) | CLI, mod pane, status line |
| Native controls | SF Pro, through the OS only | menus, window title |

**Why Plex.** v2 paired Newsreader with Courier Prime, and the judges marked it down as two unrelated families.
The fix is a serif and a mono drawn as one system, so a typed number sits on the same baseline and x-height as
the serif sentence around it. Checked with fontTools on the bundled files:

| | IBM Plex Serif | IBM Plex Mono |
|---|---|---|
| units per em | 1000 | 1000 |
| cap height | 698 | 698 |
| x-height | 516 (Bold 524) | 516 |
| ascender / descender | 1025 / −275 | 1025 / −275 |

Other options considered:

- **Source Serif 4 + Source Code Pro.** A real pair too, but the mono is a plain sans, so the typed-form
  voice is lost.
- **Libertinus Serif + Libertinus Mono.** The mono has only one weight.
- **Newsreader / Courier Prime.** Rejected: two systems, and Courier Prime has no `→` glyph.

Plex Mono's slab serifs on i, l and r keep the typewriter echo of Case File without screenplay kitsch.

Plex is common in developer tools, so it isn't distinctive by itself. The distinctiveness comes from the
stickers, the case line and the typed-form layout, not the typeface.

**Scale (px, size/line).** Every size is in `tokens.json` → type.scale.

| Style | Family | Size / line |
|---|---|---|
| README | serif | 84/88 |
| display | serif | 52/56 |
| title | serif | 30/36 |
| popTitle | serif | 26/31 |
| heading | serif Bold | 19/24 |
| deck | serif | 17/26 |
| body | serif | 15/23 |
| ui | serif | 14/21 (side panels, ledger signal names, timeline lanes, popover deck and metric rows) |
| note | serif Italic | 13/19 |
| wordmark | mono Bold | 18/22 (the live-text wordmark in the sidebar) |
| typedLg | mono Bold | 15/20 |
| typed | mono | 13/18 |
| typedSm | mono | 12/16 |

Rules:

- **Every font size is a scale size.** CSS reads `var(--type-<role>)`, `var(--type-<role>-size)` or
  `var(--type-<role>-line)`; there are no literal font sizes in `components.css` or the screen generators. Two checks
  enforce it: `test.mjs` scans the CSS statically, and `render.mjs` checks every rendered text run in the Wasitme
  families (size on the scale, serif ≥ 13 px, mono ≥ 12 px, no scale transforms). The mocks of other apps' type (the
  GitHub-style issue, the terminals) are exempt.
- Mono never goes below 12 px, serif never below 13 px, and stickers are never scaled down.
- Sentence case everywhere: no ALL-CAPS labels and no tracked eyebrows.
- Numbers read as data are mono: ledger columns, counts, dates in rows and on axes, ratios and ranges in tables,
  form fields, stickers. A number inside a serif sentence (a deck, a timeline label, a version in prose) stays in the
  sentence's serif; Plex Serif's lining figures share Plex Mono's height.
- Italic serif is the note style: side labels ("Your side", "Claude Code"), notes, footnotes and table column
  headers. Never headlines, decks or body copy.

**Licensing.** `fonts/OFL.txt` is the IBM Plex SIL OFL 1.1, which declares the Reserved Font Name "Plex".

- `fonts/app/*.ttf` are the unmodified upstream files, for bundling in the Mac app.
- `fonts/web/*.woff2` are subsets, which the OFL counts as Modified Versions. They are therefore renamed
  **Wasitme Serif / Wasitme Mono** (`fonts/MODIFICATIONS.txt`, built by `fonts/subset.py`). They total 87 KB for
  six files.
- Only these six upstream styles were available locally. Medium and SemiBold were not
  added: the system doesn't need them.

---

## 5. Colour

Exact values are in `tokens.json` → color.light / color.dark. Every pair a screen draws is in
`tokens.json` → contrast and is checked by `generated/contrast-report.md`.

| Token | Light | Dark |
|---|---|---|
| page / sheet / raised | `#F1F0EC` / `#FCFCFA` / `#FFFFFF` | `#131418` / `#1B1C21` / `#23242A` |
| ink primary / secondary / muted | `#1C1D21` / `#46474D` / `#5E5F64` | `#ECEBE6` / `#B9B8B2` / `#9C9B95` |
| you: fill / tint | `#F5C842` / `#FAF0D0` | `#F2C230` / `#332B14` |
| agent: fill / tint | `#8DBCF0` / `#E7EEFB` | `#8CC4F2` / `#182838` |

Rules:

- **Canary and blue are reserved for the two parties.** They appear only as fills: stickers, tags, the tint
  behind a moved number, and the wordmark's underline under "me".
- **Lines, glyphs and text are always ink.**
- **In light mode stickers carry a 1 px ink keyline**, because canary on paper is only 1.55:1. In dark mode
  the fills clear 3:1 on their own, so the keyline takes the fill colour.
- **The five states each have fg / bg / glyph / edge tokens.**
  - `none` is a solid ink chip, never green.
  - `insufficient` has a dashed pencil edge.
  - `stale` has a dotted edge.
  - `unclear` is literally both parties: a canary block and a blue block, then the words on paper.
- **Primary buttons, links and focus rings are ink.**

**Computed, not eyeballed** (`generated/contrast-report.md`): 214 contrast pairs and 12 colour-vision checks,
all passing.

| Check | Worst case | Value |
|---|---|---|
| Light text | ink.muted on selection | 4.91:1 |
| Dark text | ink.muted on selection | 4.86:1 (v2 failed this at 4.34; fixed) |
| Non-text | MDE hatch on its fill | 3.13:1 light, 3.28:1 dark |
| Colour vision (OKLab ×100, Machado 2009, severity 1.0) | dark protanopia, none vs agent | 14.0 (gate 8) |
| Normal vision | dark, none vs agent | 16.9 (gate 15) |

These CVD numbers reproduce v2's independent Python check: light tritanopia you vs agent comes out at 18.8 in
both.

**Terminals and other backgrounds** (`tokens.json` → terminal):

- **Stickers.** Truecolor uses the token fills; 256 colours use 221 (you) and 117 (agent) with black text
  (13.2:1 or better). **16 colours use reverse video (SGR 7) for both.** The palette is unknown in 16-colour mode,
  and common themes remap the bright colours: in Solarized, bright yellow and bright cyan are greys, so the old
  black-on-103 sticker measured 2.92:1 and the two stickers looked alike (normal-vision separation 13.1; Dracula
  14.3). Reverse video swaps the theme's own foreground and background, so a sticker always has the theme's
  contrast. In 16 colours your stickers and the agent's look the same; the numeral vs letter, above vs below the
  line and the words carry the party. Who reaches 16-colour mode: `TERM` without `256color` and no
  `COLORTERM=truecolor` (default tmux/screen setups, the Linux console).
- **Muted text and rules use explicit greys, not dim.** SGR 2 (dim) is drawn differently by every terminal, and a
  50% blend falls under 4.5:1. 256 colours use 246 / 243 (dark) and 242 / 244 (light); truecolor uses
  `terminal.sgr.truecolor` (`#9C9B95` / `#74757B` dark, the same values as `ink.muted` and `chart.mdeHatch`, `#66676B` / `#85868A` light). Each grey is gated against
  every declared background of its mode (report section "terminal greys"; worst 3.30:1 for a rule, 4.98:1 for text).
  **Only 16-colour mode still uses dim**, because no grey is safe without the palette; how each terminal draws it
  is not checked.
- **Mode guess.** `chooseMode` picks the dark greys unless `COLORFGBG` says the background is light. A light
  terminal that doesn't set `COLORFGBG` gets the dark greys (about 3:1 on white). This risk is the same as before
  for 256 colours.
- **Assumed backgrounds.** The Claude Desktop Code-tab backgrounds (`#FAF9F5` light, `#262624` dark) are
  **assumed, not captured**. The report labels them that way.
- **Palettes.** `terminal.palettes16` (xterm, Terminal.app "Basic", Windows Terminal "Campbell") now only draws the
  16-colour mockup; no 16-colour output uses a palette entry. The Terminal.app values came from a secondary web
  source; none were re-checked in the apps.
- **The mod pane's `ansi` theme** still names `yellowBright` / `cyanBright`, so it has the same palette risk. Use
  `inverse` there if the mod kit's Text supports it (not verified for this build).
- **Dim in the mod pane.** `dimColor` is drawn by Claude Code and is not checked. No screen dims text with opacity;
  the test fails if one does.

---

## 6. Glyphs

| State | Glyph | Legend line | VoiceOver |
|---|---|---|---|
| insufficient | dashed rule, two specks | Dashed rule, two specks: too early to tell | "wasitme: too early to tell" |
| none | the bare rule | Bare rule: no detectable change | "wasitme: no detectable change" |
| unclear | square above, triangle below | Square and triangle: can't tell which | "wasitme: numbers moved, can't tell which change" |
| you | square above the rule | Square above the rule: your side changed | "wasitme: your side changed" |
| agent | triangle below the rule | Triangle below the rule: the agent changed | "wasitme: the agent changed" |
| stale | the rule, struck through | Struck-through rule: out of date | "wasitme: out of date, last checked {when}" |

New changes add "+n" beside the glyph, and ", 1 new change on the timeline" / ", n new changes on the timeline"
to VoiceOver (explicit one/other forms in `tokens.json`; never while out of date). Swift emits these as functions,
`voiceOver(lastChecked:)` and `FindingState.newChangesVoiceOver(_:)`, so no placeholder reaches a screen reader. The
menu bar never shows the mark.

**Files.**

- `glyphs/state-*-16.svg` and `-18.svg` are hand-written template images: pure black and alpha, no
  opacity. Each size is drawn on its own pixel grid, not scaled.
- The Mac app draws them as template images from `Tokens.Glyphs` (the same rects and paths, generated into `Tokens.swift`); the canvas from `ui/src/gen/design.ts`. Only rects, filled `M/L/Z` paths and stroked `M/L` paths are allowed (`gen/lib.mjs` `parseGlyph` refuses anything else).

**Text forms** (3 cells; terminal font only):

| State | Text glyph | ASCII fallback |
|---|---|---|
| insufficient | `·┄·` | `[..]` |
| none | `───` | `[none]` |
| unclear | `■─▲` | `[?]` |
| you | `■──` | `[you]` |
| agent | `──▲` | `[agent]` |
| stale | `─╱─` | `[stale]` |

The ASCII forms are for `TERM=linux` consoles or `WASITME_ASCII=1`.

- Text glyphs are set **only in the terminal font**, never in Wasitme Mono: IBM Plex Mono (upstream and our subset)
  has no ■ (U+25A0) or ▲ (U+25B2), so a browser would silently fall back. The glyph sheet sets them in
  `var(--font-terminal)`; the report puts them in `code`.
- Menlo covers every text glyph. The earlier claim that SF Mono covers ▲ but not ◆ could not be re-checked on this
  machine (SF Mono is not installed where expected); re-verify on a Mac that has it.

**Measured at true 1×** (headless Chrome pixels, `gen/glyph-check.mjs` → `glyphs/separation.txt`, PASS):

| Check | 16 px | 18 px | v2 |
|---|---|---|---|
| Closest pair of states | insufficient/none, 20 px apart | 24 px | 12 |
| You vs the agent flipped upside down | 18 px | 24–26 px | a mirror pair |
| Mark vs nearest state | 85 px | 108 px | |
| Nearest look-alike (appearance toggle, info icon) | 83 px | 91 px | |

So you and the agent are different shapes, not mirror images.

**App states** (`tokens.json` `appStates`, `glyphs/app-*-16.svg` and `-18.svg`, v3.2). These are about wasitme
itself, never a finding; the engine never emits them, so they are not in `states.order`. Same rule, one rule of its
own: **an app state changes the rule itself and never puts a square above it or a triangle below it**, so none can be
read as a side, and every one is pixel-aligned rects only (crisp at 1×; `test.mjs` checks the grammar).

| App state | Glyph | Legend line | Shown when |
|---|---|---|---|
| loading | three dots where the rule will run | Three dots: loading | the first read hasn't finished |
| notSetUp | empty brackets, no rule yet | Empty brackets: not set up yet | there is no status file yet |
| empty | the rule between two end ticks, nothing on it | Ticked rule, nothing on it: no agents yet | a current file with no agents |
| unreadable | the rule stops at an exclamation mark | Rule and exclamation mark: can't read status | the file can't be read |
| updateNeeded | the rule split in two, out of step | Two rules out of step: update needed | the schema id isn't this app's |
| refused | the rule blacked out (redacted) | Blacked-out rule: not shown | the file doesn't say it is free of text |

Measured with the states (`glyphs/separation.txt`, PASS). Closest app pair: loading/none 16 px at 16 px, 20 px at
18 px (threshold 12). Every app glyph is at least 60 px from all four look-alikes (the appearance toggle and info
icon, and the menu bar's pause and battery; threshold 30). The error glyph was the problem: the interim one (a bar above the rule, a dot below) was
14 px from ÷; `unreadable` is 34 px. The chip is the quiet one (`appStates.chip`: secondary ink on the sheet,
strong-rule edge), named by colour path so it adds no new colour. The words are the app's own titles
(`macos` `AppCopy.title`, the canvas's message page). The menu-bar glyph sheet shows them under the states.

**Blind naming.**

- **Self-blind check (not independent).** The 9 glyphs (6 states, the mark and the 2 look-alikes) were shuffled
  with a fixed seed and named against the legend line: 9 of 9 correct. The namer designed the glyphs.
- **Sealed blind run, by another agent (its sheets and answers are not in the published tree).** The 6 states and the mark at true 1× 16 and 18 px,
  black on light and white on dark, under random letters on three sheets: as drawn, mirrored, flipped. The
  letter-to-name mapping was sealed (sha256 recorded) before the answers were written, and the seal re-verified
  intact. Result: **7/7 on each sheet, 21/21.**
- **What it does and doesn't show.** It was a closed set (7 glyphs, 7 names), named against a list of state names
  by an AI agent, not by people. Confidence (recorded on the first sheet only) was 0.9 for `none` but only
  0.55–0.7 for `you`, `agent`, `stale`, `insufficient`, `unclear` and the mark. The judge said that square = you and triangle = agent was a guess. So the
  shapes are distinct and the grammar can be worked out, but which shape means which party is learned from the
  legend, not obvious. A test with people (open-ended, no list) is still worth doing before launch.

**Mark and app icon.**

- **The mark** is the two sides before any finding: the canary square and the blue triangle, with **no rule**.
  Every state has a rule, so the mark can never be read as one. Files: `glyphs/mark.svg`, `mark-16/18.svg`
  (mono).
- **The app icon** (`glyphs/appicon-1024.svg`, `-dark`) shows two stickers on a ruled bond-paper form: a canary
  "1" and a blue luggage tag "A" with a punched hole. The hole keeps the tag from reading as a house.
  - Construction: flat fills, 12 px ink keylines, one small offset shadow, no gloss.
  - Grid: the macOS one, an 824 tile on a 1024 canvas with a 185.4 corner radius.
  - Small sizes: at 32 px it reads as a yellow square and a blue tag (`screens/appicon-sheet-*.png`).
  - macOS 26+: assemble it in Icon Composer from these layers.
- **The wordmark** is `wasitme` in Plex Mono Bold, outlined, with a canary typewriter underline under "me"
  (`glyphs/wordmark.svg`). The README hero repeats the underline under "me" in the question.

---

## 7. Components

- **State chip.** The glyph plus the label in mono Bold, styled with the state's fg/bg/edge tokens (`chip()` in
  `gen/screens/kit.mjs`). An app state uses the quiet `.chip--app` (`appChip()`), never a finding's chip.
- **Sizes** are tokens (`tokens.json` `size`, v3.2): popover 352 × 480, desktop panel 170 × 170 and 360 × 170,
  Control Center 1280 × 800 (minimum 900 × 600), chip 26 high with a 16 px glyph and 9 px swatches, sticker 20 × 20,
  tag 20 × 22, button 30 (28 in the popover footer), the panel's 30 px glyph box and the case line's 22 px pin. CSS
  reads `var(--size-*)`, the app `Tokens.Size`, the CLI and mod `tokens.size`.
- **Party markers.**
  - Yours: a 20 px canary square, numbered.
  - The agent's: a 20 × 22 blue tag pointing up at the rule, lettered.
  - Routine updates are drawn hollow (keyline only). The change a shift lines up with is filled and joined to the
    data by a solid line; an agent-strong change that isn't a routine update (e.g. Claude Code serving a different
    model than you picked) is also filled.
- **Case line (hero).** An italic side-label gutter, a 2 px ink rule (dashed while too early to tell), and the
  state glyph pinned at its left end. The finding block goes above the rule, below it, or before both, as in §1.
- **Side panel.** It changes with the state:
  - Too early to tell: "Next to unlock", with a 40-cell progress row and "No date yet: it depends on how your
    sessions go." v1 shows no projected date (D66): the counters are the progress. A date returns only if a later
    engine sends one.
  - Your side, no detectable change, can't tell which: "Next step".
  - Agent side: "What was checked", five rows.
  - `none`, `you` and `agent` end with the fixed disclaimer in the note style.
  - Codex: "Before Codex can be compared".
- **Ledger.**
  - Columns: signal (with family), recent k/n, before k/n, change with range, a forest plot, and status
    ("Moved, more" + the marker it lines up with / "No detectable change" / "Not enough yet" / "Context only").
  - Friction signals are always labelled context (D30).
  - A moved ratio is tinted canary or blue only when the finding names that side. In a `Can't tell which` finding
    it gets the neutral selection tint, so the colour never assigns a side the finding doesn't.
  - Under the ledger: the confidence line (§3).
  - The popover's metric rows use the short status "Not detected" (allowed by the vocabulary table) where the ledger
    says "No detectable change": the long form forced the popover's status column wide enough to wrap the signal
    name. The ledger, report and CLI keep their own forms ("No detectable change" / "not detected").
- **Typed form fields.** The window pickers in the top bar are mono Bold with an ink underline.
- **Buttons.** Ink outline. The primary button is ink-filled ("Copy evidence report"). "Open as Markdown" sits
  beside it.
- **Sidebar.** The selected page is a tab in the sheet colour that runs into the content, the case-file tab.
  The footer reads "local only / updated 4 min ago".

---

## 8. Charts

The rule: **integer daily strips plus one window-level ratio with its range and
MDE. No per-day rate bands, no rolling lines, no interpolation.**

- **Daily strip.**
  - Each event is one tick, 2 px tall with a 1 px gap. Above 25 events a day the ticks become 1 + 1 (dense),
    so they can still be counted.
  - A day with under 100 opportunities is drawn half width: a shape cue, not a colour.
  - A day with no sessions shows `–`.
  - Under every full strip: the **k row** (events) and the **n row** (opportunities), in mono.
- **Window ratio.** One line beside the strip title, e.g. "×0.75, range ×0.40 to ×1.41; changes under ×2.5
  wouldn't show".
- **Forest plot.**
  - Axis: one shared log axis from ×0.25 to ×8, labelled ×0.5 ×1 ×2 ×4 (widened from ×4: three demo ranges end
    past ×4).
  - A range that runs past the axis ends in an open arrowhead at the edge instead of an end cap, so the bar never
    claims a shorter range than the printed one. The CLI uses `<` / `>` the same way. `test.mjs` checks every
    drawn bar against its printed range.
  - The hatched zone runs from 1/MDE to MDE and is labelled "too small to show".
  - The range is a 2 px bar with end caps.
  - The estimate is a filled dot when moved, an open dot when not detected.
  - The same plot is drawn in text in the CLI: `├─○┼┤░`.
- **Events.** Your markers sit above the axis, the agent's below. Window brackets "before / recent" go under
  the axis, and today is a dotted tail (excluded). A crowded lane groups: at most one mark a day per side, a range
  badge ("18–21") where days collide, the change that lines up with the shift always on its own, and changes of
  unknown origin as a faint tick on the axis (docs/design/UX-V2.md §7.3, "Crowded lanes").
- **Compact variant (popover, desktop panel).**
  - Too narrow for ticks, so each day is one solid column with its k printed under it (popover).
  - The desktop panel (a glance surface) drops the numbers.
  - The n row is omitted for width; the metric rows beside it carry N.
- **Accessibility.** Forest plots are `aria-hidden` (their row prints the same numbers). Each strip is
  `role="img"` with a summary label (from `cc-agent`: "errors per day, Sep 6 to Oct 3: 375 errors in 5,943 tool calls; 4
  changes marked") and `aria-describedby` a hidden list of every day's k and n and every marked change, so no number is
  visual-only. `components.css` has a `:focus-visible` ring in `accent.focus` for the live canvas.
- **Static mockups.** The live app adds hover tooltips per day (date, k, n, events) per the dataviz method.
  These PNGs can't show them.

---

## 9. Screen inventory (`screens/`)

Every screen is an HTML file built only from `generated/tokens.css` and `screens/components.css` (vars only;
the test fails on any colour literal), plus a light and a dark PNG.

| Surface | Files |
|---|---|
| Control Center, Finding page (hero = too early to tell) | `cc-insufficient`, `cc-none`, `cc-unclear`, `cc-you`, `cc-agent`, `cc-codex-insufficient` |
| Control Center tabs | `cc-timeline`, `cc-compare`, `cc-setup` |
| Menu bar popover 352 × 480 | `popover-insufficient`, `popover-none`, `popover-you`, `popover-stale` |
| Desktop panel 170 × 170 and 360 × 170, drawn at true size (v3.0 squeezed the small tiles to 120 px wide) | `desktop-panel` |
| Menu bar glyph sheet | `menubar-glyphs` |
| Mod pane 64 × 18 + status line + CLI 100 col | `text-dark`, `text-light`, `text-ansi16` (reverse-video stickers), `text-nocolor`, `text-codetab-light`, `text-codetab-dark` (one PNG each; the terminal's own theme is the variant) |
| Shareable evidence report | `report-agent.md` (the Markdown), `report-agent` (how it renders in an issue) |
| README hero 1280 × 640 | `readme-hero` (leads with the question and the case line) |
| App icon sheet | `appicon-sheet` |

The `text-*` sheets have one PNG each, because the terminal's own theme is the variant; every other screen has
light and dark.

Each render checks these in `gen/render.mjs`, in the real page:

- both web fonts loaded;
- nothing overflows the frame, and no text escapes the bordered box it sits in (tiles, chips, buttons, cards);
- every text run in the Wasitme families is a type-scale size (serif ≥ 13 px, mono ≥ 12 px, nothing scaled).

---

## 10. How each platform consumes the tokens

| Platform | Reads | Notes |
|---|---|---|
| Web mockups, README mockups | `generated/tokens.css` | Light, dark and system themes (`data-theme` overrides). Relative `@font-face` URLs: local mockups only. |
| Shipped single-file HTML (the evidence report) | `generated/tokens.inline.css` | The same tokens with all six faces inlined as base64 `data:` URLs (about 128 KB). Use the CSP **`default-src 'none'; style-src 'unsafe-inline'; font-src data:`** (or a `'sha256-…'` hash of the style element in place of `'unsafe-inline'`). Measured in headless Chrome by `gen/csp-check.mjs` → `generated/csp-check.txt`: under that CSP each of the six faces draws its own text with no violation; under `default-src 'none'` alone the inline style and the fonts are blocked (Times). The test checks that the file has no http(s) or relative URL and that `csp-check.txt` says PASS for this exact file (sha256). |
| Mac app (SwiftUI) | `generated/Tokens.swift` | `Tokens.Palette.*` are appearance-aware colours (NSColor dynamic provider, no macros). `Tokens.Typeface.*` are Plex fonts at fixed sizes. `Tokens.FindingState` (raw values = contract names; the `none` case is **`noDetectableChange`**, CONTRACT.md decision 12) carries label, headline, legend, text glyph, ASCII form and menu-bar image names, plus `voiceOver(lastChecked:)`, `newChangesVoiceOver(_:)` (one/other) and `newChangesText(_:)`. `Tokens.CalibrationPending` holds "Timeline only" (a reason's display, not a state case). Since v3.2 it also carries everything the app used to generate locally (WP-50's DesignExtras.swift): `Tokens.Size`, `Tokens.TypeScale` (PostScript names), `Tokens.Copy`, `Tokens.Chart`, `FindingState.edgeStyle`, `Tokens.AppState` (labels, legends, the quiet chip) and `Tokens.Glyphs` (every 16/18 px glyph as vector primitives, so the app needs no PDFs or asset catalogue). `macos/scripts/sync-design.mjs` copies it byte for byte; `Theme.swift` builds the app's theme from it. Bundle `fonts/app/*.ttf` via `ATSApplicationFontsPath`. The test compiles it with a probe under `-warnings-as-errors` and runs it. |
| CLI, status line, mod pane | `generated/tokens.ts` | Uses `chooseMode(env, isTTY)`, `sticker()`, `styled()`, `stateGlyph()`, `statusLine()` and `modSticker(party, claudeTheme)`. Zero imports, erasable TypeScript; passes `tsc --strict`. NO_COLOR, a pipe or `TERM=dumb` emits no escape codes at all. `styled()` emits explicit greys in 256-colour and truecolor modes and SGR 2 only in 16 colours; 16-colour stickers are SGR 7. The terminal mockups are drawn through this module. |
| Contrast / CVD | `generated/contrast-report.md` | Regenerated with the rest. |

The commands:

| Command | What it does |
|---|---|
| `node design/system/gen/build.mjs` | regenerate the token outputs |
| `node design/system/gen/test.mjs` | run the 22 checks: byte-stable outputs, WCAG and CVD, copy lint, glance lint, tokens-only screens, PNG sizes, demo-data sums and ratios, assets, glyph PASS (app states included), the app-state grammar and chip, no home paths, TS behaviour, tsc, the required disclaimer, the engine's own `lintCopy` per string, contract reasons, range/MDE recomputation, forest geometry, type-scale literals, a compiled Swift probe, inline fonts + CSP result, terminal modes. Checks that need `engine/dist` or `xcrun` print `skip` without them. |
| `node design/system/gen/screens/build.mjs && node design/system/gen/render.mjs` | rebuild the screens (needs Chrome) |
| `node design/system/gen/csp-check.mjs` | re-check the inline fonts under the report CSP (needs Chrome; rerun after any font or token change) |
| `node design/system/gen/glyph-check.mjs` | re-measure the glyphs (needs Chrome) |
| `node design/system/gen/make-demo-v3.mjs` | regenerate the demo data |
| `python3 design/system/gen/make-logos.py` | rebuild the logo files (needs fontTools) |
| `python3 design/system/fonts/subset.py` | rebuild the font subsets (needs fontTools) |

---

## 11. Demo data v3

`demo-data.v3.json` is labelled ANALYTIC. It is synthetic and deterministic, written by `gen/make-demo-v3.mjs`.
It extends v2 because the screens needed per-case timelines. What changed from v2:

- **Per case:** every case now has its own timeline and integer daily rows. The test checks every sum against
  the window totals and every ratio against k/n.
- **Agent case:** it gained real numbers and moved its shift to Sep 23, so the 14-day window can actually
  carry it. v2's Oct 1 shift would have left only 3 days.
- **Copy:** follows the engine's copy templates (D59, D67).
- **Removed:** the "≤2% false agent" claim.
- **Unlock signal:** research signals unlock a finding, not friction signals (D30).
- **Edit gate:** the reads-per-edit gate is 40 **edits** (METHOD.md §5); v2 had said "exchanges with edits".
- **Fixed:** the inconsistent "9 of 10 session-days" in the too-early case.

**v3.1 corrections (verifier findings, 2026-10-04):**

- **Ranges and MDEs now follow the engine's formulas** (METHOD.md §6; `engine/src/analysis/gates/evaluate.ts` and
  `stats/mdc.ts`): range = exp(ln ratio ± t.995(df)·SE), MDE = exp((t.995 + t.80)(df)·SE·1.1). Each eligible metric
  hand-sets only the MDE its copy prints; df is Welch–Satterthwaite over the two windows (session-days − 1 per
  window, variance weight 1/events, edits for reads per edit); SE is derived from the MDE, the range from SE. `se`
  and `df` are stored per metric and `test.mjs` recomputes both, with t quantiles cross-checked against the engine.
  The 1.1 is the engine's `DEFAULT_MDC_OPTIMISM` (METHOD.md §6); D23's formula has no 1.1, so a check written from D23
  alone (a separate check script, not in the published tree) expects MDEs about 10% smaller on the log scale. v3.0's
  ranges fit neither.
- **`unclear` is now a case the engine can produce:** METHOD.md §11 row 6, reason `both_sides`: your effort change
  (Sep 21) and Claude Code serving a different model than you picked (Sep 23, agent-strong, marker F). v3.0 used two
  of your own changes (`both_yours`), which isn't a contract reason and would be `you` under row 7 (CONTRACT.md
  decision 13). The `insufficient` reason is `needs_data` (v3.0 said `progress`, also not a contract reason). The
  test checks every (state, reason) against the engine's `REASONS_BY_STATE`.
- **`none` copy** uses the engine template: "Changes bigger than about ×1.9 in 3 indicators would have shown."
- **Agent case:** dropped the Aug 30 "MCP server removed" event, which contradicted "Nothing recorded changed on
  your side" (and fell before tracking started on Sep 5). Its Sample row now gives both windows.
- **Setup page:** Claude Code version is the timeline's last version (2.1.281), not 2.1.289; markers and dates are
  read from the timeline.
- **Confidence line** added per case from the engine's template (both windows added).

**v3.2 (D66, one name per indicator, 2026-10-05):**

- **No projected dates.** The `insufficient` and `codex` progress carry counts only (`etaDays` and `etaDate` are
  gone), and the `unclear` / `you` next steps drop their re-check estimates ("at your pace … about 5 weeks"). The
  screens say "No date yet: it depends on how your sessions go.", as the Control Center canvas, the mod pane and
  the CLI do (the menu bar popover shows the counts alone).
- **One name per indicator.** Copy says "edits without reading first", the ledger's own label, never "blind edits".

**Every v2 → v3 number change** (listed by a separate comparison script, not in the published tree, after v3.1):

| Case · field | v2 | v3 |
|---|---|---|
| insufficient · pushback recent | 11 / 214 | 8 / 214 (below the 10-event floor, context only) |
| insufficient · reads per edit recent | 402 reads / 96 edits | 131 / 31 (31 of the 40 edits the gate needs) |
| insufficient · tool errors range (MDE ×2.5) | ×0.42–×1.33 | ×0.40–×1.41 |
| unclear · tool errors range (MDE ×2) | ×1.48–×4.43 | ×1.59–×4.12 |
| unclear · edits without reading first range (MDE ×1.7) | ×1.21–×2.90 | ×1.30–×2.70 |
| unclear · pushback range (MDE ×2.6) | ×0.61–×2.40 | ×0.63–×2.34 |
| you · tool errors range (MDE ×2) | ×1.55–×4.70 | ×1.67–×4.34 |
| you · edits without reading first range (MDE ×1.7) | ×1.19–×2.86 | ×1.28–×2.66 |
| you · reads per edit range (MDE ×1.5) | ×0.38–×0.74 | ×0.40–×0.70 |
| none, agent · metrics | none in v2 | new in v3 (tool errors, edits without reading first, reads per edit, interruptions) |
| every case · n | recent window only | recent and baseline windows (exchanges, sessions, session-days, active days) |
| codex · n | none in v2 | new in v3 |
| single_indicator case | in v2 | not rendered in v3 (no screen uses it) |

All other k / n counts and every ratio are unchanged from v2. The `stale` popover reuses the `insufficient` case.

---

## 12. Unresolved / to verify

1. **Claude Desktop Code-tab colours are assumed** (whether text holds up on the Code tab is unverified, not
   failed). Capture the real Code tab, light and dark, replace `terminal.backgrounds.codeTab*`, and capture the mod-pane
   theme names. The terminal greys are already gated against the assumed values; re-run the report after.
2. **Blind glyph naming by people.** The sealed AI run scored 21/21 (§6) but with low confidence on which shape is
   which party. An open-ended test with a few developers (no list of names) is still worth doing before launch.
3. **How terminals draw dim (SGR 2)** is unchecked; only 16-colour mode and the mod pane's `dimColor` still use it.
4. **16-colour palettes** were never checked in the apps (Terminal.app's came from a secondary source). Since v3.1
   no 16-colour output depends on them; the mod pane's `ansi` theme still does (§5).
5. **SF Mono coverage** of the text glyphs could not be re-checked here (§6).
6. **Wordings for the engine owner** (engine-owned copy): "Finding" instead of "Verdict", and
   "Findings for Codex are off". The app font changes from the earlier SF Pro/SF Mono fallback to bundled Plex
   (D44(3)). These belong in DECISIONS.md.
7. **Not yet wired into the mod.** The Mac app builds its whole theme from `Tokens.swift` (WP-50; since v3.2 it
   generates nothing of its own). `plugin/mod/theme.ts` was the pre-brand placeholder when this list was written (its
   metric status words were "worse" / "better", not "moved, more / fewer"); D44(7) coherence for the mod is the mod
   owner's to confirm.
8. **App icon:** needs Icon Composer layers for macOS 26. (The menu-bar glyphs need no PDFs or asset catalogue: the app
   draws them from `Tokens.Glyphs`, generated from the SVGs.)
9. **Release gate (D21):** every image here is analytic. README and launch images must be re-rendered from
   engine output.
