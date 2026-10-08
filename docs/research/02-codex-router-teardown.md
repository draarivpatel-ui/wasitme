# Codex Router teardown (read-only, 2026-10-04)

Source: ~/.local/share/codex-router (github.com/duolahypercho/codex-router, v0.6.0, MIT "Copyright (c) 2026 codex-router contributors"). Paths relative to that dir. INFERRED = not verified in code.

## Architecture
- `src/`: ~325 plain Node ESM modules, no framework; runtime deps only `proper-lockfile`, `undici`. Node ≥ 22.19.
- `bin/`: 43 POSIX sh shims running `node src/<x>.mjs`, symlink-safe.
- `apps/control-center/`: Electron 43 + React 19 + Vite 8 + TypeScript + lucide-react. No Tailwind, no component lib; hand-written CSS variables. electron-builder.
- `apps/macos/ModelRouterTray/`: Swift Package (Swift 5.10, macOS 13), SwiftUI + AppKit. Main file 10,673 lines (anti-pattern).
- `apps/macos/RouterUsageWidget/`: WidgetKit extension via XcodeGen `project.yml`, macOS 14.
- `apps/panel/`: plain-JS browser fallback panel reading local `/health`.
- `docs-site/`: Astro + Starlight, Manrope + JetBrains Mono.
- `packaging/homebrew/` + `Formula/`.

## Install flow (`install.sh`, POSIX, 15KB)
One-liner: `curl -fsSL …/install.sh | sh -s -- --target codex --guided --with-tray`.
1. Parse flags, refuse contradictions. 2. Requires git; clone `--depth 1` into `~/.local/share/codex-router` or `pull --ff-only`. 3. Records rollback ref; refuses to overwrite local edits without `--force`; restores previous revision on failure. 4. Checks node/npm. 5. Runs `bin/setup`; guided mode auto-on when stdout is a TTY and /dev/tty readable. 6. `npm ci --omit=dev` (+ Python venv for LiteLLM — not relevant). 7. Registers LaunchAgent.
- **Guided setup**: line-prompt TUI with no libraries, reads `/dev/tty` (works under `curl | sh`), numbered lists, toggle "1,3"/"a"/"n" (`src/setup.mjs:178-320`).
- **Local macOS build, no Apple account** (`scripts/build-macos-tray-app.sh`, `bin/model-router-tray`): needs full Xcode; `src/macos-developer-tools.mjs` finds Xcode and sets DEVELOPER_DIR for the build only (never changes xcode-select). `swift build` for the tray; `electron-builder --mac dir` with `CSC_IDENTITY_AUTO_DISCOVERY=false`; widget via `xcodebuild … CODE_SIGNING_ALLOWED=NO`; assembles `~/Applications/Codex Router.app` (Electron app embedded in Contents/Resources); ad-hoc `codesign --sign -` then `codesign --verify --deep --strict`. Transactional swap (staged/previous/failed dirs). Never downloaded → never quarantined → no Gatekeeper. Releases deliberately don't publish a macOS binary until Developer ID exists.
- **Menu-bar autostart**: second LaunchAgent with `KeepAlive {SuccessfulExit:false}` (crash restarts, Quit stays quit), passes `--supervised`.
- Never edits shell rc files; prints `export PATH` line instead.
- Update: `bin/update` or re-run the one-liner. Uninstall: `bin/uninstall`.

