import SwiftUI
import WasitmeCore

/// The Control Center pages (the nav in DESIGN.md §3). The canvas draws them and its own sidebar (view.chrome = "full").
/// Raw values are the canvas's page ids; the UI word for `verdict` is "Finding" (D57).
public enum ControlCenterPage: String, CaseIterable, Sendable, Identifiable {
    case timeline, verdict, compare, setup, report, sources, settings
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .timeline: "Timeline"
        case .verdict: "Finding"
        case .compare: "Compare"
        case .setup: "Setup"
        case .report: "Report"
        case .sources: "Sources"
        case .settings: "Settings"
        }
    }
    /// D28/D61: timeline-led (the default) lands on Timeline, verdict-led on Finding.
    public static func landing(for lead: Lead) -> ControlCenterPage { lead == .verdict ? .verdict : .timeline }
}

public struct PopoverActions {
    public var openControlCenter: (ControlCenterPage?) -> Void
    public var scanNow: () -> Void
    public var toggleDesktopPanel: () -> Void
    public var quit: () -> Void

    public init(openControlCenter: @escaping (ControlCenterPage?) -> Void, scanNow: @escaping () -> Void,
                toggleDesktopPanel: @escaping () -> Void, quit: @escaping () -> Void) {
        self.openControlCenter = openControlCenter; self.scanNow = scanNow
        self.toggleDesktopPanel = toggleDesktopPanel; self.quit = quit
    }

    public static var inert: PopoverActions { PopoverActions(openControlCenter: { _ in }, scanNow: {}, toggleDesktopPanel: {}, quit: {}) }
}

/// What the popover's top block says, decided once from the display (pure; tested).
struct PopoverHead: Equatable {
    let glyph: MenuBarGlyph
    let chip: String
    let agentName: String
    let title: String
    let deck: String

    static func make(_ d: GlanceDisplay, timeZone: TimeZone = .current) -> PopoverHead {
        let name = d.primary?.name ?? ""
        switch d.document {
        case .ok:
            guard let p = d.primary else { return neutral(d) }
            let state = Tokens.FindingState(rawValue: p.state.rawValue) ?? .unclear
            let title = p.timelineOnly ? Tokens.CalibrationPending.headline : state.headline
            return PopoverHead(glyph: MenuBarGlyph(p.state), chip: p.stateText, agentName: name, title: title, deck: p.headline)
        case .stale:
            return PopoverHead(glyph: .stale, chip: Tokens.FindingState.stale.label, agentName: name,
                               title: Tokens.FindingState.stale.headline, deck: staleDeck(d, timeZone: timeZone))
        default:
            return neutral(d)
        }
    }

    /// "The last check ran at 06:34, 2 h 40 min ago. Below is what it found then." (design popover-stale).
    static func staleDeck(_ d: GlanceDisplay, timeZone: TimeZone) -> String {
        guard case .stale(let age) = d.freshness, let at = d.generatedAt else { return AppCopy.staleReason(d.freshness) }
        let then = d.primary == nil ? "" : " Below is what it found then."
        return "The last check ran at \(Num.clock(at, timeZone: timeZone)), \(AppCopy.preciseDuration(age)) ago.\(then)"
    }

    static func neutral(_ d: GlanceDisplay) -> PopoverHead {
        let title = AppCopy.title(d.document)
        return PopoverHead(glyph: d.glyph, chip: title, agentName: d.primary?.name ?? "", title: title + ".",
                           deck: AppCopy.detail(d.document))
    }
}

/// The menu bar drop-down (352×480), drawn after design/system/screens/popover-*.png: the state chip and the agent,
/// the finding headline and the engine's sentence, the 14-day case-line strip with your stickers above and the agent's
/// tags below, three metric rows, the fixed disclaimer, and the footer buttons. The same layout serves both leads: its
/// strip already carries the change timeline (D28/D61 timeline-led is the default; verdict-led changes the Control
/// Center's landing page). Renders a `GlanceDisplay` only, so `--capture` and the live app draw the same thing.
struct PopoverView: View {
    let display: GlanceDisplay
    var scanning = false
    var engineMessage: String?
    let actions: PopoverActions

