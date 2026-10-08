import AppKit
import SwiftUI
import WasitmeCore

// THE ONE SWAP POINT FOR THE BRAND: Case File (DECISIONS D44, D57), from design/system/.
//
// Every colour, font, size, radius, stroke and duration the app draws comes from `Theme.current`, which is built here
// from Theme/Generated/Tokens.swift (never hand-typed values): a byte-for-byte copy of
// design/system/generated/Tokens.swift (palette, type roles with PostScript names, space, radius, stroke, motion,
// sizes, chart constants, copy, finding and app states with their chip edge styles, and every glyph as vector
// primitives), written by `node macos/scripts/sync-design.mjs`. WasitmeUITests/DesignSyncTests fail when it drifts.
// No other file may contain a colour literal, a font literal or a glyph drawing (WasitmeUITests/ThemeTests).

/// One appearance-aware colour (a `Tokens.Palette` value). It resolves to its light or dark value wherever it is drawn:
/// a window, the menu bar, an offscreen capture.
public struct ColorToken: Sendable, Equatable {
    public struct RGBA: Sendable, Equatable {
        public var r: Double, g: Double, b: Double, a: Double
    }

    public let color: Color

    public init(_ color: Color) { self.color = color }

    /// The dynamic NSColor behind the token (verified: `NSColor(Color(nsColor:))` returns the same dynamic colour).
    public var nsColor: NSColor { NSColor(color) }

    /// The colour as drawn in one appearance (for bitmaps and checks).
    public func resolved(dark: Bool) -> NSColor {
        let dynamic = nsColor
        var out = dynamic
        NSAppearance(named: dark ? .darkAqua : .aqua)?.performAsCurrentDrawingAppearance {
            out = dynamic.usingColorSpace(.sRGB) ?? dynamic
        }
        return out
    }

    public func rgba(dark: Bool) -> RGBA {
        let c = resolved(dark: dark)
        return RGBA(r: c.redComponent, g: c.greenComponent, b: c.blueComponent, a: c.alphaComponent)
    }

    public var light: RGBA { rgba(dark: false) }
    public var dark: RGBA { rgba(dark: true) }

    public static func == (a: ColorToken, b: ColorToken) -> Bool { a.light == b.light && a.dark == b.dark }
}

/// One type role: the SwiftUI font from `Tokens.Typeface` plus the metrics SwiftUI needs to set it like the CSS does
/// (line box, tracking) and the PostScript name AppKit needs.
public struct FontToken: Sendable, Equatable {
    public let font: Font
    public let style: Tokens.TypeStyle

    init(_ font: Font, _ style: Tokens.TypeStyle) { self.font = font; self.style = style }

    public var size: CGFloat { style.size }
    public var lineHeight: CGFloat { style.lineHeight }
    public var tracking: CGFloat { style.tracking }

    /// The bundled face, or the system font when the bundle's fonts could not be registered (never silently: capture
    /// and the tests check `FontRegistry.isRegistered`).
    public var nsFont: NSFont {
        NSFont(name: style.postScriptName, size: style.size)
            ?? (style.postScriptName.contains("Mono") ? .monospacedSystemFont(ofSize: style.size, weight: .regular)
                : .systemFont(ofSize: style.size))
    }

    /// The face's own line height (ascender + descender + leading). Plex: 1.3 em.
    public var naturalLineHeight: CGFloat {
        let f = nsFont
        return f.ascender - f.descender + f.leading
    }

    /// The same role at another line height (the design sets some roles on a tighter line, e.g. the popover deck).
    public func line(_ lineHeight: CGFloat) -> FontToken {
        FontToken(font, Tokens.TypeStyle(postScriptName: style.postScriptName, size: style.size,
                                               lineHeight: lineHeight, tracking: style.tracking))
    }

    /// The role's face at another scale size and line (the small desktop panel sets the heading at the deck size, 17/20).
    public func withSize(_ size: CGFloat, line: CGFloat) -> FontToken {
        FontToken(.custom(style.postScriptName, fixedSize: size),
                  Tokens.TypeStyle(postScriptName: style.postScriptName, size: size, lineHeight: line, tracking: style.tracking))
    }

