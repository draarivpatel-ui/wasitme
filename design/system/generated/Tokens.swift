// GENERATED from design/system/tokens.json by design/system/gen/build.mjs. Do not edit by hand.
// Fonts: bundle fonts/app/*.ttf (IBM Plex Serif + IBM Plex Mono, SIL OFL 1.1) and list them under ATSApplicationFontsPath.
import AppKit
import SwiftUI

public enum Tokens {
    /// Appearance-aware colours: each resolves to its light or dark value when drawn.
    public enum Palette {
        public static let surfacePage = Tokens.dynamic(light: 0xF1F0EC, dark: 0x131418)
        public static let surfaceSheet = Tokens.dynamic(light: 0xFCFCFA, dark: 0x1B1C21)
        public static let surfaceSidebar = Tokens.dynamic(light: 0xEAE9E4, dark: 0x17181C)
        public static let surfaceRaised = Tokens.dynamic(light: 0xFFFFFF, dark: 0x23242A)
        public static let surfaceWell = Tokens.dynamic(light: 0xF4F3EF, dark: 0x202126)
        public static let surfaceSelection = Tokens.dynamic(light: 0xE3E2DC, dark: 0x2D2E34)
        public static let ruleHair = Tokens.dynamic(light: 0xDEDDD6, dark: 0x2E2F36)
        public static let ruleStrong = Tokens.dynamic(light: 0xB8B7AF, dark: 0x4A4B53)
        public static let ruleInk = Tokens.dynamic(light: 0x1C1D21, dark: 0xECEBE6)
        public static let inkPrimary = Tokens.dynamic(light: 0x1C1D21, dark: 0xECEBE6)
        public static let inkSecondary = Tokens.dynamic(light: 0x46474D, dark: 0xB9B8B2)
        public static let inkMuted = Tokens.dynamic(light: 0x5E5F64, dark: 0x9C9B95)
        public static let inkOnInk = Tokens.dynamic(light: 0xFCFCFA, dark: 0x1B1C21)
        public static let accentAction = Tokens.dynamic(light: 0x1C1D21, dark: 0xECEBE6)
        public static let accentActionText = Tokens.dynamic(light: 0xFCFCFA, dark: 0x1B1C21)
        public static let accentFocus = Tokens.dynamic(light: 0x1C1D21, dark: 0xECEBE6)
        public static let partyYouFill = Tokens.dynamic(light: 0xF5C842, dark: 0xF2C230)
        public static let partyYouInk = Tokens.dynamic(light: 0x1C1D21, dark: 0x1B1C21)
        public static let partyYouKeyline = Tokens.dynamic(light: 0x1C1D21, dark: 0xF2C230)
        public static let partyYouTint = Tokens.dynamic(light: 0xFAF0D0, dark: 0x332B14)
        public static let partyAgentFill = Tokens.dynamic(light: 0x8DBCF0, dark: 0x8CC4F2)
        public static let partyAgentInk = Tokens.dynamic(light: 0x1C1D21, dark: 0x1B1C21)
        public static let partyAgentKeyline = Tokens.dynamic(light: 0x1C1D21, dark: 0x8CC4F2)
        public static let partyAgentTint = Tokens.dynamic(light: 0xE7EEFB, dark: 0x182838)
        public static let chartMark = Tokens.dynamic(light: 0x1C1D21, dark: 0xECEBE6)
        public static let chartAxis = Tokens.dynamic(light: 0x1C1D21, dark: 0xECEBE6)
        public static let chartGrid = Tokens.dynamic(light: 0xE6E5DF, dark: 0x2A2B31)
        public static let chartLabel = Tokens.dynamic(light: 0x5E5F64, dark: 0x9C9B95)
        public static let chartRange = Tokens.dynamic(light: 0x1C1D21, dark: 0xECEBE6)
        public static let chartEstimate = Tokens.dynamic(light: 0x1C1D21, dark: 0xECEBE6)
        public static let chartMdeFill = Tokens.dynamic(light: 0xEFEEE9, dark: 0x25262C)
        public static let chartMdeHatch = Tokens.dynamic(light: 0x85868A, dark: 0x74757B)
        public static let chartConnector = Tokens.dynamic(light: 0x85868A, dark: 0x74757B)
        public static let stateInsufficientFg = Tokens.dynamic(light: 0x46474D, dark: 0xB9B8B2)
        public static let stateInsufficientBg = Tokens.dynamic(light: 0xFCFCFA, dark: 0x1B1C21)
        public static let stateInsufficientGlyph = Tokens.dynamic(light: 0x46474D, dark: 0xB9B8B2)
        public static let stateInsufficientEdge = Tokens.dynamic(light: 0x66676C, dark: 0x8F8E89)
        public static let stateNoneFg = Tokens.dynamic(light: 0xFCFCFA, dark: 0x1B1C21)
        public static let stateNoneBg = Tokens.dynamic(light: 0x1C1D21, dark: 0xECEBE6)
        public static let stateNoneGlyph = Tokens.dynamic(light: 0xFCFCFA, dark: 0x1B1C21)
        public static let stateNoneEdge = Tokens.dynamic(light: 0x1C1D21, dark: 0xECEBE6)
        public static let stateUnclearFg = Tokens.dynamic(light: 0x1C1D21, dark: 0xECEBE6)
        public static let stateUnclearBg = Tokens.dynamic(light: 0xFCFCFA, dark: 0x1B1C21)
        public static let stateUnclearGlyph = Tokens.dynamic(light: 0x1C1D21, dark: 0xECEBE6)
        public static let stateUnclearEdge = Tokens.dynamic(light: 0x1C1D21, dark: 0xECEBE6)
        public static let stateUnclearSwatch1 = Tokens.dynamic(light: 0xF5C842, dark: 0xF2C230)
        public static let stateUnclearSwatch2 = Tokens.dynamic(light: 0x8DBCF0, dark: 0x8CC4F2)
        public static let stateYouFg = Tokens.dynamic(light: 0x1C1D21, dark: 0x1B1C21)
        public static let stateYouBg = Tokens.dynamic(light: 0xF5C842, dark: 0xF2C230)
        public static let stateYouGlyph = Tokens.dynamic(light: 0x1C1D21, dark: 0x1B1C21)
        public static let stateYouEdge = Tokens.dynamic(light: 0x1C1D21, dark: 0xF2C230)
        public static let stateAgentFg = Tokens.dynamic(light: 0x1C1D21, dark: 0x1B1C21)
        public static let stateAgentBg = Tokens.dynamic(light: 0x8DBCF0, dark: 0x8CC4F2)
        public static let stateAgentGlyph = Tokens.dynamic(light: 0x1C1D21, dark: 0x1B1C21)
        public static let stateAgentEdge = Tokens.dynamic(light: 0x1C1D21, dark: 0x8CC4F2)
        public static let stateStaleFg = Tokens.dynamic(light: 0x46474D, dark: 0xB9B8B2)
        public static let stateStaleBg = Tokens.dynamic(light: 0xFCFCFA, dark: 0x1B1C21)
        public static let stateStaleGlyph = Tokens.dynamic(light: 0x46474D, dark: 0xB9B8B2)
        public static let stateStaleEdge = Tokens.dynamic(light: 0x66676C, dark: 0x8F8E89)
    }