    private var head: PopoverHead { PopoverHead.make(display) }
    private var showsLastKnown: Bool { display.document == .ok || display.document == .stale || display.document == .unreadable }
    private var buttonsCheckFirst: Bool { display.document != .ok || display.agents.isEmpty }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: theme.radii.popover, style: .continuous)
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                header
                titleBlock
                notices
                if showsLastKnown, let p = display.primary { evidence(p) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .clipped()
            footer
        }
        .frame(width: theme.metrics.popover.width, height: theme.metrics.popover.height)
        .background(theme.palette.raised.color, in: shape)
        .clipShape(shape)
        .overlay(shape.strokeBorder(theme.palette.ruleStrong.color, lineWidth: theme.stroke.hair))
    }

    // MARK: head: chip + agent, headline + deck

    private var header: some View {
        HStack(alignment: .center) {
            StateChip(glyph: head.glyph, text: head.chip)
            Spacer(minLength: theme.spacing.s2)
            if !head.agentName.isEmpty {
                plain(head.agentName).typeStyle(theme.type.typedSm).ink(theme.palette.inkMuted).lineLimit(1)
            }
        }
        .padding(.top, 14)
        .padding(.horizontal, theme.spacing.s4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: [display.accessibilityLabel, head.agentName].filter { !$0.isEmpty }.joined(separator: ", ")))
        .accessibilityAddTraits(.isHeader)
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: theme.spacing.s1) {
            plain(head.title).typeStyle(theme.type.popTitle).ink(theme.palette.ink)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            if !head.deck.isEmpty {
                // engine decks never hold backticks as markup (they are sanitized plain text); the app's own copy does
                (display.document == .ok ? plain(head.deck) : commandText(head.deck))
                    .typeStyle(theme.type.ui.line(theme.type.typedLg.lineHeight)).ink(theme.palette.inkSecondary)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel(Text(verbatim: display.document == .ok ? head.deck : commandWords(head.deck)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 6)
        .padding(.horizontal, theme.spacing.s4)
    }

    /// One notice under the headline, and the Control Center page its button opens (if any).
    struct Notice: Equatable, Hashable {
        let text: String
        let opens: ControlCenterPage?
    }

    /// The notices, decided once from the display (pure; tested). A failed scan comes with the way to its details (the
    /// canvas's "See Sources" button), never a sentence pointing at a page with no way there.
    static func notices(_ d: GlanceDisplay) -> [Notice] {
        [
            d.scanFailed ? Notice(text: AppCopy.scanFailed(d.scanError), opens: .sources) : nil,
            d.document == .ok && d.primary?.pending == true ? Notice(text: AppCopy.pendingNote, opens: nil) : nil,
            d.document == .unreadable && d.primary != nil ? Notice(text: AppCopy.detail(.unreadable), opens: nil) : nil,
        ].compactMap { $0 }
    }

    @ViewBuilder private var notices: some View {
        let list = Self.notices(display)
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: theme.spacing.s1) {
                ForEach(list, id: \.self) { n in
                    if let page = n.opens {
                        NoticeRow(text: n.text, link: (AppCopy.seeSources, "Opens \(page.title) in the Control Center", { actions.openControlCenter(page) }))
                    } else {
                        NoticeRow(text: n.text)
                    }
                }
            }
            .padding(.top, theme.spacing.s2)
            .padding(.horizontal, theme.spacing.s4)
        }
    }

    // MARK: evidence: strip, metric rows, disclaimer

    @ViewBuilder private func evidence(_ p: AgentDisplay) -> some View {
        if let strip = p.strip, !strip.days.isEmpty {
            let metric = p.metrics.first { $0.id == strip.metric }
            let layout = StripLayout.make(strip: strip, events: p.events, width: 320, compactHeight: 28, kRow: true,
                                          caption: Self.caption(strip: strip, metric: metric, fits: { StripLayout.captionWidth($0) <= 320 }))
            CaseLineStrip(layout: layout, accessibilityText: Self.stripAccessibility(layout, metric: metric, strip: strip))
                .padding(.top, theme.spacing.s2)
                .padding(.leading, theme.spacing.s4)
        }
        if !p.timelineOnly, !p.metrics.isEmpty {
            VStack(spacing: 0) {
                ForEach(p.metrics) { MetricRow(metric: $0, agent: p) }
            }
            .rule(.top, theme.palette.ruleInk, width: theme.stroke.rule)
            .padding(.top, 6)
            .padding(.horizontal, theme.spacing.s4)
            if [.noDetectableChange, .you, .agent].contains(p.state) {
                plain(Tokens.Copy.disclaimer).typeStyle(theme.type.note.line(theme.type.typedSm.lineHeight))
                    .ink(theme.palette.inkSecondary).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 3)
                    .padding(.horizontal, theme.spacing.s4)
            }
        }
        let others = display.agents.dropFirst()
        if !others.isEmpty {
            plain("Also: " + others.map { "\($0.name), \($0.stateText)" }.joined(separator: "; "))
                .typeStyle(theme.type.typedSm).ink(theme.palette.inkMuted).lineLimit(1).truncationMode(.tail)
                .padding(.top, theme.spacing.s1)
                .padding(.horizontal, theme.spacing.s4)
        }
    }

    /// "tool errors (excl. commands) per day, Sep 20 – Oct 3": the strip's whole title, which its accessibility label
    /// says. The strip draws the first form that `fits` its width (the caption is never clipped): the whole title, else
    /// the indicator's name without its qualifier ("tool errors per day, …", as the engine names it in a sentence), else
    /// what each column counts ("unread edits per day, …"). The dates are in every form.
    nonisolated static func caption(strip: Strip, metric: GlanceMetric?, fits: (String) -> Bool = { _ in true }) -> String {
        let label = metric.map { MetricWords.inSentence($0.label) }
        var names = [label, label.map(MetricWords.withoutQualifier)].compactMap { $0 }
        names.append(MetricWords.words(strip.metric, unit: metric?.unit ?? "").k)
        let days = strip.days.compactMap { DayIndex.of($0.d) }
        let when = days.max().map { ", \(Num.shortDay(DayIndex.day($0 - 13))) – \(Num.shortDay(DayIndex.day($0)))" } ?? ""
        let forms = names.map { "\($0) per day\(when)" }
        return forms.first(where: fits) ?? forms[forms.count - 1]
    }

    /// The strip's numbers in words (no number is visual-only, DESIGN.md §8), under its whole title.
    nonisolated static func stripAccessibility(_ l: StripLayout, metric: GlanceMetric?, strip: Strip) -> String {
        let w = MetricWords.words(strip.metric, unit: metric?.unit ?? "")
        let k = l.days.reduce(0) { $0 + $1.k }, n = l.days.reduce(0) { $0 + $1.n }
        let perDay = l.days.map { "\(Num.shortDay($0.d)): \($0.n == 0 ? "no sessions" : "\($0.k)")" }.joined(separator: "; ")
        let marks = l.marked == 0 ? "" : "; \(l.marked) changes marked"
        return "\(caption(strip: strip, metric: metric)): \(Num.int(k)) \(w.k) in \(Num.int(n)) \(w.n)\(marks). \(perDay)"
    }

    // MARK: footer

    /// The line under the footer when the data is `wasitme demo`'s: the report's short demo note (tokens.json
    /// copy.canvas.report.footDemo), one line at the popover's width. The longer "demo data (wasitme demo) — not from
    /// your logs" was cut to "not from your lo…"; the footer can't take a second line without clipping the evidence.
    static var demoLine: String { Tokens.Copy.demoNote }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                if buttonsCheckFirst {
                    KeyButton(title: scanning ? "Checking…" : "Check again", prominent: true,
                              accessibilityHint: "Runs a scan now") { actions.scanNow() }
                        .disabled(scanning)
                    KeyButton(title: "Open wasitme", accessibilityHint: "Opens the Control Center") { actions.openControlCenter(nil) }
                    Spacer(minLength: 0)
                } else {
                    KeyButton(title: "It feels worse…", accessibilityHint: "Opens Compare in the Control Center") { actions.openControlCenter(.compare) }
                    KeyButton(title: "Share", accessibilityHint: "Opens the report in the Control Center") { actions.openControlCenter(.report) }
                    Spacer(minLength: 0)
                    KeyButton(title: "Open wasitme", prominent: true, accessibilityHint: "Opens the Control Center") { actions.openControlCenter(nil) }
                }
            }
            commandText(scanning ? "Checking…" : (engineMessage ?? display.footer), code: theme.type.typedSm.bold)
                .typeStyle(theme.type.typedSm).ink(theme.palette.inkMuted).lineLimit(1)
                .padding(.top, theme.spacing.s1)
            if display.demo {
                plain(Self.demoLine).typeStyle(theme.type.typedSm).ink(theme.palette.inkMuted)
                    .lineLimit(1).padding(.top, 2)
            }
        }
        .padding(.top, 5)
        .padding(.bottom, 6)
        .padding(.horizontal, theme.spacing.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .rule(.top, theme.palette.ruleHair, width: theme.stroke.hair)
    }
}