    /// The same role in the bold face (CSS `font-weight: 700` on a regular role).
    public var bold: FontToken { swapFace { $0.replacingOccurrences(of: "-Regular", with: "-Bold").replacingOccurrences(of: "-Italic", with: "-BoldItalic") } }

    /// The upright face of an italic role (CSS `font-style: normal` on the note role).
    public var upright: FontToken { swapFace { $0.replacingOccurrences(of: "-BoldItalic", with: "-Bold").replacingOccurrences(of: "-Italic", with: "-Regular") } }

    private func swapFace(_ f: (String) -> String) -> FontToken {
        let name = f(style.postScriptName)
        guard name != style.postScriptName else { return self }
        return FontToken(.custom(name, fixedSize: style.size),
                         Tokens.TypeStyle(postScriptName: name, size: style.size, lineHeight: style.lineHeight, tracking: style.tracking))
    }

    public static func == (a: FontToken, b: FontToken) -> Bool { a.style == b.style }
}

/// How a state chip is drawn (tokens.json color.<mode>.state.<state>).
public struct StateStyle: Sendable {
    public let fg: ColorToken
    public let bg: ColorToken
    public let glyph: ColorToken
    public let edge: ColorToken
    public let edgeStyle: Tokens.EdgeStyle
    /// `unclear` only: the canary and blue blocks at the chip's leading edge.
    public let swatches: [ColorToken]
}

public struct Theme: Sendable {
    public struct Palette: Sendable {
        public let page, sheet, sidebar, raised, well, selection: ColorToken
        public let ruleHair, ruleStrong, ruleInk: ColorToken
        public let ink, inkSecondary, inkMuted, inkOnInk: ColorToken
        public let action, actionText, focus: ColorToken
        public let youFill, youInk, youKeyline, youTint: ColorToken
        public let agentFill, agentInk, agentKeyline, agentTint: ColorToken
        public let chartMark, chartAxis, chartGrid, chartLabel, chartConnector: ColorToken
    }

    public struct Typography: Sendable {
        public let display, title, popTitle, heading, deck, body, ui, note: FontToken
        public let typedLg, typed, typedSm, wordmark: FontToken
    }

    /// Tokens.Space (4-pt steps).
    public struct Spacing: Sendable {
        public let s1 = Tokens.Space.s1, s2 = Tokens.Space.s2, s3 = Tokens.Space.s3, s4 = Tokens.Space.s4
        public let s5 = Tokens.Space.s5, s6 = Tokens.Space.s6, s8 = Tokens.Space.s8, s10 = Tokens.Space.s10
    }

    public struct Radii: Sendable {
        public let sticker = Tokens.Radius.sticker, chip = Tokens.Radius.chip, control = Tokens.Radius.control
        public let window = Tokens.Radius.window, popover = Tokens.Radius.popover, panel = Tokens.Radius.panel
    }

    public struct Strokes: Sendable {
        public let hair = Tokens.Stroke.hair, keyline = Tokens.Stroke.keyline, rule = Tokens.Stroke.rule, focus = Tokens.Stroke.focus
    }

    /// Surface and component sizes (tokens.json size; DESIGN.md §7 and §9).
    public struct Metrics: Sendable {
        public let popover = Tokens.Size.popover
        public let panelSmall = Tokens.Size.panelSmall
        public let panelMedium = Tokens.Size.panelMedium
        public let controlCenter = Tokens.Size.controlCenter
        public let controlCenterMinimum = Tokens.Size.controlCenterMinimum
        /// Menu bar: the 18 px grid on a 24 pt (or taller) bar, the 16 px grid on an older 22 pt bar.
        public let menuBarGlyphLarge = Tokens.Size.menuBarGlyphLarge
        public let menuBarGlyphSmall = Tokens.Size.menuBarGlyphSmall
        public let chipHeight = Tokens.Size.chipHeight
        public let chipGlyph = Tokens.Size.chipGlyph
        /// The desktop panel draws the 18 px glyph in a 30 pt box.
        public let panelGlyph = Tokens.Size.panelGlyph
        /// DESIGN.md §7 party markers: yours a 20 pt square, the agent's a 20 × 22 pointed tag.
        public let sticker = Tokens.Size.sticker
        public let tag = Tokens.Size.tag
        public let unclearSwatch = Tokens.Size.chipSwatch
        /// The app's buttons live in the popover footer, which uses the compact height (the canvas's are 30).
        public let buttonHeight = Tokens.Size.buttonCompactHeight
        /// App glue, not a design token: an NSButton that isn't a status bar button (previews, tests) dims like
        /// `appearsDisabled` does.
        public let menuBarDimmedAlpha: CGFloat = 0.5
    }