    /// Type roles. Serif = the finding; mono = the evidence (every number). Sizes are points.
    public enum Typeface {
        public static let serifFamily = "IBM Plex Serif"
        public static let monoFamily = "IBM Plex Mono"
        /// 84/88 serif 400
        public static let readme = SwiftUI.Font.custom("IBMPlexSerif-Regular", fixedSize: 84)
        public static let readmeLineHeight: CGFloat = 88
        public static let readmeTracking: CGFloat = -1.68
        /// 52/56 serif 400
        public static let display = SwiftUI.Font.custom("IBMPlexSerif-Regular", fixedSize: 52)
        public static let displayLineHeight: CGFloat = 56
        public static let displayTracking: CGFloat = -0.78
        /// 30/36 serif 400
        public static let title = SwiftUI.Font.custom("IBMPlexSerif-Regular", fixedSize: 30)
        public static let titleLineHeight: CGFloat = 36
        public static let titleTracking: CGFloat = -0.30
        /// 26/31 serif 400
        public static let popTitle = SwiftUI.Font.custom("IBMPlexSerif-Regular", fixedSize: 26)
        public static let popTitleLineHeight: CGFloat = 31
        public static let popTitleTracking: CGFloat = -0.26
        /// 19/24 serif 700
        public static let heading = SwiftUI.Font.custom("IBMPlexSerif-Bold", fixedSize: 19)
        public static let headingLineHeight: CGFloat = 24
        public static let headingTracking: CGFloat = 0.00
        /// 17/24 serif 700
        public static let section = SwiftUI.Font.custom("IBMPlexSerif-Bold", fixedSize: 17)
        public static let sectionLineHeight: CGFloat = 24
        public static let sectionTracking: CGFloat = 0.00
        /// 17/26 serif 400
        public static let deck = SwiftUI.Font.custom("IBMPlexSerif-Regular", fixedSize: 17)
        public static let deckLineHeight: CGFloat = 26
        public static let deckTracking: CGFloat = 0.00
        /// 15/23 serif 400
        public static let body = SwiftUI.Font.custom("IBMPlexSerif-Regular", fixedSize: 15)
        public static let bodyLineHeight: CGFloat = 23
        public static let bodyTracking: CGFloat = 0.00
        /// 14/21 serif 400
        public static let ui = SwiftUI.Font.custom("IBMPlexSerif-Regular", fixedSize: 14)
        public static let uiLineHeight: CGFloat = 21
        public static let uiTracking: CGFloat = 0.00
        /// 13/19 serif italic 400
        public static let note = SwiftUI.Font.custom("IBMPlexSerif-Italic", fixedSize: 13)
        public static let noteLineHeight: CGFloat = 19
        public static let noteTracking: CGFloat = 0.00
        /// 13/19 serif 400
        public static let small = SwiftUI.Font.custom("IBMPlexSerif-Regular", fixedSize: 13)
        public static let smallLineHeight: CGFloat = 19
        public static let smallTracking: CGFloat = 0.00
        /// 15/20 mono 700
        public static let typedLg = SwiftUI.Font.custom("IBMPlexMono-Bold", fixedSize: 15)
        public static let typedLgLineHeight: CGFloat = 20
        public static let typedLgTracking: CGFloat = 0.00
        /// 13/18 mono 400
        public static let typed = SwiftUI.Font.custom("IBMPlexMono-Regular", fixedSize: 13)
        public static let typedLineHeight: CGFloat = 18
        public static let typedTracking: CGFloat = 0.00
        /// 12/16 mono 400
        public static let typedSm = SwiftUI.Font.custom("IBMPlexMono-Regular", fixedSize: 12)
        public static let typedSmLineHeight: CGFloat = 16
        public static let typedSmTracking: CGFloat = 0.00
        /// 18/22 mono 700
        public static let wordmark = SwiftUI.Font.custom("IBMPlexMono-Bold", fixedSize: 18)
        public static let wordmarkLineHeight: CGFloat = 22
        public static let wordmarkTracking: CGFloat = 0.00
    }

