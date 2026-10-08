import AppKit
import SwiftUI
import WasitmeCore

// Shared building blocks, drawn after design/system/screens/components.css. Every colour/font/size comes from
// `Theme.current`; every engine string arrives already sanitized (AgentDisplay) and is rendered with
// `Text(verbatim:)`, so nothing is ever parsed as Markdown, a format string or a localization key. No `@State` /
// `#Preview` / `@Entry` (their macros need full Xcode; the app builds with Command Line Tools alone).

let theme = Theme.current

/// Plain text, never Markdown/localized: engine strings and numbers.
func plain(_ s: String) -> Text { Text(verbatim: s) }

/// App-owned copy with a command in backticks ("Run `wasitme doctor` in Terminal."): the command in the mono face, the
/// backticks never drawn. Every part is still `Text(verbatim:)`; nothing is parsed as Markdown.
func commandText(_ s: String, code: FontToken = theme.type.typed) -> Text {
    commandParts(s).reduce(Text(verbatim: "")) { acc, part in
        let text = Text(verbatim: part.text)
        return acc + (part.code ? text.font(code.font) : text)
    }
}

/// "Run `wasitme doctor` now" → ("Run ", false), ("wasitme doctor", true), (" now", false). Empty runs are dropped.
func commandParts(_ s: String) -> [(text: String, code: Bool)] {
    s.split(separator: "`", omittingEmptySubsequences: false).enumerated()
        .map { (text: String($0.element), code: $0.offset % 2 == 1) }
        .filter { !$0.text.isEmpty }
}

/// The same copy as VoiceOver and plain-text surfaces should have it: no backticks.
func commandWords(_ s: String) -> String { s.replacingOccurrences(of: "`", with: "") }

extension View {
    /// A type role set like the CSS sets it: the face, its tracking, and a line box of the role's line height (the
    /// difference to the face's own 1.3 em line is split above and below, as CSS half-leading does).
    func typeStyle(_ f: FontToken) -> some View {
        let extra = f.lineHeight - f.naturalLineHeight
        return font(f.font)
            .tracking(f.tracking)
            .lineSpacing(max(0, extra))
            .padding(.vertical, extra / 2)
    }

    func ink(_ c: ColorToken) -> some View { foregroundStyle(c.color) }

    /// A line along one edge, like a CSS border-top / border-bottom: it takes its own height, outside the content.
    func rule(_ edge: VerticalEdge, _ color: ColorToken, width: CGFloat) -> some View {
        padding(edge == .top ? .top : .bottom, width)
            .overlay(alignment: edge == .top ? .top : .bottom) {
                Rectangle().fill(color.color).frame(height: width)
            }
    }
}

/// A state glyph as a template image tinted with `color`. Decorative for VoiceOver: the words next to it carry the state.
struct GlyphView: View {
    let glyph: MenuBarGlyph
    var grid: GlyphGrid = .g16
    var size: CGFloat = theme.metrics.chipGlyph
    var color: ColorToken = theme.palette.ink

    var body: some View {
        Image(nsImage: theme.glyphs.templateImage(glyph, grid: grid, pointSize: size))
            .renderingMode(.template)
            .foregroundStyle(color.color)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The state chip (components.css `.chip`): the glyph plus the label in mono Bold, on the state's fg/bg/edge tokens;
/// `insufficient` dashed, `stale` dotted, `unclear` with the canary and blue blocks. One accessibility element.
struct StateChip: View {
    let glyph: MenuBarGlyph
    let text: String

    var body: some View {
        let style = theme.chipStyle(glyph)
        let shape = RoundedRectangle(cornerRadius: theme.radii.chip, style: .continuous)
        HStack(spacing: theme.spacing.s2) {
            if !style.swatches.isEmpty {
                HStack(spacing: 0) {
                    ForEach(Array(style.swatches.enumerated()), id: \.offset) { item in
                        Rectangle().fill(item.element.color).frame(width: theme.metrics.unclearSwatch)
                    }
                    Rectangle().fill(style.edge.color).frame(width: theme.stroke.keyline)
                }
            }
            GlyphView(glyph: glyph, color: style.fg)
            plain(text).typeStyle(theme.type.typed.bold).ink(style.fg).lineLimit(1).truncationMode(.tail)
        }
        .padding(.leading, style.swatches.isEmpty ? 6 : 0)
        .padding(.trailing, theme.spacing.s2)
        .frame(height: theme.metrics.chipHeight)
        .background(style.bg.color, in: shape)
        .clipShape(shape)
        .overlay(shape.strokeBorder(style.edge.color, style: Self.edge(style.edgeStyle)))
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: text))
    }