    public struct Motion: Sendable {
        public let standard = Tokens.Motion.duration

        /// Window open/close animation: none while the user has Reduce Motion on.
        public func windowAnimation(reduceMotion: Bool) -> NSWindow.AnimationBehavior {
            reduceMotion ? .none : .documentWindow
        }
    }

    /// The Control Center's native window chrome (title bar, unified toolbar, sidebar): system materials, system text
    /// styles and SF Symbols, so it reads as a normal Mac window in either appearance. The canvas keeps the brand type.
    public struct NativeChrome: Sendable {
        /// Sidebar width (points): a native source list (docs/design/UX-V2.md §3: 220 by default, 200–280).
        public let sidebarMinimum: CGFloat = 200, sidebarIdeal: CGFloat = 220, sidebarMaximum: CGFloat = 280
        /// The narrowest the canvas column gets (the designed content column was 668 at the 900-wide minimum).
        public let contentMinimum: CGFloat = 640
        public let checkAgainSymbol = "arrow.clockwise"
        public let copyReportSymbol = "doc.on.doc"
        public let openMarkdownSymbol = "arrow.up.forward.app"
        public let sidebarSymbol = "sidebar.left"

        public func symbol(for page: ControlCenterPage) -> String {
            switch page {
            case .timeline: "calendar.day.timeline.left"
            case .verdict: "text.magnifyingglass"
            case .compare: "arrow.left.arrow.right"
            case .setup: "slider.horizontal.3"
            case .report: "doc.text"
            case .sources: "tray.full"
            case .settings: "gearshape"
            }
        }

        /// Every symbol the chrome draws (tests check each resolves on this macOS).
        public var allSymbols: [String] {
            ControlCenterPage.allCases.map(symbol(for:)) + [checkAgainSymbol, copyReportSymbol, openMarkdownSymbol, sidebarSymbol]
        }

        /// A toolbar / menu image; nil only if this macOS lacks the symbol (the item then shows its label).
        @MainActor public func image(_ name: String, label: String) -> NSImage? {
            NSImage(systemSymbolName: name, accessibilityDescription: label)
        }

        /// The sidebar row icon.
        public func icon(for page: ControlCenterPage) -> Image { Image(systemName: symbol(for: page)) }

        /// The sidebar's quiet footer line ("Local only · updated 4 min ago").
        public let footerFont: Font = .footnote
        public let footerStyle: HierarchicalShapeStyle = .secondary