    public enum Space {
        public static let s1: CGFloat = 4
        public static let s2: CGFloat = 8
        public static let s3: CGFloat = 12
        public static let s4: CGFloat = 16
        public static let s5: CGFloat = 20
        public static let s6: CGFloat = 24
        public static let s8: CGFloat = 32
        public static let s10: CGFloat = 40
        public static let s12: CGFloat = 48
        public static let s16: CGFloat = 64
    }

    public enum Radius {
        public static let sticker: CGFloat = 2
        public static let chip: CGFloat = 3
        public static let badge: CGFloat = 4
        public static let control: CGFloat = 6
        public static let window: CGFloat = 10
        public static let popover: CGFloat = 12
        public static let panel: CGFloat = 18
    }

    public enum Stroke {
        public static let hair: CGFloat = 1
        public static let keyline: CGFloat = 1
        public static let rule: CGFloat = 2
        public static let focus: CGFloat = 2
    }

    public enum Motion {
        public static let duration: Double = 0.180
    }

    /// Surface and component sizes (points). A {width, height} pair is a CGSize; other groups are flattened.
    public enum Size {
        public static let popover = CGSize(width: 352, height: 480)
        public static let panelSmall = CGSize(width: 170, height: 170)
        public static let panelMedium = CGSize(width: 360, height: 170)
        public static let controlCenter = CGSize(width: 1280, height: 800)
        public static let controlCenterMinimum = CGSize(width: 900, height: 600)
        public static let menuBarGlyphLarge: CGFloat = 18
        public static let menuBarGlyphSmall: CGFloat = 16
        public static let chipHeight: CGFloat = 26
        public static let chipGlyph: CGFloat = 16
        public static let chipSwatch: CGFloat = 9
        public static let sticker = CGSize(width: 20, height: 20)
        public static let tag = CGSize(width: 20, height: 22)
        public static let badgeYou = CGSize(width: 18, height: 18)
        public static let badgeAgent = CGSize(width: 18, height: 20)
        public static let buttonHeight: CGFloat = 30
        public static let buttonCompactHeight: CGFloat = 28
        public static let panelGlyph: CGFloat = 30
        public static let pinGlyph: CGFloat = 22
    }