    /// CSS 1 px dashed / dotted borders, as Chrome draws them (3 on 3, and 1 on 1).
    static func edge(_ e: Tokens.EdgeStyle) -> StrokeStyle {
        switch e {
        case .solid: StrokeStyle(lineWidth: theme.stroke.keyline)
        case .dashed: StrokeStyle(lineWidth: theme.stroke.keyline, dash: [3, 3])
        case .dotted: StrokeStyle(lineWidth: theme.stroke.keyline, dash: [1, 1])
        }
    }
}

/// A one-line notice (scan failed, pending): the canvas's `.notice`, a 2 pt ink rule on its left, and optionally the
/// one control that acts on it (the canvas's plain "See Sources" button).
struct NoticeRow: View {
    let text: String
    var link: (title: String, hint: String, action: () -> Void)?

    var body: some View {
        HStack(spacing: theme.spacing.s3) {
            Rectangle().fill(theme.palette.ruleInk.color).frame(width: theme.stroke.rule)
            commandText(text).typeStyle(theme.type.ui.line(18)).ink(theme.palette.ink).lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(Text(verbatim: commandWords(text)))
            if let link {
                KeyButton(title: link.title, accessibilityHint: link.hint, action: link.action).fixedSize()
            }
            Spacer(minLength: 0)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// components.css `.btn`: mono Bold, ink outline on the raised surface; the primary button is ink-filled.
struct ThemedButtonStyle: ButtonStyle {
    var prominent = false
    var focused = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: theme.radii.control, style: .continuous)
        configuration.label
            .typeStyle(theme.type.typedSm.bold)
            .foregroundStyle((prominent ? theme.palette.actionText : enabled ? theme.palette.ink : theme.palette.inkMuted).color)
            .padding(.horizontal, theme.spacing.s3)
            .frame(height: theme.metrics.buttonHeight)
            .background((prominent ? theme.palette.action : theme.palette.raised).color, in: shape)
            .overlay(shape.strokeBorder((enabled ? theme.palette.ink : theme.palette.ruleStrong).color, lineWidth: theme.stroke.keyline))
            .overlay(shape.inset(by: -3).strokeBorder(theme.palette.focus.color, lineWidth: focused ? theme.stroke.focus : 0))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/// A button that is always in the keyboard loop (Tab / Shift-Tab), activates with Space or Return, and shows the
/// theme's focus ring. SwiftUI buttons on macOS otherwise join the loop only with Full Keyboard Access on.
struct KeyButton: View {
    let title: String
    var prominent = false
    var accessibilityHint: String?
    let action: () -> Void
    @FocusState private var focused: Bool
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button(action: action) { plain(title).lineLimit(1).fixedSize() }
            .buttonStyle(ThemedButtonStyle(prominent: prominent, focused: focused))
            .focusable(enabled)
            .focused($focused)
            .focusEffectDisabled()
            .onKeyPress(.space) { action(); return .handled }
            .onKeyPress(.return) { action(); return .handled }
            .accessibilityLabel(Text(verbatim: title))
            .accessibilityHint(accessibilityHint.map { Text(verbatim: $0) } ?? Text(verbatim: ""))
    }
}

/// Number formatting for engine numbers (the engine owns the words; the app only prints the numbers).
enum Num {
    /// "×2.69": two decimals, as the design prints ratios (×10 and up: one).
    static func ratio(_ x: Double?) -> String {
        guard let x, x.isFinite else { return "—" }
        return "×" + String(format: x < 10 ? "%.2f" : "%.1f", x)
    }

    /// "×1.55–×4.70" (D31: a range, never a confidence percentage).
    static func range(_ r: [Double]?) -> String? {
        guard let r, r.count == 2 else { return nil }
        return "\(ratio(r[0]))–\(ratio(r[1]))"
    }

    static func int(_ n: Int?) -> String {
        guard let n else { return "—" }
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US_POSIX")
        f.usesGroupingSeparator = true
        f.groupingSeparator = ","
        f.groupingSize = 3
        return f.string(from: NSNumber(value: n)) ?? String(n)
    }

    /// "Sep 21" from "2026-09-21" (fixed English month names; never locale-guessed).
    static func shortDay(_ day: String) -> String {
        let parts = day.split(separator: "-")
        guard parts.count == 3, let m = Int(parts[1]), let d = Int(parts[2]), (1...12).contains(m) else { return day }
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return "\(months[m - 1]) \(d)"
    }

    /// "06:34" in the user's time zone (a clock time in a sentence; 24-hour, as the design writes it).
    static func clock(_ date: Date, timeZone: TimeZone = .current) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let c = cal.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }
}

/// Day arithmetic on "YYYY-MM-DD" strings (calendar days; no time zone guessing).
enum DayIndex {
    static func of(_ day: String) -> Int? {
        let p = day.split(separator: "-")
        guard p.count == 3, let y = Int(p[0]), let m = Int(p[1]), let d = Int(p[2]) else { return nil }
        var c = DateComponents(); c.year = y; c.month = m; c.day = d
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        guard let date = cal.date(from: c) else { return nil }
        return Int((date.timeIntervalSince1970 / 86_400).rounded(.down))
    }