        /// The About panel's credits line: small, secondary, centred (system colours, so it reads in either appearance).
        @MainActor public var aboutCreditsAttributes: [NSAttributedString.Key: Any] {
            let centred = NSMutableParagraphStyle()
            centred.alignment = .center
            return [.font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize), .foregroundColor: NSColor.secondaryLabelColor,
                    .paragraphStyle: centred]
        }
    }

    public let palette: Palette
    public let type: Typography
    public let spacing = Spacing()
    public let radii = Radii()
    public let stroke = Strokes()
    public let metrics = Metrics()
    public let motion = Motion()
    public let chrome = NativeChrome()
    public let glyphs: any GlyphRendering

    /// The theme every view reads.
    public static let current = Theme.caseFile

    /// Case File, from the generated design tokens.
    public static let caseFile = Theme(
        palette: Palette(
            page: ColorToken(Tokens.Palette.surfacePage), sheet: ColorToken(Tokens.Palette.surfaceSheet),
            sidebar: ColorToken(Tokens.Palette.surfaceSidebar), raised: ColorToken(Tokens.Palette.surfaceRaised),
            well: ColorToken(Tokens.Palette.surfaceWell), selection: ColorToken(Tokens.Palette.surfaceSelection),
            ruleHair: ColorToken(Tokens.Palette.ruleHair), ruleStrong: ColorToken(Tokens.Palette.ruleStrong),
            ruleInk: ColorToken(Tokens.Palette.ruleInk),
            ink: ColorToken(Tokens.Palette.inkPrimary), inkSecondary: ColorToken(Tokens.Palette.inkSecondary),
            inkMuted: ColorToken(Tokens.Palette.inkMuted), inkOnInk: ColorToken(Tokens.Palette.inkOnInk),
            action: ColorToken(Tokens.Palette.accentAction), actionText: ColorToken(Tokens.Palette.accentActionText),
            focus: ColorToken(Tokens.Palette.accentFocus),
            youFill: ColorToken(Tokens.Palette.partyYouFill), youInk: ColorToken(Tokens.Palette.partyYouInk),
            youKeyline: ColorToken(Tokens.Palette.partyYouKeyline), youTint: ColorToken(Tokens.Palette.partyYouTint),
            agentFill: ColorToken(Tokens.Palette.partyAgentFill), agentInk: ColorToken(Tokens.Palette.partyAgentInk),
            agentKeyline: ColorToken(Tokens.Palette.partyAgentKeyline), agentTint: ColorToken(Tokens.Palette.partyAgentTint),
            chartMark: ColorToken(Tokens.Palette.chartMark), chartAxis: ColorToken(Tokens.Palette.chartAxis),
            chartGrid: ColorToken(Tokens.Palette.chartGrid), chartLabel: ColorToken(Tokens.Palette.chartLabel),
            chartConnector: ColorToken(Tokens.Palette.chartConnector)),
        type: Typography(
            display: FontToken(Tokens.Typeface.display, Tokens.TypeScale.display),
            title: FontToken(Tokens.Typeface.title, Tokens.TypeScale.title),
            popTitle: FontToken(Tokens.Typeface.popTitle, Tokens.TypeScale.popTitle),
            heading: FontToken(Tokens.Typeface.heading, Tokens.TypeScale.heading),
            deck: FontToken(Tokens.Typeface.deck, Tokens.TypeScale.deck),
            body: FontToken(Tokens.Typeface.body, Tokens.TypeScale.body),
            ui: FontToken(Tokens.Typeface.ui, Tokens.TypeScale.ui),
            note: FontToken(Tokens.Typeface.note, Tokens.TypeScale.note),
            typedLg: FontToken(Tokens.Typeface.typedLg, Tokens.TypeScale.typedLg),
            typed: FontToken(Tokens.Typeface.typed, Tokens.TypeScale.typed),
            typedSm: FontToken(Tokens.Typeface.typedSm, Tokens.TypeScale.typedSm),
            wordmark: FontToken(Tokens.Typeface.wordmark, Tokens.TypeScale.wordmark)),
        glyphs: CaseFileGlyphRenderer())

    // MARK: states

    /// The chip style of a finding state (tokens.json color.<mode>.state.<state>).
    public func stateStyle(_ s: Tokens.FindingState) -> StateStyle {
        let edge = s.edgeStyle
        switch s {
        case .insufficient:
            return StateStyle(fg: ColorToken(Tokens.Palette.stateInsufficientFg), bg: ColorToken(Tokens.Palette.stateInsufficientBg),
                              glyph: ColorToken(Tokens.Palette.stateInsufficientGlyph), edge: ColorToken(Tokens.Palette.stateInsufficientEdge),
                              edgeStyle: edge, swatches: [])
        case .noDetectableChange:
            return StateStyle(fg: ColorToken(Tokens.Palette.stateNoneFg), bg: ColorToken(Tokens.Palette.stateNoneBg),
                              glyph: ColorToken(Tokens.Palette.stateNoneGlyph), edge: ColorToken(Tokens.Palette.stateNoneEdge),
                              edgeStyle: edge, swatches: [])
        case .unclear:
            return StateStyle(fg: ColorToken(Tokens.Palette.stateUnclearFg), bg: ColorToken(Tokens.Palette.stateUnclearBg),
                              glyph: ColorToken(Tokens.Palette.stateUnclearGlyph), edge: ColorToken(Tokens.Palette.stateUnclearEdge),
                              edgeStyle: edge, swatches: [ColorToken(Tokens.Palette.stateUnclearSwatch1), ColorToken(Tokens.Palette.stateUnclearSwatch2)])
        case .you:
            return StateStyle(fg: ColorToken(Tokens.Palette.stateYouFg), bg: ColorToken(Tokens.Palette.stateYouBg),
                              glyph: ColorToken(Tokens.Palette.stateYouGlyph), edge: ColorToken(Tokens.Palette.stateYouEdge),
                              edgeStyle: edge, swatches: [])
        case .agent:
            return StateStyle(fg: ColorToken(Tokens.Palette.stateAgentFg), bg: ColorToken(Tokens.Palette.stateAgentBg),
                              glyph: ColorToken(Tokens.Palette.stateAgentGlyph), edge: ColorToken(Tokens.Palette.stateAgentEdge),
                              edgeStyle: edge, swatches: [])
        case .stale:
            return StateStyle(fg: ColorToken(Tokens.Palette.stateStaleFg), bg: ColorToken(Tokens.Palette.stateStaleBg),
                              glyph: ColorToken(Tokens.Palette.stateStaleGlyph), edge: ColorToken(Tokens.Palette.stateStaleEdge),
                              edgeStyle: edge, swatches: [])
        }
    }

    /// The app's own document states (not set up, update needed, …): the quiet chip tokens.json appStates.chip names
    /// (secondary ink on the sheet, strong rule as the edge).
    public var neutralStateStyle: StateStyle {
        StateStyle(fg: ColorToken(Tokens.AppState.chipFg), bg: ColorToken(Tokens.AppState.chipBg),
                   glyph: ColorToken(Tokens.AppState.chipGlyph), edge: ColorToken(Tokens.AppState.chipEdge),
                   edgeStyle: Tokens.AppState.chipEdgeStyle, swatches: [])
    }

    /// The style a glyph's chip uses: the finding state's, or the quiet app-state chip.
    public func chipStyle(_ glyph: MenuBarGlyph) -> StateStyle {
        glyph.findingState.map(stateStyle) ?? neutralStateStyle
    }

    /// The face of the "+1" beside the menu bar glyph (a plain title, so the status bar picks its own text colour).
    @MainActor public var menuBarCountFont: NSFont { type.typedSm.nsFont }

    /// The glyph grid that suits the current menu bar (18 px on the 24 pt bar, 16 px on a 22 pt one).
    @MainActor public var menuBarGlyphSize: CGFloat {
        NSStatusBar.system.thickness >= 24 ? metrics.menuBarGlyphLarge : metrics.menuBarGlyphSmall
    }
}

public extension MenuBarGlyph {
    /// The glyph for one agent's (current) state, for chips and lists.
    init(_ state: VerdictState) {
        switch state {
        case .insufficient: self = .insufficient
        case .noDetectableChange: self = .noDetectableChange
        case .unclear: self = .unclear
        case .you: self = .you
        case .agent: self = .agent
        }
    }

    /// The design system's finding state for this glyph; nil for the app states (loading, not set up, …).
    var findingState: Tokens.FindingState? {
        switch self {
        case .insufficient: .insufficient
        case .noDetectableChange: .noDetectableChange
        case .unclear: .unclear
        case .you: .you
        case .agent: .agent
        case .stale: .stale
        case .loading, .notSetUp, .empty, .error, .updateNeeded, .refused: nil
        }
    }

    /// The design system's app state for this glyph (tokens.json appStates); nil for the finding states.
    var appState: Tokens.AppState? {
        switch self {
        case .loading: .loading
        case .notSetUp: .notSetUp
        case .empty: .empty
        case .error: .unreadable
        case .updateNeeded: .updateNeeded
        case .refused: .refused
        case .insufficient, .noDetectableChange, .unclear, .you, .agent, .stale: nil
        }
    }
}
