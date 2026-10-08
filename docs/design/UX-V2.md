# Control Center UX v2

**Status:** built (2026-10-06), except where a section says otherwise (`install.sh --launch-at-login`, §9.4, is not
built; neither are §4's text zoom and Check for Updates, nor §3's toolbar agent picker (it is in the sidebar), Copy
Report split button, Timeline badge and state-glyph Finding icon). Written as a
spec first: where the build differs, the **As built** notes below record what shipped. The decisions it asked for
(§13) are DECISIONS.md D73–D78.

**Built (canvas, 2026-10-06):** sections 5–9 and 11 in `ui/src` (`pages.ts`, `charts.ts`, `derive.ts`, `view.ts`,
`canvas.css`) and `tokens.json` 3.3.0 (`copy.canvas`, `type.scale.section` / `small`, the badge sizes). Where the
build differs from the text below, the build is recorded in place, marked **As built**: the bridge keys (§10), the
Daily counts layout (§8.1) and two word budgets measured on the first render (§8.1, §14).

**Inputs:** the maintainer's report after installing and opening the Control Center (section 1),
[DESIGN.md](../../design/system/DESIGN.md), [tokens.json](../../design/system/tokens.json), `ui/src/pages.ts`,
`ui/src/charts.ts`, and renders of the current canvas (the `wasitme demo` snapshot on every page, light and dark, in
both chromes, plus the `you-and-codex` and `agent-by_elimination` contract fixtures; how to re-make them is in section
14).

**Wireframes:** [Finding](ux-v2/finding.txt), [Timeline](ux-v2/timeline.txt), [Settings](ux-v2/settings.txt), each
before and after. [The window](ux-v2/window.txt) shows the native shell.

**What does not change:** the shared contract (`engine/src/types.ts`, `contract/`), every engine-owned string (the
deck, the note, the next step, the confidence line, the trace), the state vocabulary (D22), the glyphs, the colours,
the party grammar (D57: yours are square, numbered, canary, above the line; the agent's are pointed, lettered, blue,
below it), and the Markdown report the toolbar copies.

## Contents