    static func day(_ index: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(index) * 86_400)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let c = cal.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}

/// The words for a metric's counts, as the canvas uses them (ui/src/derive.ts KN_WORDS / GATE_NOUN), so the popover and
/// the Control Center call the same things the same names. Every indicator the engine lists in the snapshot has an entry
/// in both (scripts/test/metric-words.test.mjs checks it against the engine's list and the canvas's tables).
enum MetricWords {
    static let kn: [String: (k: String, n: String)] = [
        "toolErrors": ("errors", "tool calls"), "toolErrorsNonCmd": ("errors", "tool calls"),
        "readsPerEdit": ("reads", "edits"), "blindEdits": ("unread edits", "edits"),
        "interrupts": ("interruptions", "exchanges"), "pushback": ("pushback", "prompts"),
        "cmdFailures": ("failures", "commands"), "churn": ("files", "exchanges"),
    ]
    static let gate: [String: String] = [
        "toolErrors": "errors", "toolErrorsNonCmd": "errors", "readsPerEdit": "edits", "blindEdits": "edits without reading first",
        "interrupts": "interruptions", "pushback": "pushback prompts", "cmdFailures": "command failures", "churn": "files",
    ]
    /// A gate noun too long for a popover row's second line beside its status: the canvas's own counted word for it
    /// (KN_WORDS), so "unread edits so far" keeps its meaning where "edits without reading first so far" was cut short.
    static let rowGate: [String: String] = ["blindEdits": "unread edits"]

    /// (k word, n word) for a metric id, else from its unit ("per 100 tool calls" -> events / tool calls).
    static func words(_ id: String, unit: String) -> (k: String, n: String) {
        if let w = kn[id] { return w }
        if unit.hasPrefix("per ") {
            let rest = unit.dropFirst(4)
            return ("events", rest.hasPrefix("100 ") ? String(rest.dropFirst(4)) : String(rest))
        }
        if let r = unit.range(of: " per ") { return (String(unit[..<r.lowerBound]), String(unit[r.upperBound...]) + "s") }
        return ("events", "opportunities")
    }

    /// The short noun after "N 3,150" in a popover row: the last word of the n word ("tool calls" -> "calls").
    static func nShort(_ id: String, unit: String) -> String {
        words(id, unit: unit).n.split(separator: " ").last.map(String.init) ?? "events"
    }

    static func gateNoun(_ id: String) -> String { gate[id] ?? "events" }

    /// What one unit of a metric's unlock gate is called: "sessions", "session-days", or its events ("edits", "errors").
    /// `row`: the short form a popover row has room for ("unread edits" for edits without reading first).
    static func gateUnitNoun(_ id: String, _ unit: GateUnit, row: Bool = false) -> String {
        switch unit {
        case .sessions: return "sessions"
        case .sessionDays: return "session-days"
        case .events: return (row ? rowGate[id] : nil) ?? gateNoun(id)
        }
    }

    /// "tool errors (excl. commands)" -> "tool errors": a name without its trailing qualifier, as the engine names the
    /// tool-error constructs in a sentence (engine/src/words/names.ts).
    static func withoutQualifier(_ name: String) -> String {
        guard name.hasSuffix(")"), let open = name.range(of: " (", options: .backwards) else { return name }
        return String(name[..<open.lowerBound])
    }

    /// "Tool errors" -> "tool errors" (a label inside a caption).
    static func inSentence(_ label: String) -> String {
        guard let first = label.first else { return label }
        let second = label.dropFirst().first
        // keep acronyms ("MCP servers") as they are
        if let second, second.isUppercase { return label }
        return first.lowercased() + label.dropFirst()
    }
}