## Control Center design
- Layout: 238px left sidebar (hairline right border, collapsible), 44px titlebar with `hiddenInset` traffic lights. Sidebar: wordmark + Cmd-K search dialog, back/forward, 8 nav items, footer with health dot + theme toggle.
- Navigation: React `useState` view (no router), last view in localStorage. Per-page CSS files with class prefixes (`db-`, `us-`, `st-`).
- Look: quiet, near-monochrome, Codex-app-like. 13px base (12px nav), system font stack (-apple-system/SF Pro) + monospace for numbers. Hairline borders, 6–9px control radii, 18px card radii. Dashboard summary = 5-col grid whose 1px gap draws hairlines. Primary button = solid ink (inverted in dark). One muted accent, soft status tints.
- Tokens (`apps/control-center/src/styles.css:1-47`): surfaces light `#fff #f8f8f7 #f0f0ef #e7e7e5`, dark `#0a0a0a #0e0e0e #161616 #212121`; ink `#1a1a1a` → `#9b9b9b`; accent `#4e6fae` light / `#91aef0` dark; success `#168447`, warning `#9a6817`, danger `#a64141` (+ `-soft` tints); chart `#5b8def #b477e3 #ef8a5f`.
- Dark/light via `:root.dark` class; default light; no prefers-color-scheme (weakness).
- Icons lucide-react, stroke 1.7. Charts: hand-written inline SVG with custom tooltips (`pages/UsagePage.tsx:925-1143`). No chart lib.
- Primitives `src/components.tsx`: Badge, Button, Toggle, SearchField, PageHeader, InlineNotice, modal.
- Backend link: Electron IPC, ~90 named methods via `contextBridge` (no generic bridge); `electron/command-runner.mjs` spawns CLI with `shell:false`, bounded output, timeouts, process-tree kill.

## Menu bar + widget
- Not `MenuBarExtra`: comment at `ModelRouterTrayApp.swift:386` says `MenuBarExtra(.window)` re-anchors on every publish and parks the panel in screen corners. Uses fixed `NSStatusItem` + borderless key-capable `NSPanel` (352×560); placement is a pure tested function (`TrayPanelPlacement.swift`).
- Data: Swift app runs the CLI (`bin/control`) as a subprocess, decodes JSON; writes gated by an allow-list.
- Refresh: `Task.sleep` loops (1s/30s/60s/5min tiers).
- "Dynamic Island": separate NSPanel overlay (compact/peek/expanded) + a "desktop" panel at desktop-icon level +1.
- WidgetKit: app writes a small secret-free JSON snapshot (`~/Library/Application Support/Codex Router Widget/usage-widget.json`), calls `WidgetCenter.reloadTimelines`; extension only reads the file (read-only sandbox exception entitlement), 15-min timeline, shows stale after 45 min. README says the desktop widget is a movable panel, not in Edit Widgets gallery (INFERRED: ad-hoc-signed WidgetKit may not register/render — see 04).

## Hygiene worth copying
- `changelog.d/` fragments + `scripts/assemble-changelog.mjs --check` in CI.
- CI on ubuntu/macos/windows, `npm audit --omit=dev`, `swift test`, `sh -n` on all scripts, `install.sh --help`.
- `release.yml`: tag must equal tested main HEAD + package version, waits for green CI, SHA256SUMS + provenance attestation.
- `SECURITY.md` as real threat model. AGENTS.md (too big: 204KB).

## Don't copy
Giant single files; two UI stacks (Electron inside Swift) polling a Node CLI every second; Electron weight (~100MB+); localization sprawl; Windows PS scripts; no prefers-color-scheme; `curl|sh` that requires git clone. Provider logos and the Codex Router name/icon are not MIT-covered.

## Top borrow list
1. install.sh structure (short version). 2. `/dev/tty` guided prompt pattern. 3. Local build + ad-hoc sign + `codesign --verify`. 4. Xcode detection with clear error. 5. `NSStatusItem` + `NSPanel` with pure placement function + tests. 6. Snapshot JSON as the widget/menu-bar contract; staleness surfaced. 7. Conditional KeepAlive LaunchAgent. 8. Control Center tokens + shell (re-implement). 9. Named-method bridge + `shell:false` CLI runner. 10. changelog.d + SECURITY.md + release preflight.
Attribution: keep MIT notice in THIRD_PARTY_NOTICES for anything adapted; redrawing design from scratch needs none.
