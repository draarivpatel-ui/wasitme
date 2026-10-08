# UI/UX inspiration and macOS stack decision (2026-10-04)

## Researcher's recommendation
Native **SwiftUI shell over the TypeScript engine invoked as a CLI (`wasitme … --json`)**, installed by **building locally** (curl|sh installer or Homebrew tap *formula* — not a cask). Engine/CLI/mod share one TS codebase. Electron ruled out (heavy, no widget, needs downloaded binary → Gatekeeper "Open Anyway"). Tauri is the fallback (needs Rust, not installed; no widget). Widget = best-effort; spike first.
Local test on the author's Mac: SwiftUI `MenuBarExtra` app compiled with `swiftc` (64KB, linker ad-hoc signed); after `codesign --sign -`, `open W.app` launched with no prompt. A `curl`-fetched file had only `com.apple.provenance`, no `com.apple.quarantine`.
NOTE: Codex Router (see 02) found `MenuBarExtra(.window)` re-anchors on every publish and parks the panel in corners → it uses `NSStatusItem` + `NSPanel`. Prefer that.

## Reference apps
| Project | Stars | License | Stack | Steal |
|---|---|---|---|---|
| CodexBar (steipete) | 22.2k | MIT | Swift 6.2 | Icon is a tiny meter; popover tiles with bars + countdowns; "Merge Icons" single item with switcher; provider status/incident badges; bundled CLI + WidgetKit; asks permissions only when needed. Notarized. |
| Stats (exelban) | 42.3k | MIT | Swift | Modular metrics each toggleable; menu bar widget → popup → settings; "no telemetry". |
| Ice | 29.7k | GPL-3.0 | Swift | Live-preview settings, search panel, profiles. Ideas only (GPL). |
| CodeBurn | 11.3k | MIT | TS/Node, Electron desktop | One local data source → terminal, browser, desktop, menu bar. `optimize` → graded findings with estimated savings. Zero-config auto-detect. |
| agentsview | 6.1k | MIT | Go + Svelte 5 + Tauri | Local SQLite index, heatmaps, keyboard-first, SSE live updates. |
| ccstatusline | 13.2k | MIT | TS, Ink | TUI configurator with live preview, widgets, themes. |
| ccusage | 18.9k | MIT | TS | Compact tables <100 cols, `npx` no install, JSON export. |
| ClaudeBar | 1.5k | MIT | Swift | Green/yellow/red states; signed+notarized. |
| MarginLab tracker | — | — | web | "Detection is paused while baseline data is collected"; cards with N beside every number; 95% CI band toggle; states effect needed for significance ("±12.8% change needed for p<0.05"); binary verdict. |
| status.claude.com | — | — | Statuspage | One banner verdict, rows per component, 90-day bars, incident lifecycle. |

## 15 design principles
1. One verdict first, evidence second. 2. The menu bar icon is the glance (shows verdict state, not a number). 3. Three levels of depth: icon → popover (verdict + sparkline) → full window. 4. Never color alone — pair with shape/label (▲ ● ○). 5. Grey "not enough data" is a first-class neutral state. 6. Show N next to every number. 7. Organize by cause, not by metric: "your setup changed" / "agent or model changed" / "nothing detectable". 8. Version/model/effort/config changes are timeline markers next to effects. 9. Compare like with like (same project/effort); say when you couldn't. 10. Zero-config first run: auto-detect ~/.claude, ~/.codex, show something in <5s. 11. Say "local, no telemetry" out loud in onboarding. 12. Every surface reads the same JSON from the same engine. 13. Graded findings with a plain next step ("Likely cause: effort dropped to medium on Sep 12. Undo it."). 14. Progressive disclosure of stats (plain words default; CIs on an Advanced toggle). 15. Compact terminal mode under 100 cols.

## Health-with-uncertainty patterns
- Verdict card 4 states: "Your side changed" (indigo — change color, not alarm), "The agent changed" (amber), "Nothing detectable" (neutral, not celebratory green), "Not enough data yet" (grey, dashed outline).
- Confidence line: "Based on 312 exchanges over 14 days. A change of ~8% or more would be detectable."
- Insufficient data: progress ring "Collecting baseline: 18 of 50"; dashed chart; "what will unlock a verdict".
- Bands translucent, widen where thin; days under min N as hollow dots.
- Change-point markers: thin vertical lines + small axis icon (version bump, model switch, effort change, config change, new MCP); before/after shading; hover "before 4.1%, after 9.8%, overlap none".
- Menu bar glyph: filled dot when verdict exists, dotted ring when insufficient; no numeric score.
- Wording: "no detectable change", never "no change".

## Stack facts
- Quarantine applies to downloaded-by-browser files; local builds aren't quarantined. Since Sequoia, right-click→Open is gone; path is System Settings → Privacy & Security → "Open Anyway" (friction for prebuilt unsigned apps).
- Homebrew: official casks failing Gatekeeper disabled from 2026-09-01; `--no-quarantine` deprecated in 5.0.0. Third-party taps not subject (maintainer-stated). Formulae (build from source) unaffected.
- Apple Silicon needs at least ad-hoc signature (Swift linker does it).
- **WidgetKit with ad-hoc signing: conflicting evidence** — text-clock PR #1 says ad-hoc widgets list in gallery but don't render; App Groups can't be used ad-hoc; two tiny projects claim workarounds (widget sandbox container; read-only sandbox exception). Codex Router ships a movable NSPanel "desktop widget" instead. → Spike before promising a real WidgetKit widget; NSPanel desktop panel is the safe fallback.
- Comparison: SwiftUI smallest/lowest memory, first-class menu bar, widget path (with signing caveat), local build w/o quarantine, engine via subprocess JSON; Tauri needs Rust + Node sidecar; Electron ~85MB+, 130–170MB idle; local web dashboard = zero Gatekeeper but no menu bar.