    /// One type role as AppKit needs it: the bundled face's PostScript name, size, line box and tracking (points).
    public struct TypeStyle: Sendable, Equatable {
        public let postScriptName: String
        public let size: CGFloat
        public let lineHeight: CGFloat
        public let tracking: CGFloat
        public init(postScriptName: String, size: CGFloat, lineHeight: CGFloat, tracking: CGFloat) {
            self.postScriptName = postScriptName; self.size = size; self.lineHeight = lineHeight; self.tracking = tracking
        }
    }

    /// type.scale as TypeStyle values (the same numbers as Typeface.<role>, <role>LineHeight, <role>Tracking).
    public enum TypeScale {
        public static let readme = TypeStyle(postScriptName: "IBMPlexSerif-Regular", size: 84, lineHeight: 88, tracking: -1.68)
        public static let display = TypeStyle(postScriptName: "IBMPlexSerif-Regular", size: 52, lineHeight: 56, tracking: -0.78)
        public static let title = TypeStyle(postScriptName: "IBMPlexSerif-Regular", size: 30, lineHeight: 36, tracking: -0.30)
        public static let popTitle = TypeStyle(postScriptName: "IBMPlexSerif-Regular", size: 26, lineHeight: 31, tracking: -0.26)
        public static let heading = TypeStyle(postScriptName: "IBMPlexSerif-Bold", size: 19, lineHeight: 24, tracking: 0.00)
        public static let section = TypeStyle(postScriptName: "IBMPlexSerif-Bold", size: 17, lineHeight: 24, tracking: 0.00)
        public static let deck = TypeStyle(postScriptName: "IBMPlexSerif-Regular", size: 17, lineHeight: 26, tracking: 0.00)
        public static let body = TypeStyle(postScriptName: "IBMPlexSerif-Regular", size: 15, lineHeight: 23, tracking: 0.00)
        public static let ui = TypeStyle(postScriptName: "IBMPlexSerif-Regular", size: 14, lineHeight: 21, tracking: 0.00)
        public static let note = TypeStyle(postScriptName: "IBMPlexSerif-Italic", size: 13, lineHeight: 19, tracking: 0.00)
        public static let small = TypeStyle(postScriptName: "IBMPlexSerif-Regular", size: 13, lineHeight: 19, tracking: 0.00)
        public static let typedLg = TypeStyle(postScriptName: "IBMPlexMono-Bold", size: 15, lineHeight: 20, tracking: 0.00)
        public static let typed = TypeStyle(postScriptName: "IBMPlexMono-Regular", size: 13, lineHeight: 18, tracking: 0.00)
        public static let typedSm = TypeStyle(postScriptName: "IBMPlexMono-Regular", size: 12, lineHeight: 16, tracking: 0.00)
        public static let wordmark = TypeStyle(postScriptName: "IBMPlexMono-Bold", size: 18, lineHeight: 22, tracking: 0.00)
    }

    /// Fixed product sentences (tokens.json copy). The disclaimer is byte-identical to the engine's DISCLAIMER.
    public enum Copy {
        public static let disclaimer = "These indicators don't measure answer quality. Evidence, not proof."
        public static let privacyShort = "local only"
        public static let privacyLine = "No network code. Only the installer downloads, and only when you run it."
        public static let tagline = "Measure twice, blame once."
        public static let question = "Was it me, or the model?"
        /// The demo-data line under the popover footer (copy.canvas.report.footDemo).
        public static let demoNote = "Demo data, not from your logs."
    }