1. [The report, and where each item is answered](#1-the-report-and-where-each-item-is-answered)
2. [Principles](#2-principles)
3. [The window: native sidebar and toolbar](#3-the-window-native-sidebar-and-toolbar)
4. [Features every Mac app has](#4-features-every-mac-app-has)
5. [The page template](#5-the-page-template)
6. [Type, spacing and line length](#6-type-spacing-and-line-length)
7. [Markers](#7-markers)
8. [Pages](#8-pages)
9. [Settings](#9-settings)
10. [Bridge](#10-bridge)
11. [Copy and tokens](#11-copy-and-tokens)
12. [What still holds](#12-what-still-holds)
13. [Decisions this spec asks for](#13-decisions-this-spec-asks-for)
14. [Tests and measurements](#14-tests-and-measurements)
15. [Out of scope](#15-out-of-scope)

---

## 1. The report, and where each item is answered

| # | The maintainer reported | Cause (checked in the code) | Answer |
|---|---|---|---|
| 1 | The window cannot be moved. | `ControlCenterController` makes a `.fullSizeContentView` window with a transparent title bar and `isMovableByWindowBackground = false`, and the web view fills the whole window, title strip included. Every click in the strip goes to the web page, so nothing is left to drag. | §3: a native toolbar owns the top strip; the canvas starts below it. |
| 2 | The UI is crowded and hard to understand: too much text. | Measured on the demo snapshot (visible words on each page, content chrome): Timeline 288, Finding 421, Compare 323, Setup 148, Report 386, Sources 95, Settings 142. The Finding page shows a hero, two lanes of changes, a side panel, a strip with two rows of numbers under it, a five-column ledger with forest plots, a footnote and the confidence line, all at once, in 10 type styles. | §5, §6, §8: one title, one sentence, one chart; the rest behind disclosures; word budgets per page. |
| 3 | The window's traffic lights sit on top of grey dots the canvas draws, offset. | The canvas is told `chrome: "full"` (`BridgePolicy.viewObject`), so `sidebar()` draws its decorative `.lights` (three grey dots, `components.css`). | §3: the app sends `chrome: "content"`; the canvas never draws window chrome inside the app. |
| 4 | Change rows on the Report page (a Codex pre-release update, for example): the icons are unclear and the rows too crowded. | Those rows are the Report page's timeline list: a Menlo text glyph and a letter in a grey code chip, the full version strings, and "(update)" on every routine row. The other pages draw 20 × 22 house-shaped tags with a version beside every one. | §7: one drawn badge everywhere, short versions, no "(update)". |
| 5 | Settings is paragraphs (a raw list of mod calls, "add --purge to the command below", "run the uninstaller…"); these should be buttons. | An earlier fixer removed the buttons because nothing behind them existed (`DestructiveAction` only shows a Terminal how-to). | §9: buttons and toggles, each named with its bridge action and what runs behind it; §9.4 lists what the installer and engine owners must add. |
| 6 | The standard features every Mac app has are missing. | No main menu is built anywhere in `macos/Sources` (grep for `mainMenu` finds nothing; not run-checked), so standard shortcuts and the Edit menu are likely missing while the window is open. | §4. |
| 7 | An installed copy should update in place once this work ships. | The installer has no "update and keep my parts" mode; `--repair` never rebuilds the app; nothing quits and reopens a running app. | §9.4 proposes `install.sh --update`, which both the Update button and this request need. Running it on an existing install is outside this spec. |

## 2. Principles

1. **The answer first.** Every page opens with one title, one sentence and one chart (or one table where the page is
   a table). Nothing else competes with them above the first disclosure.
2. **Collapse, don't delete.** Evidence moves behind a disclosure; it never leaves the canvas. Every number that is on
   a page today stays reachable on that page, in a disclosure, a hover tip or the chart's text description (the one
   exception is listed: Setup's copy of the Timeline chart, §8.4).
3. **One drawing per idea.** A change is one badge everywhere (§7). A state is one chip. A window is one phrase.
4. **Words are budgeted.** Every page has a visible-word budget (§14), and every UI-owned sentence a word limit
   (§11).
5. **No button without something behind it.** A Settings control ships in the same change as the native action and
   the installer or engine mode it runs (§9.4). Until then it is shown disabled with a one-line reason, never as a
   Terminal how-to.

---

## 3. The window: native sidebar and toolbar

**Native (WP-50).** The canvas spec depends on this shell; it is described here only as far as the canvas needs.
[Wireframe](ux-v2/window.txt).

- **Window.** Keep `[.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]` and the frame autosave
  name, and add an `NSToolbar` with `toolbarStyle = .unified`. The content is an `NSSplitViewController`: a sidebar
  item (`NSSplitViewItem(sidebarWithViewController:)`, 220 pt default, 200–280 pt) and a content item holding the
  web view. The web view is pinned to the content item's **safe area** (below the toolbar), so the title-and-toolbar
  strip has no web content under it. The strip is then ordinary window chrome: dragging, double-click to zoom, the
  traffic lights at their system position. This fixes report items 1 and 3.
- **Title.** `window.title` = the page ("Finding"); `window.subtitle` = the agent ("Claude Code"). VoiceOver and the
  Window menu read both.
- **Sidebar.** A source list with the seven pages, in the order of DESIGN.md §3 (Timeline, Finding, Compare, Setup,
  Report, Sources, Settings), each with an SF Symbol (suggested names; check them in the SF Symbols app): Timeline
  `calendar.day.timeline.left`, Finding the current state's template glyph from `Tokens.Glyphs` (16 pt), Compare `arrow.left.arrow.right`, Setup `slider.horizontal.3`,
  Report `doc.text`, Sources `tray.full`, Settings `gearshape`. Timeline carries the count of new changes as a sidebar
  badge (`newChangesText`, never while out of date). The footer has two lines in the secondary label colour:
  `copy.privacyShort` ("local only") and the freshness words ("updated 4 min ago"), with the exact check time as the
  tooltip. DESIGN.md §7 puts these words in the sidebar footer; they move from the canvas to the native sidebar.
- **Toolbar, trailing side, left to right:**
  1. **Agent picker**: an `NSSegmentedControl` with one segment per agent (hidden with one agent; an `NSPopUpButton`
     above three). Agents that have logs but no results are shown disabled, with the tooltip the canvas uses today
     ("No Codex results yet").
  2. **Check Again**: `arrow.clockwise`, label "Check Again", ⌘R. While a scan runs it shows a small spinner and is
     disabled.
  3. **Report**: a split button. The main part is "Copy Report" (`doc.on.clipboard`, ⇧⌘C, runs `copyReport`); its
     menu adds "Open as Markdown" (⌥⌘O, runs `openMarkdown`). It is disabled when there is no agent to report on.
- **What the canvas gets.** `BridgePolicy.viewObject` sends `"chrome": "content"` (today it hard-codes `"full"`) plus
  the Settings fields in §10.2. Page, agent, appearance, now and time zone already travel in `view`.

**Canvas.** In `chrome: "content"` the canvas draws no sidebar, no `.lights`, no top bar (`topbar()`), and no stamp
footer (`stampBar()`). What those held goes elsewhere:

| Today, in the canvas | v2 |
|---|---|
| Sidebar: wordmark, agent switcher, page list with meta | Native sidebar and toolbar |
| Sidebar "Read in the last 14 days" block | Sources → "Scan and calibration" disclosure (§8.6) |
| Sidebar "local only / updated 10 min ago" | Native sidebar footer |
| Top bar window fields ("Recent Sep 20 – Oct 3 … compared with …") | Finding's meta line ("Last 14 days against the 4 weeks before") and the chart's brackets |
| Top bar "Check again", "Open as Markdown", "Copy evidence report" | Native toolbar |
| Stamp "demo data (wasitme demo) — not from your logs" | A one-line banner at the top of every page (§5), so demo data is never mistaken for yours |
| Stamp "wasitme engine 0.1.0" / "checked Oct 4, 14:14" | Sources → "Scan and calibration"; native footer tooltip |

`chrome: "full"` stays for the README hero (`ui/scripts/hero.mjs`) and the design-screen comparisons only. It is the
§5 page template (demo banner, no top bar, no stamp) with the canvas's own sidebar beside it, so the README image shows
the same page the app shows. That sidebar drops `.lights` too: a picture of grey dots where real buttons belong reads
as a broken window in a screenshot as well.

## 4. Features every Mac app has

| Feature | Where | Status today |
|---|---|---|
| Drag, zoom and resize the window; size and position remembered | Native toolbar strip (§3); `setFrameAutosaveName` | Drag: **broken** (report item 1). Remembered frame: exists. |
| Full screen | `collectionBehavior` `.fullScreenPrimary`; View → Enter Full Screen (⌃⌘F) | New |
| Main menu with the standard items | App: About wasitme, Settings… (⌘,), Check for Updates…, Hide, Quit (⌘Q). File: Copy Evidence Report (⇧⌘C), Open as Markdown (⌥⌘O), Close (⌘W). Edit: Copy (⌘C), Select All (⌘A). View: Show/Hide Sidebar (⌃⌘S), one item per page (⌘1–⌘7), Actual Size (⌘0), Zoom In (⌘+), Zoom Out (⌘−), Check Again (⌘R), Enter Full Screen. Window and Help: standard. | New. Without an Edit menu, ⌘C in the web view likely does nothing; not run-checked. |
| Settings on ⌘, | Selects the Settings page | New |
| About window with the version and licences | `orderFrontStandardAboutPanel` with the version, "MIT licence", and the IBM Plex OFL credit (THIRD_PARTY_NOTICES.md) | New |
| Check for updates | App menu and Settings → General (§9.2) | New, disabled until a public release exists |
| Launch at login | Settings → General (§9.2) | The mechanism exists (the installer's app LaunchAgent); the switch is new |
| Text zoom | `WKWebView.pageZoom` in steps of 10 %, 80–150 %, remembered in `UserDefaults` | New |
| Copy any number | Text in the canvas is selectable (no `user-select: none` in `canvas.css` or `components.css`); needs the Edit menu | Partly |
| Keyboard use | ⌘1–⌘7, ⌘R, Tab through every control, visible focus ring (`accent.focus`) | Focus rings exist; shortcuts new |
| Follows light and dark | `appearance` in `view` | Exists |
| Help | Help → "How wasitme Decides" opens the installed `METHOD.md` from `~/.wasitme/current/docs/` when present (no network); hidden otherwise | New; whether the install copies `docs/` was not checked |
| Native confirmation for anything destructive | `NSAlert` sheets (§9.3) | The sheet path exists; today it only shows a Terminal how-to |

---

## 5. The page template

Every page in `chrome: "content"` is one column, in this order:

```
[demo banner, only for demo data]          small, ink.secondary on surface.well, one line
[scan notice, only after a failed scan]    "Last scan failed (timed out). See Sources"
Title                                      h1
One sentence                               deck
The one chart or table
Disclosures                                ▸ Details   ▸ …
```

**Column.** Padding 32 px top, 40 px left and right, 48 px bottom (`space.8`, `space.10`, `space.12`). The column is
left-aligned and at most 960 px wide; charts take its full width (at the 1280 pt default window the content pane is
1060 pt: 980 px are available and the column and its charts use 960).

**Spacing rhythm** (all `tokens.json` `space` values): chip → title 12; title → deck 8; deck → chart 32; chart →
legend 8; legend → next block 24; between disclosures 0 (they share hairlines); between page sections 40.

**Disclosures.** One component, used on every page:

- A full-width `<button class="disc">` with a 12 px chevron drawn as an SVG path (▸ closed, ▾ open; never a text
  character), the label in body 15 bold, and an optional count in typedSm muted ("All changes 9"). A `rule.hair` line
  above it; 40 px tall.
- `aria-expanded`, `aria-controls` → a region `<div role="region" aria-labelledby>`. The region is always in the DOM
  with `hidden` when closed, and its children are rendered only when open, so the render checks (one visible h1,
  heading order, unique ids) keep passing.
- **No animation.** The D48 hidden-window rule and `motion.reduceMotion`: the region appears and disappears in one
  paint; the chevron swaps.
- **State.** `Ui` gains `open: string[]`, keys like `"verdict.details"`. The button carries `act: { action:
  "toggleSection", section }`, which `main.ts` handles locally (like `showPage`, it is never posted to the bridge;
  §10.1) and which gives `data-act` a stable key, so `paint(true)` puts focus back on it. `open` survives every
  re-render and agent switch and is forgotten when the window's web view is rebuilt. Each page states its defaults
  below; the only one open by default is Finding → Details when the state is `agent` (§8.1).
- **Order.** Disclosures sit after the page's chart or table, in the order each page lists. Tab order follows.

**Message pages** (loading, not set up, unreadable, update needed, not shown, no agents yet) keep today's content and
app-state chip; they only lose the top bar and the stamp.

---

## 6. Type, spacing and line length

Today the demo pages use 6 to 11 text styles each (Settings 6, Finding 10, Setup 11): serif at 52, 30, 19, 17, 15,
14 and 13 px, 13 px italic, mono at 12, 12 bold, 13 bold and 14 px, and Menlo 13 for the report's text glyphs. v2 uses **six sizes and two styles of
emphasis** on the canvas:

| Role | Token | Size / line | Used for |
|---|---|---|---|
| display | `type.scale.display` | 52/56 serif | The state title on the Finding page only |
| title | `type.scale.title` | 30/36 serif | The h1 of every other page |
| section (new) | `type.scale.section` | 17/24 serif **bold** | Section heads: the chart title, Settings group titles, the report's headings |
| deck | `type.scale.deck` | 17/26 serif | The one sentence under a title |
| body | `type.scale.body` | 15/23 serif | All running text, table words, row titles; disclosure labels in bold |
| small (new) | `type.scale.small` | 13/19 serif, **upright** | Secondary text: meta lines, row descriptions, legends, column headers, footnotes, the disclaimer |
| typedSm | `type.scale.typedSm` | 12/16 mono | Numbers, dates, versions, counts, ranges, badge letters, commands |
| typed, bold | `type.scale.typed` | 13/18 mono bold | Buttons drawn in the page (Settings) |

Retired from the canvas: `heading` (19), `ui` (14), `typedLg` (15), the italic `note`, and Menlo. They stay in
`tokens.json` for the popover, the report and the screens that use them.

**Italic.** Only the case line's side labels ("Your side", the agent's name) stay italic: they are the Case File's
one typewriter-form gesture. Notes, footnotes, column headers, ruled-out tags and the disclaimer become `small`,
upright. (This amends DESIGN.md §4's italic rule for the canvas; §13, P5.)

**Mono.** Mono only for data a reader compares: counts, ratios, ranges, dates in rows and on axes, versions, badge
letters, `commands`, and the in-page buttons. Words are never mono. These move to serif: the status words ("Moved,
more", "No detectable change", "Not enough yet", "Context only"), the event notes ("your change", "recent window"),
the context line, Setup's last-change words, Sources' status words, the report footer.

**Weight.** Bold only for: section heads, disclosure labels, the chip label, a moved ratio in a table (today's `<b>`),
and buttons. Never a whole sentence.

**Line length.** Deck at most 56 ch; body prose at most 62 ch; `small` at most 72 ch. Tables and charts use the column.

**Colour of text.** `ink.primary` for titles, decks, body and data; `ink.secondary` for small text; `ink.muted` only
for axis labels and the disabled-button reason. No new colours.

**Token changes** (`tokens.json` → `type.scale`, then `node design/system/gen/build.mjs`):

```json
"section": { "family": "serif", "size": 17, "line": 24, "weight": 700, "tracking": 0, "use": "section heads on the Control Center canvas (UX-V2 §6)" },
"small":   { "family": "serif", "size": 13, "line": 19, "weight": 400, "tracking": 0, "use": "upright secondary text on the Control Center canvas (UX-V2 §6); the italic note stays for the popover and report" }
```

Both sizes are already on the render check's list (`SIZES` in `ui/test/render.mjs`), so that check needs no edit.
The `type.rules` sentence on italics gains "On the Control Center canvas, italic is used only for the case line's side
labels."

---

## 7. Markers

### 7.1 The badge

One drawn badge for a change, used on every page, in rows, in the chart and in the Report page. It keeps the party
grammar of D57 (square = you, pointed = the agent) and drops the house look of today's 20 × 22 tag: it is smaller,
its corners are round, and its point is shallow.

| | Yours | The agent's | Origin unknown |
|---|---|---|---|
| Shape | rounded square, 18 × 18, corner radius 4 | rounded tag, 18 × 20: a rounded rectangle whose top edge rises to a shallow point (3 px) at the centre | circle, 18, dashed edge |
| Path (in an 18-wide box) | `rect 0.5 0.5 17 17 rx 4` | `M9 0.5 L16.2 3.6 Q17.5 4.2 17.5 5.6 V15.5 Q17.5 19.5 13.5 19.5 H4.5 Q0.5 19.5 0.5 15.5 V5.6 Q0.5 4.2 1.8 3.6 Z` | `circle 9 9 8.5`, dash 2 2 |
| Fill | `party.you.fill` | `party.agent.fill` (filled) or `surface.sheet` (hollow) | `surface.sheet` |
| Edge | 1 px `party.you.keyline` | 1 px `party.agent.keyline` | 1 px `ink.secondary`, dashed |
| Label | numeral, typedSm 12 bold, `party.you.ink` | letter, typedSm 12 bold, `party.agent.ink` (filled) or `ink.secondary` (hollow), set 2 px below centre | "?", typedSm 12 bold, `ink.secondary` |
| Filled when | always | the change the shift lines up with, a candidate, or an agent-strong change (as today, `tokens.json chart.timeline.agentStrong`) | never |

[Sketch](ux-v2/badges-sketch.png): these paths drawn at 3×, light and dark, in rows and against today's tag (a
file-URL sketch, so the fonts are fallbacks, not Plex).

New tokens: `size.badgeYou {width 18, height 18}`, `size.badgeAgent {width 18, height 20}`, `radius.badge 4`. The
`sticker` and `tag` sizes stay for the popover and the screens. In the chart the agent's badge points up at the rule,
as today's tag does.

**Accessible name** (today's `marker()` rule, kept): "your change 1, Sep 21: Effort high → medium", "Claude Code change
D, Oct 1: Claude Code 2.1.277 → 2.1.281", "change of unknown origin, Sep 22: …". The name always carries the engine's
**full** label. The badge has a `title` with the same text, so hovering shows it.

### 7.2 Short versions

A version change is shown short, the full version in the accessible name and the hover tip. The canvas shortens only
events with `kind === "version"` whose `from` and `to` both parse; anything else (model names such as "gpt-6 →
gpt-6-luna", "MCP server added") is shown verbatim.

`shortVersions(from, to)`, in `derive.ts`:

1. Split each into a dotted numeric core and an optional pre-release (`-alpha.4`) and build (`+…`) part.
2. If the cores differ, find the first core component that differs, at index *i*. Show components `0 … max(i, 1)` of
   each core: always at least major.minor, never the pre-release.
3. If the cores are equal, show both versions in full.
4. The row (not the chart) adds a quiet `pre-release` tag (§7.4) when `to` has a pre-release part.

| Engine label | Shown | Tag |
|---|---|---|
| Codex 0.144.0-alpha.4 → 0.145.0-alpha.18 | Codex 0.144 → 0.145 | pre-release |
| Codex 0.142.5 → 0.144.0-alpha.4 | Codex 0.142 → 0.144 | pre-release |
| Claude Code 2.1.274 → 2.1.277 | Claude Code 2.1.274 → 2.1.277 | |
| Codex 0.158 → 0.160 | Codex 0.158 → 0.160 | |
| Codex 0.145.0-alpha.17 → 0.145.0-alpha.18 | Codex 0.145.0-alpha.17 → 0.145.0-alpha.18 | pre-release |

The agent's name stays at the front in tables and on the Report page ("Codex 0.144 → 0.145"). It is dropped where a
side label already names the agent: chart labels, which show only the new version ("0.145"; `shortLabel()` today
shows `e.to` in full).

The Markdown report the toolbar copies keeps full versions and its text glyphs ("▲B"): an issue needs the exact build,
and the terminal and the report cite the letter.

### 7.3 Markers in charts

- Yours sit above the rule, the agent's below, unknown on it (unchanged). The connector rules are unchanged.
- **Labels.** On the **Finding** chart only these get a label: your changes, any filled agent badge, and the newest
  agent update. Routine updates in between are unlabelled (their badge, hover tip and the chart's text description
  still name them). On the **Timeline** chart every badge tries a label, and today's collision rule (`strip()`: a
  label goes only where it overlaps nothing, else it is dropped) decides.
- Label text: your change → today's `shortLabel()` words ("effort", "MCP"); the agent's → the short new version.
  typedSm 12, `ink.secondary`.
- **Legend.** One line under every chart that has badges, `small`, built from what the chart actually shows: a tick
  and "one error"; your badge and "your change"; a hollow agent badge and "Claude Code update"; and, when a filled
  agent badge is on the chart, a filled one and "lines up with the shift" (or "a candidate"). The legend draws the
  real 18 px badges: badges are never scaled down. With ranges on the chart (below) it adds a range of each side
  ("several of your changes, first–last", "several Claude Code updates, first–last"), and with changes of unknown
  origin the tick ("changes of unknown origin that day").
- **Crowded lanes** (added 2026-10-07, after a real install drew dozens of changes on each side, some of unknown
  origin, over one Finding chart: the badges ran past the chart's end and over each other). Each lane holds at
  most one mark a day (`laneMarks()` in `charts.ts`; the popover and desktop panel strips do the same in
  `StripLayout.laneMarks`):
  1. A day with one change on a side keeps its badge. Several become one **range**: the side's shape, as tall as a
     badge and as wide as its label, labelled with the first and last marker ("18–21", "X–Z"). Markers on a side are
     numbered in time order, so a range's markers are consecutive; its label never claims a change drawn elsewhere.
  2. A change that **lines up with the shift** (an open candidate), and an agent change that isn't a routine update
     (filled, often the agent-side finding's cause), never joins a range: it keeps its own numbered or lettered badge
     at its own day. The day's other changes before and after it form their own ranges beside it.
  3. Neighbouring marks whose boxes would overlap by more than a 4 px nudge (with their 2 px gap) merge into one range
     over their days, cascading. Two badges on neighbouring days that nearly fit (the 42-day chart has 18.9 px a day)
     stay two, nudged apart. Then every mark is placed with the least movement that keeps the gap, a kept change held
     at its day, and nothing passes the lane label or the chart's end; a mark that still sits more than half a badge
     from its days (nudges add up along a run) joins the neighbour that pushed it.
  4. Your ranges hang a dashed **comb**: from under the range to the case line at each of its days. The agent's lane
     keeps no connectors; its range marks the days it covers with a thin bar on the underside of the line.
  5. Changes of **unknown origin** are one faint tick a day across the line (no "?" circle, which ran into the agent's
     badges). Rows keep the "?" badge.
  6. Short labels as above: a range of yours says its kinds when it has one or two ("MCP, mode"), the agent's its
     newest version; the collision rule decides.
  The chart only groups: the strip's text description, the per-day hover tips, each mark's hover tip (a range lists
  every change in it with its marker and full label), the change lists, Copy Report and the terminal still name every
  change with its own marker, and the markers themselves are assigned as before (the canvas over the whole timeline).
  The strip is drawn at 960 wide and scales with the window, so the collision rule runs at that width: at 28 days
  (28.3 a day) one badge a day fits and only ranges merge; at 42 days (18.9 a day) single badges on neighbouring days
  are nudged, ranges merge. The popover (14 days in 300 pt) and the desktop panel (14 days in 156 pt, where any two
  neighbouring days merge) follow the same rule; the glance carries no candidates, so only agent changes that aren't
  routine updates are kept on their own there.

### 7.4 Markers in rows

A change row is: date (typedSm, `ink.secondary`) · badge · label (body 15; short version per §7.2) · at most one quiet
tag. "(update)" is gone: the hollow badge already says the update is routine, and the one routine footnote under the
list says what that means.

The **quiet tag**: `small`, `ink.secondary` on `surface.well`, radius 3 (`radius.chip`), 2 px × 6 px padding. Its
words, in priority order: "lines up with the shift" (on the finding's side; on `party.<side>.tint`), "a candidate"
(neutral `surface.selection`), "ruled out", "wasitme's own change", "origin unknown", "pre-release". Nothing else
becomes a tag.

---

## 8. Pages

Each page lists what is visible by default, what sits behind which disclosure, what moved elsewhere, its word budget
(visible words, measured as in §14), and the UI-owned copy that changes. Copy keys are under `copy.canvas` in
`tokens.json` (§11); `{…}` are placeholders the canvas fills in.

### 8.1 Finding

[Wireframe](ux-v2/finding.txt). Budget: **130** visible words for `insufficient`, `none`, `unclear`, `you` (demo
today: 421; about 36 of the 130 are the chart's own labels and dates); **270** for `agent`, whose Details start open.

**As built (measured on the first v2 render, §14):** `insufficient` 132 on `wasitme demo` and 122 on the
`insufficient-timeline` golden; `you` 119; `agent` 272 on `wasitme demo --case agent` and 276 on the
`agent-by_elimination` golden. Nothing left could go without breaking a §12 hold (the noise band, the unlock gate's
no-date line, What was checked, the confidence line, the routine note), so the budgets are raised to the measured
counts: **135** and **280**. `ui/test/render.mjs` enforces every page's budget on the `insufficient-timeline` golden
(the shape of `wasitme demo`; the lifted glance goldens carry no daily strip) and the agent budget on its golden. The
same render raised Compare's budget (§8.3) from 200 to **220**: 184 on `wasitme demo`, 219 on that golden, whose open
ledger has more signals.

**Visible by default**

1. Chip + meta line: the state chip (as today), then `small` `ink.secondary` "Last 14 days against the 4 weeks before"
   (`finding.window`; the agent's name is dropped, the toolbar shows it). A pending finding adds "Holding this state
   until the next check agrees." (`finding.pending`, unchanged).
2. **Title** (display 52): the state headline from `tokens.json` `states.*.headline` (D67: title = the state).
3. **Deck** (deck 17): the engine's `headline`, verbatim.
4. **The chart:** the headline metric's daily strip over 28 days, on the case line, with the badges (§7.3). Above it,
   the section head "Tool errors per day" and, right-aligned, the one ratio line, **always visible** because it is
   the noise band (rule 4): "×0.75, range ×0.40 to ×1.41; changes under ×2.5 wouldn't show" (`tokens.json`
   `chart.ratio.oneLine`, unchanged). Below it the window brackets ("before: last 14 of 28 days shown", "recent, 14
   days") and the legend (§7.3). **No k row and no n row** by default (Daily counts, below).
5. **Next block:**
   - `insufficient` with an unlock gate: "Next to unlock" (body bold), the metric and its counter in typedSm ("Reads per
     edit 31 of 40 edits", "Tool errors 7 of 10 session-days": the binding pair, docs/CONTRACT.md#display-rules; with no
     pair short, the reason words and no bar), the 40-cell progress row from the same pair (`progressRow`), then "No date yet: it depends on how your
     sessions go." (`finding.noDate`, D66, unchanged), then the engine's `tryThis` (or the fallback `finding.nextFallback`).
   - every other state: "Next" (body bold) and the engine's `tryThis`, when there is one.
6. **The disclaimer** for `none`, `you` and `agent`: `small`, `ink.secondary`, verbatim (`copy.disclaimer`). It
   closes the visible block, so a screenshot of the default view always carries it.

**Disclosures**, in this order:

| Disclosure | Key | Default | Contents |
|---|---|---|---|
| Details | `disclosure.details` | closed; **open when the state is `agent`** (D44 5b: that screen gets shared) | The engine's `because` (D67: the note, verbatim, `small`); then the state's panel: "What was checked" (agent, today's `checkedRows`), "Next to unlock" detail ("Each window needs at least 10 session-days." in the counter's own unit, `finding.unlockEachWindow`, + `finding.unlockThenFamily` / `finding.unlockThenMetric`), "Before Codex can be compared" (timeline only); then "Changes in the recent window" (today's lanes as a row list, §7.4, with their tags); then the engine's `confidence` line; then the observation note. |
| What wasitme compared | `disclosure.compared` | closed | Today's ledger (`ledger()`), restyled per §6, with the counts, the change and range, the forest plot, the status and the line-up badge; its key line (`ledger.key`) under it. |
| Daily counts | `disclosure.dailyCounts` | closed | The k row and n row for the strip's days, as a small two-row table aligned to the chart's columns, plus `legend.narrow` ("narrow column: under 100 tool calls that day"). **As built:** one small table per two weeks (day, k, n), side by side: at six weeks (the Timeline) a three-digit n doesn't fit a 19 px day column, and a real table reads better with a screen reader. |
| How wasitme decided | `disclosure.decided` | closed | The engine's `trace`, one line each, the matched one marked "this decided it" (as the Report page does today). |

**Removed from this page:** the two lanes beside the case rule and the side panel (both now in Details); the mirror
layout that hangs the title above or below the rule for `you` and `agent` (§13, P2; in the agent render the title sat
under a "ruled out" row, so the answer was not first); the stamp and the top bar (§3). The state's side is still
encoded three ways at the top: the chip's colour and glyph, the title's words, and the filled badge on its side of the
chart's rule.

**Stale** (`display === "stale"`): chip "Out of date", title "Out of date.", deck `finding.staleDeck` ("This is the
last known state, not a current one."), the reason in `small` (`finding.staleFuture` / `staleUnknown` / `staleAge`),
then the last known chart and disclosures in the existing `.lastknown` treatment.

**Timeline only** (calibration pending, e.g. Codex): chip "Timeline only", title "Timeline only, for now.", the engine's
deck, then the events-only case line (no strip, no ratio line: there is no comparison), the legend, and the
disclosures "Details" (the panel "Before Codex can be compared": `finding.codexWait` or `finding.codexNotRun`, and
`finding.codexNext`) and "All changes ({n})" (§8.2's list).

### 8.2 Timeline

[Wireframe](ux-v2/timeline.txt). Budget: **100** visible words (today 288; about 45 are the chart's labels and dates).

**Visible by default**

1. Title "Timeline".
2. **The finding line** as the page's one sentence (D28: a timeline-led page still says where the finding stands):
   the state chip, the engine's deck in body 15, and a plain link "See the finding" (`seeFinding`). With no live
   document it is left out, as today.
3. **The chart:** the headline metric's strip over six weeks (42 days), ticks on, badges labelled (§7.3), section
   head "Tool errors per day" with the dates right-aligned ("Aug 23 – Oct 3"), brackets, legend. No k or n row. An
   agent with no strip gets the events-only case line, as today.

**Disclosures**

| Disclosure | Default | Contents |
|---|---|---|
| All changes ({n}) | closed | Every change, newest first, in two groups with a `small` group head: "Recent window · Sep 20 – Oct 3" and "Before · Aug 23 – Sep 19" (then "Earlier" and "After the windows" when present). Each row per §7.4: date · badge · label · tag. The **Note** and **Window** columns are gone: the group says the window, the tag says the rest, and "Claude Code update" is no longer repeated on every row. Under the list, once: `routineNote` ("Claude Code updates alone aren't evidence."). wasitme's own (meta) rows keep their dim style and the tag "wasitme's own change". |
| Daily counts | closed | The k and n rows for the 42 days, and the two window totals today's header shows ("before 201 / 5,610 calls; recent 88 / 3,290"). |

**Removed:** the page note "everything wasitme saw change on each side, over the tool errors strip it is compared
with"; the top bar's "Showing / signal / over" fields (the chart head says the signal and the dates).

### 8.3 Compare

Budget: **200** visible words (today 323). Compare is the evidence page, so its table stays open.

**Visible by default**

1. Title "Compare".
2. Deck: "Recent {recent} days against the {baseline} before." (`compare.deck`; `{baseline}` is "4 weeks" when the
   days are a multiple of 7 and at least 14, as `contextLine()` does now). With no window: `compare.noWindow`
   ("{agent} has no comparison window yet; the Timeline is all there is to compare.").
3. **The ledger**, every signal (today's `ledger(a, a.metrics, "Signal")`), restyled: status words in serif; the family
   ("errors", "research", "context") as a `small` second line under the signal name, not an italic aside; counts and
   ranges in typedSm; the forest plot and its axis unchanged. Under it the key line (`ledger.key`) and the engine's
   confidence line, both `small`.

**Disclosures**

| Disclosure | Default | Contents |
|---|---|---|
| Day by day, before and recent | closed | Today's two half-width strips (before, last 14 of 28 days; recent) with their totals, k and n rows on (this disclosure is the place for the day-level numbers). |

**Removed:** the preset chip "Recent 14 days vs the 4 weeks before" (the deck says it); the note "other windows come in
a later version" (a plan, not evidence).

### 8.4 Setup

Budget: **95** visible words (today 148). Raised from 80 to the measured count by D80: the table has a row for every
part a real scan records (11 for Claude Code, in the order of `SETUP_KEYS`, [CONTRACT.md](../CONTRACT.md#setup-keys)); the 80
was met on a golden with six rows no scan writes; a scan of synthetic logs (with a one-line synthetic CLAUDE.md) gives
a 92-word Claude Code page.

**Visible by default**

1. Title "Setup".
2. Deck: "Your {agent} setup now, and when each part last changed." (`setup.deck`).
3. **The table**: part (body) · now (typedSm bold) · badge of the last change · last change (typedSm date, then
   `small` "from 5" when the engine gives a `from`). A part with no recorded event reads "none recorded"
   (`setup.noneRecorded`; was "unchanged in the timeline"). Under it the observation note in `small`.
4. A plain link: "See every change on the Timeline" (`seeTimeline`).

**Moved:** the six-week "What changed" chart is removed here because the Timeline page draws the same events on the
same axis (this is the one deletion; every event stays on Timeline). "Coverage" moves to Sources (it repeated the
Sources table's files and days). "Privacy" moves to Settings → Privacy.

### 8.5 Report

The Report page previews a document, so it stays whole: it is the one page that scrolls by design. No budget; the
target is the demo's 386 visible words or fewer.

1. Title "Report"; deck "What Copy Report puts on your clipboard: numbers only, no prompts, code or paths."
   (`report.deck`). The page's own Copy and Open buttons go (the toolbar has them, §3).
2. **The sheet**, in the engine report's order (unchanged): finding, What was checked (agent), What moved, the daily
   table, Timeline, How wasitme decided, Next. Its width is at most 720 px.
3. **Changes in the sheet:**
   - The finding line's Menlo text glyph (`code.tglyph`, "·┄·") becomes the drawn state glyph at 16 px, then the label
     in bold and the deck.
   - **The Timeline list** (report item 4) uses the §7.4 row: date · badge · short label · tag. "(update)" is gone; a
     candidate keeps its words as the tag ("lines up with the shift", "ruled out: the numbers moved where it didn't
     apply"). The heading loses its legend in parentheses ("(■ your side, ▲ Claude Code, ? origin unknown)") because
     the badges are drawn; one `small` legend line under the list replaces it.
   - Section heads use `section`; table headers `small` upright; the footer `small` serif.

### 8.6 Sources

Budget: **60** visible words (today 95).

**Visible by default**

1. Title "Sources"; deck "What wasitme read on this Mac." (`sources.deck`).
2. **One row per agent**: name (body) · status word (serif; "Read", "No logs found", "Permission denied", "In a
   protected folder", "Unreadable") · typedSm "16 log files · Aug 23 – Oct 3". When anything was set aside, a `small`
   line under the row: "{n} lines set aside" (`sources.setAside`; bad lines + cut-off last lines + unknown records;
   duplicates are not "set aside", they are counted once).
3. **Paused indicators**, only when there are any: one row per pause, "{metric}: {why}" (today's `PAUSE_WHY` words).
   When none is paused nothing is shown (today: a whole panel saying "None").

**Disclosures**

| Disclosure | Default | Contents |
|---|---|---|
| What was set aside | closed | Today's full table: files, bad lines, cut-off last lines, duplicates, days, unknown record types. |
| Scan and calibration | closed | Last scan (finished / failed with the reason, and the time it was checked); Sandbox; Log readers ("8 readers recorded; `wasitme doctor` lists their versions"); the engine version ("wasitme 0.1.0"); Calibration per agent (today's words); and "Read in the last 14 days": exchanges, session-days, sessions (today's sidebar block). |

### 8.7 Settings

[Wireframe](ux-v2/settings.txt). Budget: **180** visible words (today 142 words of prose and no controls). The full
spec is §9.

---

## 9. Settings

### 9.1 Layout

Title "Settings"; deck "wasitme {version} · local only" (`settings.deck`; the version from `doc.engine`, omitted when
unknown). Then five groups, each a `section` head and a grouped list: rows separated by `rule.hair`, the group boxed
by a 1 px `rule.strong` edge with `radius.control`, on `surface.raised`.

A **row** is 56 px or taller: on the left the title (body 15) and one description line (`small`, `ink.secondary`, at
most 12 words); on the right the state word (`small`) and one control. Buttons are the existing `.btn` (mono bold 13,
ink outline, `size.button.height`), labelled with an ellipsis when they open a confirmation (Mac convention). A
**toggle** is a native-looking switch drawn in the canvas: 36 × 20, track `rule.strong` off / `accent.action` on, knob
`surface.raised`, `role="switch"`, `aria-checked`, the row title as its name. While an action runs, its row shows
"Working…" (`settings.working`) in place of the state word and every control in the group is disabled.

A control the app cannot perform yet is drawn **disabled** with its reason as the row's description, in `ink.muted`
(e.g. "Updates arrive with the first public release."). There is never a Terminal how-to in Settings.

### 9.2 Groups and rows

`id` is the value the bridge carries (§10). The state comes from `view.settings` (§10.2), never guessed by the canvas.

**Integrations** (`settings.group.integrations`)

| Row | id | Description (`small`) | States → control |
|---|---|---|---|
| Menu bar app | `app` | This app: the finding in your menu bar. | On → "Remove…" |
| Desktop panel | (toggle) | A small finding panel on your desktop. | switch, `setDesktopPanel(value)` |
| Claude Code plugin | `claude-plugin` | The /wasitme pane, and a check when sessions start and end. | On → "Remove…" · Off → "Add…" · Unavailable ("Claude Code isn't installed.") → none |
| Status line | `statusline` | The finding in Claude Code's status line. | On → "Remove…" · Off → "Add…" · Own ("You have your own status line; wasitme leaves it alone.") → none · Unavailable → none |
| Codex skill | `codex-plugin` | Lets Codex print the wasitme report. | On → "Remove…" · Off → "Add…" · Unavailable ("Codex isn't installed.") → none |
| Background scan | `scan` | Checks every 15 minutes, at low priority. | On → "Turn Off…" · Off → "Turn On…" (same actions: `removeIntegration` / `addIntegration`) |

A state the app cannot read (no install record) shows "Unknown" and the reason "No install record; run the installer
once." with no control.

**General** (`settings.group.general`)

| Row | Description | Control |
|---|---|---|
| Launch at login | Open wasitme in the menu bar when you log in. | switch, `setLaunchAtLogin(value)` |
| Updates | "wasitme {version}." Until a public release exists, the description is "Updates arrive with the first public release." | "Update…", `updateApp`; disabled until `view.settings.update.available` |

What "Launch at login" is, exactly: the installer's app LaunchAgent (`dev.wasitme.menubar`) has `RunAtLoad` true and
`KeepAlive` `{SuccessfulExit: false}` (`scripts/lib/macos.sh`), so today the app starts at login and launchd restarts
it if it crashes. **Off** means the agent no longer starts the app at login; you open wasitme from Applications when
you want it; the background scan is a separate LaunchAgent and keeps running. The running app is not quit: the change
applies from the next login. The switch shows the setting recorded in the install manifest, not a guess.

**Data** (`settings.group.data`)

| Row | Description | Control |
|---|---|---|
| Saved history | `~/.wasitme`: numbers and dates only. | "Show in Finder", `revealDataFolder` |
| Clear history | Deletes the saved numbers. Your agent logs are never touched. | "Clear History…", `clearHistory` |

**Privacy** (`settings.group.privacy`). No rows, two sentences and a disclosure:

- `copy.privacyLine`, verbatim: "No network code. Only the installer downloads, and only when you run it."
- `settings.privacyReports`: "Reports hold numbers only: no prompts, code or paths."
- Disclosure **"What the Claude Code plugin can do"** (`disclosure.pluginCalls`, closed). It opens with
  `settings.pluginIntro`, "It runs inside Claude Code with your permissions, and can only:" (D50's disclosure), then
  one line per capability in words, then the raw calls in typedSm under a `small` "Exact calls:" lead, so the frozen
  list (D50) stays on screen:

| Words (`settings.pluginCan.*`) | Calls / hooks it covers |
|---|---|
| Re-read wasitme's status once a minute. | `$.clock.every` |
| Read the time, to tell when the status is out of date. | `$.clock.now` |
| Add the /wasitme command. | `$.command.register` |
| Read one file: wasitme's status file. | `$.fs.read` |
| See that file's size and when it changed. | `$.fs.stat` |
| Remember what it last showed. | `$.state.get`, `$.state.set` |
| Open, draw and close its own pane. | `$.ui.open`, `$.ui.resolve`, `$.ui.close` |
| When a session starts or ends, ask wasitme to check now. | SessionStart, SessionEnd hooks (`launchctl kickstart`) |
| When a session starts, note whether six setup files exist in the project (CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md, .claude/settings.json, .claude/settings.local.json, .mcp.json), keeping a salted fingerprint, size and line count: never their contents. | SessionStart hook (`engine/src/store/projsnap.ts` `PROJECT_FILES`) |

  The last two lines are new: today's Settings lists only the mod's calls, but the plugin's shell hooks also run
  (`plugin/hooks/hooks.json`), and a privacy section that leaves them out is incomplete. `MOD_CALLS` and its test in
  `ui/test/model.test.mjs` stay; a new `MOD_CALL_WORDS` map is tested to cover exactly `ALLOWED_CALLS`
  (`plugin/tests/check-calls.mjs`), and the hook lines to cover exactly the hooks in `hooks.json`.

**Uninstall** (`settings.group.uninstall`)

| Row | Description | Control |
|---|---|---|
| Uninstall wasitme | Removes every part and restores what wasitme changed. | "Uninstall…", `uninstallAll` |

### 9.3 Confirmations

**Native.** Every action that changes something outside this window goes through an `NSAlert` sheet on the Control
Center window before anything runs. The canvas only ever sends the action's name and id; the sheet's words come from
`Tokens.Copy.App` (§11), never from the page. Destructive ones set `hasDestructiveAction` on the first button. Cancel
is always the Escape button, and Cancel changes nothing.

| Action | Sheet title | Informative text | Buttons |
|---|---|---|---|
| `addIntegration(claude-plugin)` | Add the Claude Code plugin? | wasitme registers its plugin with Claude Code. Settings › Privacy lists everything it can do. | Add · Cancel |
| `addIntegration(statusline)` | Add the wasitme status line? | Claude Code's settings file is backed up first, and your own status line is never replaced. | Add · Cancel |
| `addIntegration(codex-plugin)` | Add the Codex skill? | Codex gets a skill that prints the wasitme report. It has no hooks. | Add · Cancel |
| `addIntegration(scan)` | Turn on the background scan? | wasitme checks every 15 minutes, at low priority. | Turn On · Cancel |
| `removeIntegration(app)` | Remove the menu bar app? | The menu bar icon and this window go away. The background scan, the plugins and the wasitme command stay. | Remove (destructive) · Cancel |
| `removeIntegration(claude-plugin)` | Remove the Claude Code plugin? | Claude Code loses the /wasitme pane, and sessions no longer ask wasitme to check. Your history stays. | Remove (destructive) · Cancel |
| `removeIntegration(statusline)` | Remove the wasitme status line? | Your earlier status line comes back, if the setting is still wasitme's. | Remove (destructive) · Cancel |
| `removeIntegration(codex-plugin)` | Remove the Codex skill? | Codex loses the wasitme report skill. Your history stays. | Remove (destructive) · Cancel |
| `removeIntegration(scan)` | Turn off the background scan? | wasitme then checks only when you click Check Again. | Turn Off (destructive) · Cancel |
| `clearHistory` | Clear wasitme's history? | This deletes the numbers saved in ~/.wasitme. Your agent logs are not touched. The next check re-reads the logs still on this Mac; changes in logs that are gone can't come back. | Clear History (destructive) · Cancel |
| `uninstallAll` | Uninstall wasitme? | This removes the app, the background scan, the plugins, the status line it set and the wasitme command, and restores what it changed. Your agent logs are never touched. Your saved history in ~/.wasitme is kept unless you tick the box. Checkbox (accessory view, off by default): "Also delete my saved history" | Uninstall (destructive) · Cancel |
| `updateApp` | Update wasitme? | The installer downloads the newer release, keeps the parts you have, and reopens wasitme. | Update · Cancel |

`setDesktopPanel`, `setLaunchAtLogin` and `revealDataFolder` run without a sheet: they change nothing outside wasitme
and undo with one more click.

After an action, native re-reads the state and re-renders. A failure shows a second sheet with the tool's one-line
reason and "Nothing else was changed." when that is true.

### 9.4 What each control runs

| Action | What runs | Exists today? |
|---|---|---|
| Reading the states (`view.settings`) | `sh ~/.wasitme/current/scripts/install.sh --status --json`, run by the app with a fixed argument list (synchronous, reads only, exit 0): `{ "schema": "wasitme.install-status/1", "installed", "version", "integrations": [{ "id", "state", "why"? }], "launchAtLogin": null, "update": { "available", "why"? } }`, with the ids, states and `why` codes of §10.2: each part's state from the install manifest plus the probes the installer already makes (is Claude Code / Codex installed, does the user have their own status line). The app never reads `~/.claude`, `~/.codex` or their settings itself. The desktop panel's state is the app's own. | **Yes**, except the launch-at-login choice (always `null` until `setLaunchAtLogin` exists) |
| `setDesktopPanel(value)` | In-app: `DesktopPanelController.show()` / `hide()` and its remembered preference | **Yes** (the status-item menu already toggles it) |
| `revealDataFolder` | In-app: `NSWorkspace.activateFileViewerSelecting` on `~/.wasitme` | Trivial, new |
| `uninstallAll` | `sh ~/.wasitme/current/scripts/uninstall.sh --yes --from-app` (with `--purge` when the box is ticked); the app quits once the command has returned | **Yes** (`--from-app` runs it detached and waits for the app to quit) |
| `removeIntegration(id)` | `sh ~/.wasitme/current/scripts/uninstall.sh --yes --only <part> --from-app`: remove that part, keep the rest and the history, update the manifest, `engine.json` and `engine.env`. Parts: `claude-plugin`, `statusline`, `codex-plugin`, `scan` (or `scan-agent`) → `launchagent` `dev.wasitme.scan`, `app` → `app` and `launchagent` `dev.wasitme.menubar` (the app quits once the command has returned). | **Yes** |
| `addIntegration(id)` | `sh ~/.wasitme/current/scripts/install.sh --add <part> --from-app`: install one part from the installed version in `~/.wasitme/current`, no download, recorded in the manifest. `app` cannot be added this way (it is built from sources the installed copy does not keep). | **Yes** |
| `setLaunchAtLogin(value)` | Proposal: `install.sh --launch-at-login on\|off`, touching only its own `dev.wasitme.menubar` plist. **Off** must drop both `RunAtLoad` and `KeepAlive`: setting `RunAtLoad` false alone is not enough, because `SuccessfulExit` "implies that RunAtLoad is set to true" (`launchd.plist(5)`, read on this Mac). It writes the file without reloading the job, so the running app keeps running and the change applies at the next login; **On** restores both keys the same way. The choice is recorded in the manifest so `--repair` and updates keep it. | **No** |
| `clearHistory` | Engine `wasitme history clear --yes` (run with the node and cli in `engine.json`): under the scan lock, delete the outputs, `history/`, the held decisions and the hook inbox; keep the salt, the install, `engine.json` and settings (exclusions); then the app's Scan now. Exit 0 cleared (or nothing to clear), 1 a scan held the lock (nothing deleted), 2 no `--yes` without a terminal. | **Yes** |
| `updateApp` | `sh ~/.wasitme/current/scripts/install.sh --update --from-app` (the newer release): install the parts the manifest lists (no new ones, none dropped), rebuild and replace the app, then quit the running app and start it again in the background. The same mode updates a local build (`sh <checkout>/scripts/install.sh --from <checkout> --update`, with `--no-relaunch` to leave the app closed), which is what report item 7 needs. Launch-at-login does not exist yet, so there is no choice to keep. | **Yes**, but it needs a published release (until then it fails with "no published release URL yet") |

Rules for native when it runs any of these:

- Fixed argument lists only, built from the closed `id` enum; nothing from the page reaches a command line.
- The installer and uninstaller can stop the app's own LaunchAgent. Started as plain children of the app, they could
  be killed with it: "When a job dies, launchd kills any remaining processes with the same process group ID as the
  job" unless `AbandonProcessGroup` is set (`launchd.plist(5)`, read on this Mac; the effect on the app's children
  was not tested). Run them detached in their own session, and quit the app only after they have started.
- **Shipping rule:** a control ships enabled only in the same change as its backing. Until then it is drawn disabled
  with the reason `settings.notYet` ("Not available in this version.").

---

## 10. Bridge

### 10.1 Canvas → native

`BridgePolicy.allowedKeys` grows from `action, page, agent` to `action, page, agent, id, value`. Each action accepts
exactly the keys listed and rejects any other key; `id` must be one of the enum below, `value` must be a JSON boolean.

| Action | Keys | Decision |
|---|---|---|
| `ready`, `scanNow`, `copyReport`, `openMarkdown` | none | `.perform` (unchanged) |
| `showPage` | `page` | `.perform` (unchanged; the canvas has no page links left except "See the finding", "See Sources", "See every change on the Timeline") |
| `selectAgent` | `agent` | `.perform` (unchanged; only the full chrome's switcher sends it, and the app no longer shows that chrome) |
| `addIntegration` | `id` ∈ {`claude-plugin`, `statusline`, `codex-plugin`, `scan`} | `.confirm` |
| `removeIntegration` | `id` ∈ {`app`, `claude-plugin`, `statusline`, `codex-plugin`, `scan`} | `.confirm` (destructive) |
| `setDesktopPanel` | `value` | `.perform` |
| `setLaunchAtLogin` | `value` | `.perform` |
| `revealDataFolder` | none | `.perform` |
| `clearHistory` | none | `.confirm` (destructive) |
| `uninstallAll` | none | `.confirm` (destructive) |
| `updateApp` | none | `.confirm` |
| `toggleSection` | `section` | **never posted**: handled in `main.ts` (§5). If it ever reached native it would be rejected as an unknown action. |

`DestructiveAction` is replaced by a `ConfirmAction` enum carrying the id (`.addIntegration(IntegrationID)`,
`.removeIntegration(IntegrationID)`, `.clearHistory`, `.uninstallAll`, `.updateApp`). The old names `deleteHistory`
and `uninstall`, and `removeIntegration` without an `id`, become unknown actions and are rejected. The Swift tests
in `BridgePolicy` gain one accept and one reject case per action and key (a wrong `id`, a string `value`, an extra
key). A hostile or stale page can at most open a confirmation sheet whose words it does not control.

**As built (the agreed names, after the 2026-10-06 merge).** `BridgePolicy.actionKeys`
(`macos/Sources/WasitmeUI/Canvas/CanvasBridge.swift`) accepts either spelling per action, never both in one message:
`integration` or §10.1's `id`, `enabled` or §10.1's `value`. The canvas posts the first spelling (`ui/src/main.ts`), and
`ui/test/model.test.mjs` reads `actionKeys` from CanvasBridge.swift and `IntegrationID` from
`macos/Sources/WasitmeCore/Setup/SetupCommand.swift` and holds every posted message to them:

| Action | Keys as built |
|---|---|
| `addIntegration`, `removeIntegration` | `integration` ∈ `IntegrationID`: `app`, `scan`, `claude-plugin`, `codex-plugin`, `statusline`, the same ids as `install.sh --status`, `--add` and `uninstall.sh --only`. Native also takes `scan-agent` (the installer's install flag) as `scan`; the canvas sends `scan`. `addIntegration` with `app` is rejected (only the installer builds the app). |
| `setLaunchAtLogin`, `setDesktopPanel` | `enabled`, a JavaScript boolean (`BridgePolicy.strictBool`) |
| `clearHistory`, `uninstallAll`, `updateApp`, `revealDataFolder` | none |

Native sends `view.settings` and accepts `setDesktopPanel` and `revealDataFolder` since the same merge, so every
Settings control is live where its state allows.

### 10.2 Native → canvas (`view`)

The `view` object is not the shared contract (`contract/` has only the snapshot and glance schemas). New fields:

```json
"chrome": "content",
"settings": {
  "version": "0.1.0",
  "integrations": [
    { "id": "app", "state": "on" },
    { "id": "claude-plugin", "state": "on" },
    { "id": "statusline", "state": "own" },
    { "id": "codex-plugin", "state": "unavailable", "why": "agent_missing" },
    { "id": "scan", "state": "on" }
  ],
  "desktopPanel": true,
  "launchAtLogin": true,
  "update": { "available": false, "why": "no_release" },
  "busy": null
}
```

`state` ∈ `on | off | own | unavailable | unknown`; `why` ∈ `agent_missing | no_install_record | no_release |
not_supported`; `launchAtLogin` may be `null` (unknown → the switch is disabled with "Set by the installer."); `busy` is
the id or action name running now, or `null`. Every word the row shows is the canvas's own, picked from these codes;
`view` carries no sentences. Paths are never sent: the canvas prints the fixed `~/.wasitme`. Native fills `integrations`
and `launchAtLogin` from `install.sh --status --json` (§9.4), re-read when the Settings page opens and
after every action; until that mode exists every state is `unknown` and the controls stay disabled.

**As built (canvas side, `ui/src/view.ts`).**

- `view.launchAtLogin` is sent today as a top-level string, `LaunchAtLoginState`: `on`, `off`, `needsApproval`,
  `viaInstaller`, `unavailable`. The canvas reads it first; `settings.launchAtLogin` (`true` / `false` / `null`)
  answers only when the top-level value is missing or `unavailable`. The switch is live for `on`, `off` and
  `needsApproval`. For `viaInstaller` it shows on, disabled, with "Set by the installer.". For anything else it is
  disabled with "Not available in this version.".
- `view.settings` present means native performs **every** §10.1 action, including `setDesktopPanel` and
  `revealDataFolder`. Without it, every Settings control except the launch-at-login switch is drawn disabled with
  "Not available in this version.", and no integration shows a control (its state is unknown).
- `integrations[].id` may be `scan` or `scan-agent`. Values outside the vocabularies above read as `unknown`. A
  `busy` value that isn't an id or action name is ignored.
- Native's `view.settings` (`SettingsState.viewObject`) also carries `installed`, `answered` and `canClearHistory`,
  and the canvas reads them (a test holds `view.ts` to every key `viewObject` sends). `answered: false` (the installer
  has not answered yet, or `--status` failed) and `installed: false` disable every control the installer runs (add,
  remove, update, uninstall) with "Not read yet; open Settings again to retry." or "No install record; run the
  installer once." (while not answered, the integration rows say "Unknown" and keep their own words, so that reason
  shows only on Updates and Uninstall instead of on every row); `canClearHistory: false` disables Clear History. Any `busy` value disables every setup change
  (native runs one at a time, including a run another copy of the app started, which it reports as
  `addIntegration` / `removeIntegration` / `updateApp` / `uninstallAll`); Show in Finder stays live.

---

## 11. Copy and tokens

### 11.1 Where it lives

- **Canvas words** go in `tokens.json` → `copy.canvas`. `ui/scripts/gen.mjs` exports them as `CANVAS_COPY` in
  `ui/src/gen/design.ts` (today it exports only five `copy` strings). Nothing in `pages.ts` composes a user-visible
  sentence that is not a `CANVAS_COPY` template or an engine string.
- **Native words** (sidebar, toolbar, menus, the §9.3 sheets) go in `copy.app`; `design/system/gen/gen-swift.mjs` emits
  them as `Tokens.Copy.App` (today `Tokens.Copy` has five strings).
- Bump `tokens.json` `version` to 3.3.0, regenerate (`node design/system/gen/build.mjs`), and run the sync scripts
  (`engine/scripts/sync-design.mjs`, `plugin/tests/fixtures/sync.mjs`, `macos/scripts/sync-design.mjs`); the
  tokens-sync tests fail on a stale copy.
- The copy lint must reach the new strings. `design/system/gen/test.mjs` `copySources()` lints a fixed list of keys
  today (the states, four `copy` strings, the app states, the demo data), so it gains a walk over every string under
  `copy.canvas` and `copy.app`. The generated `ui/src/gen/design.ts` and `Tokens.Copy.App` are also in
  `scripts/lint-copy.mjs`'s copy scope (`ui/`, `macos/`). Every new string in this spec passes the banned list (checked by
  running `scripts/lint-copy.mjs --as copy` over this whole document, which finds no banned word).

### 11.2 Word budgets

Engine strings are shown verbatim and can't be shortened here (they live in `contract/` goldens). Measured on every
`wasitme demo --case` (insufficient, none, unclear, you, agent, codex) and every snapshot and glance golden: the
longest deck is **13** words, the longest note **28**, the longest next step **17**, the longest confidence line
**23**. The budgets below hold for all of them today; a test keeps it that way (§14).

| String | Owner | Budget |
|---|---|---|
| Title | tokens (`states.*.headline`) | 4 words |
| Deck (`headline`) | engine | 14 words |
| Note (`because`) | engine | 30 words (in Details, `small`) |
| Next step (`tryThis`) | engine | 18 words |
| Any UI-owned sentence in `copy.canvas` | canvas | 14 words. Exceptions, each named in the test: `ledger.key` (20: it defines four marks), `settings.pluginCan.projectFiles` (it must name all six files), and the composed "What was checked" rows (they embed engine labels) |
| A Settings row description | canvas | 12 words |
| A confirmation's informative text | native | 45 words |

### 11.3 Old → new

UI-owned strings in `pages.ts` today, what they become, and their key under `copy.canvas`. Placeholders: `{agent}`,
`{n}`, `{recent}`, `{baseline}`, `{metric}`, `{why}`, `{age}`, `{version}`.

| Today | v2 | Key |
|---|---|---|
| "demo data (wasitme demo) — not from your logs" (stamp) | "Demo data from `wasitme demo`, not from your logs." (banner) | `demoBanner` |
| "Last scan failed (timed out). See Sources" | unchanged | `scanFailed` ("Last scan failed{why}."), `scanFailedWhy.*`, `seeSources` |
| "Claude Code, last 14 days against the 4 weeks before" (mono) | "Last 14 days against the 4 weeks before" (serif `small`) | `finding.window` ("Last {recent} days against the {baseline} before"), `finding.noWindow` ("No comparison window yet") |
| "Holding this state until the next check agrees." | unchanged | `finding.pending` |
| "This is the last known state, not a current one." / "The status file is dated in the future. Check your Mac's clock." / "The status file has no usable time." / "Last updated {age} ago." | unchanged | `finding.staleDeck`, `finding.staleFuture`, `finding.staleUnknown`, `finding.staleAge` |
| "Next step" (panel title) | "Next" | `finding.next` |
| "Keep working normally; wasitme checks every 15 minutes." | unchanged | `finding.nextFallback` |
| "Next to unlock" | unchanged | `finding.unlock` |
| "No date yet: it depends on how your sessions go." | unchanged (D66) | `finding.noDate` |
| "Edits in the recent window. … Then wasitme has the second kind of signal a finding needs." | in Details; the first sentence is now "Each window needs at least {need} {noun}." in the counter's own unit (the document does not say which window falls short) | `finding.unlockEachWindow`, `finding.unlockThenFamily`, `finding.unlockThenMetric` ("Then {metric} joins the comparison.") |
| "Before Codex can be compared" | unchanged, in Details | `finding.codexTitle` ("Before {agent} can be compared") |
| "Findings for Codex wait for wasitme's Codex tests to pass; they haven't run yet." | unchanged, in Details | `finding.codexWait`, `finding.codexNotRun` |
| "Keep working normally; the timeline updates every 15 minutes." | unchanged | `finding.codexNext` |
| "What was checked" + rows (Your setup, Workload, The shift, Sample, Not visible) | unchanged, in Details | `finding.checked`, `finding.checkedRow.*` |
| Lane rows; "No recorded change on your side in the recent window." / "No Claude Code update in the recent window." | "Changes in the recent window" list in Details; the two empty-lane lines unchanged | `finding.recentChanges`, `finding.noneYours`, `finding.noneAgent` |
| "updates alone aren't evidence" (lane aside) + "Claude Code updates alone aren't evidence; they are listed so you can see what changed on its side." (footnote) | "Claude Code updates alone aren't evidence." (once, under a change list) | `routineNote` ("{agent} updates alone aren't evidence.") |
| "lines up with the shift" / "a candidate" / "ruled out" (tags) | unchanged, quiet tags | `tag.lineUp`, `tag.candidate`, `tag.ruledOut` |
| "ruled out: the numbers moved where it didn't apply" | unchanged (Timeline list and report) | `tag.ruledOutStrata` |
| "wasitme's own change (not evidence)" / "origin unknown: no command or settings record" | "wasitme's own change" / "origin unknown" (tags; the longer words stay in the badge's accessible name) | `tag.meta`, `tag.unknown` |
| "(update)" on report rows | removed | none |
| — | "pre-release" | `tag.preRelease` |
| "one tick per error; narrow: under 100 calls that day" | legend "▮ one error" + in Daily counts "narrow column: under 100 tool calls that day" | `legend.tick` ("one {unit}"), `legend.narrow` ("narrow column: under {n} {noun} that day") |
| — | legend "your change", "{agent} update" | `legend.you`, `legend.agent` |
| "What wasitme compared" | unchanged (disclosure label) | `disclosure.compared` |
| Ledger headers "recent", "before", "change, range", "status" | "Recent", "Before", "Change", "Status" | `ledger.recent`, `ledger.before`, `ledger.change`, `ledger.status` |
| "Counts are events / opportunities in each window. Bar: the range; dot: the estimate (open: no detectable change); hatched: changes too small to show at your volume." (27 words) | "Counts are events / opportunities. Bar: the range. Dot: the estimate, open when not detected. Hatched: too small to show." (20 words) | `ledger.key` |
| — | "Details", "Daily counts", "How wasitme decided", "All changes", "Day by day, before and recent", "What was set aside", "Scan and calibration", "What the Claude Code plugin can do" | `disclosure.details`, `.dailyCounts`, `.decided`, `.allChanges`, `.strips`, `.setAside`, `.scan`, `.pluginCalls` |
| "Timeline" page note "everything wasitme saw change on each side, over the tool errors strip it is compared with" | removed (the finding line is the sentence) | none |
| "See the finding" | unchanged | `seeFinding` |
| "Tool errors per day, six weeks" / "What changed, six weeks" | "Tool errors per day" with the dates on the right / "What changed" | `chart.perDay` ("{metric} per day"), `chart.changes` ("What changed") |
| "before, 28 days" / "recent, 14 days" / "before: last 14 of 28 days shown" (brackets) | unchanged | `chart.before`, `chart.recent`, `chart.beforePart` |
| Compare note "the recent window against the weeks before it, signal by signal, each with its range; other windows come in a later version" | "Recent {recent} days against the {baseline} before." | `compare.deck` |
| "Claude Code has no comparison window yet; the timeline is all there is to compare." | unchanged ("Timeline" capitalised as a page name) | `compare.noWindow` |
| Setup note "what wasitme can see about your side, and since when" | "Your {agent} setup now, and when each part last changed." | `setup.deck` |
| "unchanged in the timeline" | "none recorded" | `setup.noneRecorded` |
| "No setup recorded yet." | unchanged | `setup.empty` |
| — | "See every change on the Timeline" | `seeTimeline` |
| Report note "a summary of the evidence report. "Copy evidence report" puts the full report on the clipboard as Markdown: numbers only, no prompts, code or paths" (25 words) | "What Copy Report puts on your clipboard: numbers only, no prompts, code or paths." (14 words) | `report.deck` |
| Sources note "what wasitme read, what it couldn't, and what it set aside" | "What wasitme read on this Mac." | `sources.deck` |
| "None. Every indicator wasitme knows is being read." | not shown when none is paused | none |
| — | "{n} lines set aside" | `sources.setAside` |
| Settings note "integrations, data and privacy; removing anything is done from Terminal for now, and the uninstaller asks before each part" | "wasitme {version} · local only" | `settings.deck` |
| Settings paragraphs (Privacy, Data, Integrations, Uninstall) | the rows of §9.2 | `settings.group.*`, `settings.row.<id>.title`, `settings.row.<id>.desc`, `settings.state.*` ("On", "Off", "Yours", "Not available", "Unknown"), `settings.why.*`, `settings.button.*` ("Add…", "Remove…", "Turn On…", "Turn Off…", "Update…", "Show in Finder", "Clear History…", "Uninstall…"), `settings.working`, `settings.notYet` |
| "The Claude Code mod runs inside Claude Code with your permissions and can call only:" + raw list | §9.2's intro, lines in words, then the raw list | `settings.pluginIntro`, `settings.pluginCan.*`, `settings.pluginExact` ("Exact calls:") |
| "Reports contain numbers only: no prompts, code or paths." | "Reports hold numbers only: no prompts, code or paths." | `settings.privacyReports` |

Unchanged and not moved: the state labels and headlines, `CALIBRATION_PENDING`, the app-state titles and `DOC_COPY`
message pages (they move into `copy.canvas.message.*` with their words as they are), `INELIGIBLE`, `PAUSE_WHY`,
`SOURCE_ERR`, `CONFOUNDER`, and `KN_WORDS` (these are data words, also used by the CLI and the app; moving them is a
separate change).

---

## 12. What still holds

| Rule | How v2 keeps it |
|---|---|
| AGENTS.md rule 4: noise bands | The one ratio line (estimate, range, smallest change that would show) stays visible above the Finding page's strip; Compare's ledger stays open with every range and forest plot. Collapsing the Finding ledger never hides the band. The Timeline strip shows raw daily counts and makes no comparison of its own (today it shows window totals, not a ratio); its one sentence is the engine's deck, which for "Too early to tell" names the smallest change that would show. |
| Rule 4: "Too early to tell" / "No detectable change" before an invented cause | Titles are the state headlines, unchanged. No canvas word names a cause; the only causal-sounding words are the engine's, verbatim. |
| Rule 4: no causation without evidence | The deck is the engine's; its evidence (`because`) is one click away in Details, open by default for `agent`. The routine-update note stays under every change list. |
| D67 copy roles | Title = state (tokens), deck = `headline`, note = `because`, each used only in its role and never repeated; the note moves into Details but keeps its role. |
| D66 no projected dates | "No date yet: it depends on how your sessions go." stays beside the progress row. |
| DESIGN.md §3 disclaimer | Visible by default at the end of the Finding block for `none`, `you`, `agent`; verbatim. |
| D59 confidence line | In Finding → Details and under Compare's ledger, verbatim. |
| D44 5b "What was checked" on shareable agent screens | Details is open by default for `agent`. |
| D57 party grammar | Square, numbered, canary, above for you; pointed, lettered, blue, below for the agent (§7). |
| Every number reachable | Strip k and n: hover tip, the chart's hidden text description (`aria-describedby`, unchanged), and Daily counts. Ledger counts: the disclosure on Finding, open on Compare. Full versions: badge name and tip, the Markdown report. Source problem counts: Sources disclosure. Recent-window N: Sources → Scan and calibration. |
| D48 hidden-window rule | No animation, no `requestAnimationFrame`; disclosures paint synchronously. |
| D50 frozen mod disclosure | The exact calls stay on screen inside the Privacy disclosure, with "runs inside Claude Code with your permissions". |
| D71 privacy line | `copy.privacyLine` verbatim in Settings → Privacy; `privacyShort` in the native sidebar. |

## 13. Decisions this spec asks for

Proposed as rows for the maintainer to accept, reword or reject; recorded in DECISIONS.md as D73 (P1), D74 (P6) and D78 (P2–P5).

- **P1. The app's chrome is native.** The Control Center window has a native sidebar and toolbar and sends
  `chrome: "content"`; the canvas's own chrome (`"full"`) is only for README images and screen comparisons, and never
  draws window buttons.
- **P2. Answer first on the Finding page** (amends D44 5a for the canvas). The title block always comes first; the
  finding's side is shown by the chip, the title and the filled badge on its side of the chart's rule, not by moving
  the title above or below the rule. The popover and the report are unaffected.
- **P3. Day-level counts behind a disclosure on the canvas** (amends D44 5d for the canvas only). The k and n rows move
  into "Daily counts"; every k and n stays in the hover tip, the strip's text description and that disclosure. The CLI,
  the report and the mod pane keep their rows.
- **P4. Markers v2.** 18 px badges with round corners: yours a rounded square, the agent's a rounded tag with a
  shallow point. Short versions with the full version in the accessible name. The party grammar of D57 is unchanged.
- **P5. Type on the canvas.** Six sizes; new roles `section` (17 bold) and `small` (13 upright); italic only for the
  case line's side labels; mono only for data and buttons.
- **P6. Settings acts.** Settings controls perform their actions through native confirmation sheets, replacing the
  v1 rule that removal is done from Terminal (the `DestructiveAction` comment in `CanvasBridge.swift`). A control ships
  only with its backing (§9.4).

## 14. Tests and measurements

**How the "before" numbers were made** (temporary homes only; no real agent folder or `~/.wasitme` is read):

```sh
scripts/dev/heavy.sh sh -c 'npx tsc -p engine && node ui/scripts/build.mjs'
scripts/dev/heavy.sh node ui/scripts/hero.mjs --out <scratch> --scale 1          # the demo Finding page, light and dark
WASITME_RENDER_JOBS=1 scripts/dev/heavy.sh node ui/test/render.mjs --only you-and-codex
WASITME_RENDER_JOBS=1 scripts/dev/heavy.sh node ui/test/render.mjs --only agent-by
```

plus a scratch script that rendered `wasitme demo --json` (and each `--case`) on every page at 1060 × 800 in
`chrome: "content"` and 1280 × 800 in `"full"`, and counted visible words as the whitespace-separated tokens of
`document.querySelector('.page').innerText` (chart labels included).

**The budgets are estimates.** §8's numbers were tallied from the wireframes, not measured on a v2 render. They are
ceilings to confirm on the first v2 render: if one cannot be met without breaking a §12 hold, the fix is to raise the
number in this spec (with the measured count), never to loosen the test or drop a hold.

**Tests to add** (the canvas engineer's change; never weaken an existing one):

1. `ui/test/render.mjs`: in `chrome: "content"` there is no `.sidebar`, `.lights`, `.topbar` or `.stamp`; the demo
   banner is present for demo data; each page's visible words on the demo snapshot are within §8's budget; collapsed
   regions are `hidden`; every disclosure button has `aria-expanded` and a matching `aria-controls`.
2. Opening every disclosure on every page keeps all of today's checks green (one h1, heading order, no overlap, type
   on the scale) and the focus walk in DOM order.
3. `ui/test/model.test.mjs`: `shortVersions()` on §7.2's table; the badge's accessible name always holds the full
   engine label; `MOD_CALL_WORDS` covers exactly `ALLOWED_CALLS`; the plugin hook lines cover exactly the hooks in
   `plugin/hooks/hooks.json`; the §11.2 word budgets over every contract golden and every demo case.
4. The "every number reachable" check: for each snapshot golden, every metric's k, n, ratio and range and every
   event's full label appears in the page's text, or in a disclosure's text once opened, or in an accessible name.
5. Swift: `BridgePolicy` accepts and rejects per §10.1; `viewObject` sends `chrome: "content"`.

## 15. Out of scope

- Engine copy (deck, note, next step, trace) and the shared contract: unchanged. If the maintainer wants shorter
  engine sentences, that is an engine change with regenerated goldens and their agreement.
- The menu bar popover, desktop panel, mod pane, status line, CLI and Markdown report keep their current design
  (§7.2's short versions apply to the canvas only).
- Building the installer and engine modes of §9.4 (owners: WP-70 and the engine), and running the update on an
  existing install (report item 7).
- A changelog fragment: this document is not a user-visible change. Each implementation change adds its own.