/// One popover metric row (design popover-*: `.mrow`): the signal and its ratio with the range; the N and the status.
struct MetricRow: View {
    let metric: GlanceMetric
    let agent: AgentDisplay

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: theme.spacing.s2) {
                plain(metric.label).typeStyle(theme.type.ui.line(theme.type.typed.lineHeight)).ink(theme.palette.ink)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
                value
            }
            HStack(alignment: .firstTextBaseline, spacing: theme.spacing.s2) {
                plain(nLine).typeStyle(theme.type.typedSm).ink(theme.palette.inkMuted).lineLimit(1)
                Spacer(minLength: 0)
                plain(status).typeStyle(theme.type.typedSm).ink(theme.palette.inkSecondary).lineLimit(1)
            }
        }
        .padding(.vertical, 1)
        .rule(.bottom, theme.palette.ruleHair, width: theme.stroke.hair)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(metric.label): \(valueWords), \(nLine), \(status)"))
    }

    private var unlock: Unlock? { agent.progress?.unlock.first { $0.metric == metric.id } }
    private var eligible: Bool { metric.status != .ineligible && metric.ratio != nil }
    private var friction: Bool { metric.family == .friction }

    @ViewBuilder private var value: some View {
        if eligible {
            HStack(spacing: 0) {
                plain(Num.ratio(metric.ratio)).typeStyle(theme.type.typedSm.bold).ink(theme.palette.ink)
                if let r = Num.range(metric.range) {
                    plain(" " + r).typeStyle(theme.type.typedSm).ink(theme.palette.inkMuted)
                }
            }
            .lineLimit(1).fixedSize()
        } else {
            plain(valueWords).typeStyle(theme.type.typedSm.bold).ink(theme.palette.ink).lineLimit(1).fixedSize()
        }
    }

    /// "×2.69 ×1.67–×4.34", "31 of 40" (an unlock gate), "2 in 14 days" (context only).
    private var valueWords: String {
        if eligible { return [Num.ratio(metric.ratio), Num.range(metric.range)].compactMap { $0 }.joined(separator: " ") }
        if let w = Self.unlockWords(unlock) { return w.value }
        let days = agent.n.days.map { " in \($0) days" } ?? ""
        return "\(Num.int(metric.recent.k))\(days)"
    }

    /// "N 3,150 calls", or "edits so far" / "session-days so far" under an unlock gate.
    private var nLine: String {
        if !eligible, let w = Self.unlockWords(unlock) { return w.nLine }
        return "N \(Num.int(metric.recent.n)) \(MetricWords.nShort(metric.id, unit: metric.unit))"
    }

    /// An unlock gate's two lines in a row, from its one binding pair (`Unlock.binding`): "7 of 10" over
    /// "session-days so far", "31 of 40" over "edits so far", "3 of 10" over "unread edits so far" (the row's short noun,
    /// so the line fits beside its status whole). Nil when no unit is short of its target: the row then shows its plain
    /// counts, never a met count against a target ("3,150 of 10").
    nonisolated static func unlockWords(_ u: Unlock?) -> (value: String, nLine: String)? {
        guard let u, let g = u.binding else { return nil }
        return ("\(Num.int(g.have)) of \(Num.int(g.need))", "\(MetricWords.gateUnitNoun(u.metric, g.unit, row: true)) so far")
    }

    /// D44(5c) status words; the popover's short "Not detected" (DESIGN.md §7). Never a quality word.
    private var status: String {
        switch metric.status {
        case .worse?, .better?:
            guard let r = metric.ratio else { return "Moved" }
            return r >= 1 ? "Moved, more" : "Moved, fewer"
        case .none?: return "Not detected"
        case .ineligible?: return friction ? "Context only" : "Not enough yet"
        case nil: return ""
        }
    }
}