    /// tokens.json chart: integer daily strips, the window ratio's log axis, the timeline rule (points; thresholds are counts).
    public enum Chart {
        public enum Strip {
            public static let tickHeight: CGFloat = 2
            public static let tickGap: CGFloat = 1
            public static let denseTickHeight: CGFloat = 1
            public static let denseTickGap: CGFloat = 1
            public static let columnWidth: CGFloat = 14
            public static let columnGap: CGFloat = 6
            public static let compactColumnWidth: CGFloat = 6
            public static let compactColumnGap: CGFloat = 3
            public static let denseAbove = 25
            public static let lowNThreshold = 100
        }
        public enum Ratio {
            public static let domain: ClosedRange<Double> = 0.25...8
            public static let ticks: [Double] = [0.5, 1, 2, 4]
            public static let rangeStroke: CGFloat = 2
        }
        public enum Timeline {
            public static let rule: CGFloat = 2
        }
    }

    /// How a chip's 1 pt edge is drawn (CSS border-style).
    public enum EdgeStyle: String, Sendable { case solid, dashed, dotted }

    /// Finding states (D22 order) plus the display-only `stale`. Raw values are the contract names;
    /// `none` is spelled `noDetectableChange` so it can never be confused with `Optional.none`.
    public enum FindingState: String, CaseIterable, Sendable {
        case insufficient
        case noDetectableChange = "none"
        case unclear
        case you
        case agent
        case stale

        public var label: String {
            switch self {
            case .insufficient: return "Too early to tell"
            case .noDetectableChange: return "No detectable change"
            case .unclear: return "Can't tell which"
            case .you: return "Your side"
            case .agent: return "Agent side"
            case .stale: return "Out of date"
            }
        }
        public var headline: String {
            switch self {
            case .insufficient: return "Too early to tell."
            case .noDetectableChange: return "No detectable change."
            case .unclear: return "Can't tell which."
            case .you: return "Your side changed."
            case .agent: return "The agent changed."
            case .stale: return "Out of date."
            }
        }
        public var legend: String {
            switch self {
            case .insufficient: return "Dashed rule, two specks: too early to tell"
            case .noDetectableChange: return "Bare rule: no detectable change"
            case .unclear: return "Square and triangle: can't tell which"
            case .you: return "Square above the rule: your side changed"
            case .agent: return "Triangle below the rule: the agent changed"
            case .stale: return "Struck-through rule: out of date"
            }
        }
        public var textGlyph: String {
            switch self {
            case .insufficient: return "·┄·"
            case .noDetectableChange: return "───"
            case .unclear: return "■─▲"
            case .you: return "■──"
            case .agent: return "──▲"
            case .stale: return "─╱─"
            }
        }
        public var ascii: String {
            switch self {
            case .insufficient: return "[..]"
            case .noDetectableChange: return "[none]"
            case .unclear: return "[?]"
            case .you: return "[you]"
            case .agent: return "[agent]"
            case .stale: return "[stale]"
            }
        }
        public var menuBarImage16: String {
            switch self {
            case .insufficient: return "state-insufficient-16"
            case .noDetectableChange: return "state-none-16"
            case .unclear: return "state-unclear-16"
            case .you: return "state-you-16"
            case .agent: return "state-agent-16"
            case .stale: return "state-stale-16"
            }
        }
        public var menuBarImage18: String {
            switch self {
            case .insufficient: return "state-insufficient-18"
            case .noDetectableChange: return "state-none-18"
            case .unclear: return "state-unclear-18"
            case .you: return "state-you-18"
            case .agent: return "state-agent-18"
            case .stale: return "state-stale-18"
            }
        }

        /// The chip's edge (color.<mode>.state.<state>.edgeStyle; the same in light and dark).
        public var edgeStyle: EdgeStyle {
            switch self {
            case .insufficient: return .dashed
            case .noDetectableChange: return .solid
            case .unclear: return .solid
            case .you: return .solid
            case .agent: return .solid
            case .stale: return .dotted
            }
        }

        /// VoiceOver label for the glyph. `lastChecked` is used only by `stale` ("2 h ago").
        public func voiceOver(lastChecked when: String) -> String {
            switch self {
            case .insufficient: return "wasitme: too early to tell"
            case .noDetectableChange: return "wasitme: no detectable change"
            case .unclear: return "wasitme: numbers moved, can't tell which change"
            case .you: return "wasitme: your side changed"
            case .agent: return "wasitme: the agent changed"
            case .stale: return "wasitme: out of date, last checked \(when)"
            }
        }

        /// Appended to the VoiceOver label when the timeline has new changes (never while stale).
        public static func newChangesVoiceOver(_ n: Int) -> String {
            n == 1 ? ", \(n) new change on the timeline" : ", \(n) new changes on the timeline"
        }

        /// The "+n" beside the glyph.
        public static func newChangesText(_ n: Int) -> String {
            "+\(n)"
        }
    }

    /// Not a state (CONTRACT.md decision 12): what `insufficient` + reason `calibration_pending` displays.
    public enum CalibrationPending {
        public static let label = "Timeline only"
        public static let headline = "Timeline only, for now."
        public static let glyph: FindingState = .insufficient
    }

    /// The app's own document states (tokens.json appStates): about wasitme itself, never a finding. Their glyphs
    /// change the rule itself and never put a square above or a triangle below it; their chip is the quiet neutral one.
    public enum AppState: String, CaseIterable, Sendable {
        case loading
        case notSetUp
        case empty
        case unreadable
        case updateNeeded
        case refused

        public var label: String {
            switch self {
            case .loading: return "Loading"
            case .notSetUp: return "Not set up yet"
            case .empty: return "No agents yet"
            case .unreadable: return "Can't read status"
            case .updateNeeded: return "Update needed"
            case .refused: return "Not shown"
            }
        }
        public var legend: String {
            switch self {
            case .loading: return "Three dots: loading"
            case .notSetUp: return "Empty brackets: not set up yet"
            case .empty: return "Ticked rule, nothing on it: no agents yet"
            case .unreadable: return "Rule and exclamation mark: can't read status"
            case .updateNeeded: return "Two rules out of step: update needed"
            case .refused: return "Blacked-out rule: not shown"
            }
        }
        public var menuBarImage16: String {
            switch self {
            case .loading: return "app-loading-16"
            case .notSetUp: return "app-not-set-up-16"
            case .empty: return "app-empty-16"
            case .unreadable: return "app-unreadable-16"
            case .updateNeeded: return "app-update-needed-16"
            case .refused: return "app-refused-16"
            }
        }
        public var menuBarImage18: String {
            switch self {
            case .loading: return "app-loading-18"
            case .notSetUp: return "app-not-set-up-18"
            case .empty: return "app-empty-18"
            case .unreadable: return "app-unreadable-18"
            case .updateNeeded: return "app-update-needed-18"
            case .refused: return "app-refused-18"
            }
        }

        /// The chip every app state uses (tokens.json appStates.chip: existing colours, by path).
        public static let chipFg = Tokens.Palette.inkSecondary
        public static let chipBg = Tokens.Palette.surfaceSheet
        public static let chipGlyph = Tokens.Palette.inkSecondary
        public static let chipEdge = Tokens.Palette.ruleStrong
        public static let chipEdgeStyle: EdgeStyle = .solid
    }

    /// glyphs/*-16.svg and *-18.svg (the states, the app states, the mono mark) as vector primitives in SVG coordinates
    /// (y down, on the glyph's own pixel grid). Pure black and alpha: fill them with one colour or use them as a template.
    public enum Glyphs {
        public enum Primitive: Sendable, Equatable {
            case rect(CGRect)
            case fill([CGPoint])
            case stroke([CGPoint], width: CGFloat)
        }
        public struct Glyph: Sendable, Equatable {
            public let grid: CGFloat
            public let primitives: [Primitive]
        }
        /// Keyed by file name without ".svg": "state-you-16", "app-loading-18", "mark-16".
        public static let all: [String: Glyph] = [
            "state-insufficient-16": Glyph(grid: 16, primitives: [
                .rect(CGRect(x: 7, y: 2, width: 2, height: 2)),
                .rect(CGRect(x: 1, y: 7, width: 2, height: 2)),
                .rect(CGRect(x: 5, y: 7, width: 2, height: 2)),
                .rect(CGRect(x: 9, y: 7, width: 2, height: 2)),
                .rect(CGRect(x: 13, y: 7, width: 2, height: 2)),
                .rect(CGRect(x: 7, y: 12, width: 2, height: 2)),
            ]),
            "state-insufficient-18": Glyph(grid: 18, primitives: [
                .rect(CGRect(x: 8, y: 3, width: 2, height: 2)),
                .rect(CGRect(x: 2, y: 8, width: 2, height: 2)),
                .rect(CGRect(x: 6, y: 8, width: 2, height: 2)),
                .rect(CGRect(x: 10, y: 8, width: 2, height: 2)),
                .rect(CGRect(x: 14, y: 8, width: 2, height: 2)),
                .rect(CGRect(x: 8, y: 14, width: 2, height: 2)),
            ]),
            "state-none-16": Glyph(grid: 16, primitives: [
                .rect(CGRect(x: 1, y: 7, width: 14, height: 2)),
            ]),
            "state-none-18": Glyph(grid: 18, primitives: [
                .rect(CGRect(x: 1, y: 8, width: 16, height: 2)),
            ]),
            "state-unclear-16": Glyph(grid: 16, primitives: [
                .rect(CGRect(x: 5, y: 0, width: 6, height: 6)),
                .rect(CGRect(x: 1, y: 7, width: 14, height: 2)),
                .fill([CGPoint(x: 8, y: 10), CGPoint(x: 13, y: 16), CGPoint(x: 3, y: 16)]),
            ]),
            "state-unclear-18": Glyph(grid: 18, primitives: [
                .rect(CGRect(x: 6, y: 1, width: 6, height: 6)),
                .rect(CGRect(x: 1, y: 8, width: 16, height: 2)),
                .fill([CGPoint(x: 9, y: 11), CGPoint(x: 14, y: 18), CGPoint(x: 4, y: 18)]),
            ]),
            "state-you-16": Glyph(grid: 16, primitives: [
                .rect(CGRect(x: 5, y: 0, width: 6, height: 6)),
                .rect(CGRect(x: 1, y: 7, width: 14, height: 2)),
            ]),
            "state-you-18": Glyph(grid: 18, primitives: [
                .rect(CGRect(x: 6, y: 1, width: 6, height: 6)),
                .rect(CGRect(x: 1, y: 8, width: 16, height: 2)),
            ]),
            "state-agent-16": Glyph(grid: 16, primitives: [
                .rect(CGRect(x: 1, y: 7, width: 14, height: 2)),
                .fill([CGPoint(x: 8, y: 10), CGPoint(x: 13, y: 16), CGPoint(x: 3, y: 16)]),
            ]),
            "state-agent-18": Glyph(grid: 18, primitives: [
                .rect(CGRect(x: 1, y: 8, width: 16, height: 2)),
                .fill([CGPoint(x: 9, y: 11), CGPoint(x: 14, y: 18), CGPoint(x: 4, y: 18)]),
            ]),
            "state-stale-16": Glyph(grid: 16, primitives: [
                .rect(CGRect(x: 1, y: 7, width: 14, height: 2)),
                .stroke([CGPoint(x: 3.5, y: 15.5), CGPoint(x: 12.5, y: 0.5)], width: 1.5),
            ]),
            "state-stale-18": Glyph(grid: 18, primitives: [
                .rect(CGRect(x: 1, y: 8, width: 16, height: 2)),
                .stroke([CGPoint(x: 4, y: 17.5), CGPoint(x: 14, y: 0.5)], width: 1.5),
            ]),
            "app-loading-16": Glyph(grid: 16, primitives: [
                .rect(CGRect(x: 2, y: 7, width: 2, height: 2)),
                .rect(CGRect(x: 7, y: 7, width: 2, height: 2)),
                .rect(CGRect(x: 12, y: 7, width: 2, height: 2)),
            ]),
            "app-loading-18": Glyph(grid: 18, primitives: [
                .rect(CGRect(x: 2, y: 8, width: 2, height: 2)),
                .rect(CGRect(x: 8, y: 8, width: 2, height: 2)),
                .rect(CGRect(x: 14, y: 8, width: 2, height: 2)),
            ]),
            "app-not-set-up-16": Glyph(grid: 16, primitives: [
                .rect(CGRect(x: 1, y: 4, width: 2, height: 8)),
                .rect(CGRect(x: 3, y: 4, width: 2, height: 2)),
                .rect(CGRect(x: 3, y: 10, width: 2, height: 2)),
                .rect(CGRect(x: 13, y: 4, width: 2, height: 8)),
                .rect(CGRect(x: 11, y: 4, width: 2, height: 2)),
                .rect(CGRect(x: 11, y: 10, width: 2, height: 2)),
            ]),
            "app-not-set-up-18": Glyph(grid: 18, primitives: [
                .rect(CGRect(x: 1, y: 5, width: 2, height: 8)),
                .rect(CGRect(x: 3, y: 5, width: 2, height: 2)),
                .rect(CGRect(x: 3, y: 11, width: 2, height: 2)),
                .rect(CGRect(x: 15, y: 5, width: 2, height: 8)),
                .rect(CGRect(x: 13, y: 5, width: 2, height: 2)),
                .rect(CGRect(x: 13, y: 11, width: 2, height: 2)),
            ]),
            "app-empty-16": Glyph(grid: 16, primitives: [
                .rect(CGRect(x: 1, y: 4, width: 2, height: 8)),
                .rect(CGRect(x: 13, y: 4, width: 2, height: 8)),
                .rect(CGRect(x: 3, y: 7, width: 10, height: 2)),
            ]),
            "app-empty-18": Glyph(grid: 18, primitives: [
                .rect(CGRect(x: 1, y: 5, width: 2, height: 8)),
                .rect(CGRect(x: 15, y: 5, width: 2, height: 8)),
                .rect(CGRect(x: 3, y: 8, width: 12, height: 2)),
            ]),
            "app-unreadable-16": Glyph(grid: 16, primitives: [
                .rect(CGRect(x: 1, y: 7, width: 8, height: 2)),
                .rect(CGRect(x: 12, y: 1, width: 2, height: 9)),
                .rect(CGRect(x: 12, y: 12, width: 2, height: 2)),
            ]),
            "app-unreadable-18": Glyph(grid: 18, primitives: [
                .rect(CGRect(x: 1, y: 8, width: 9, height: 2)),
                .rect(CGRect(x: 14, y: 1, width: 2, height: 10)),
                .rect(CGRect(x: 14, y: 14, width: 2, height: 2)),
            ]),
            "app-update-needed-16": Glyph(grid: 16, primitives: [
                .rect(CGRect(x: 1, y: 5, width: 10, height: 2)),
                .rect(CGRect(x: 5, y: 9, width: 10, height: 2)),
            ]),
            "app-update-needed-18": Glyph(grid: 18, primitives: [
                .rect(CGRect(x: 1, y: 6, width: 11, height: 2)),
                .rect(CGRect(x: 6, y: 10, width: 11, height: 2)),
            ]),
            "app-refused-16": Glyph(grid: 16, primitives: [
                .rect(CGRect(x: 1, y: 5, width: 14, height: 6)),
            ]),
            "app-refused-18": Glyph(grid: 18, primitives: [
                .rect(CGRect(x: 1, y: 6, width: 16, height: 6)),
            ]),
            "mark-16": Glyph(grid: 16, primitives: [
                .rect(CGRect(x: 1, y: 1, width: 7, height: 7)),
                .fill([CGPoint(x: 11.5, y: 8.5), CGPoint(x: 15.5, y: 15), CGPoint(x: 7.5, y: 15)]),
            ]),
            "mark-18": Glyph(grid: 18, primitives: [
                .rect(CGRect(x: 1, y: 1, width: 8, height: 8)),
                .fill([CGPoint(x: 13, y: 9.5), CGPoint(x: 17.5, y: 17), CGPoint(x: 8.5, y: 17)]),
            ]),
        ]
    }

    static func dynamic(light: UInt32, dark: UInt32) -> SwiftUI.Color {
        SwiftUI.Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return Tokens.nsColor(isDark ? dark : light)
        })
    }

    static func nsColor(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}
