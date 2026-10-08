import SwiftUI
import WasitmeCore

public enum DesktopPanelSize: String, CaseIterable, Sendable {
    case small, medium
    var size: CGSize { self == .small ? theme.metrics.panelSmall : theme.metrics.panelMedium }
}

/// The desktop panel, drawn after design/system/screens/desktop-panel-*.png. A glance surface: the glyph,
/// the state label, the agent, a count of new changes and the time; never a cause, never "worse" or "better". Medium
/// adds the integer daily strip without labels. Same in both lead layouts. Speaks for agents[0], like the menu bar.
struct DesktopPanelView: View {
    let display: GlanceDisplay
    let size: DesktopPanelSize

    var body: some View {
        let s = size.size
        let shape = RoundedRectangle(cornerRadius: theme.radii.panel, style: .continuous)
        Group {
            if size == .medium, let p = display.primary, let strip = p.strip, !strip.days.isEmpty,
               display.document == .ok || display.document == .stale {
                HStack(alignment: .bottom, spacing: theme.spacing.s2) {
                    textColumn.frame(width: 150, alignment: .topLeading)
                    CaseLineStrip(layout: StripLayout.make(strip: strip, events: p.events, width: 176, compactHeight: 36,
                                                           kRow: false, caption: Self.caption(strip, p)),
                                  accessibilityText: "")
                        .accessibilityHidden(true)
                }
            } else {
                textColumn
            }
        }
        .padding(theme.spacing.s4)
        .frame(width: s.width, height: s.height, alignment: .topLeading)
        .background(theme.palette.raised.color, in: shape)
        .clipShape(shape)
        .overlay(shape.strokeBorder(theme.palette.ruleStrong.color, lineWidth: theme.stroke.hair))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: accessibilityText))
    }

    private var textColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            GlyphView(glyph: display.glyph, grid: .g18, size: theme.metrics.panelGlyph, color: theme.palette.ink)
            if size == .medium { Spacer(minLength: 0).frame(maxHeight: 30) } else { Spacer(minLength: 0) }
            plain(label).typeStyle(size == .small ? theme.type.heading.withSize(theme.type.deck.size, line: theme.type.typedLg.lineHeight) : theme.type.heading)
                .ink(theme.palette.ink).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(meta.enumerated()), id: \.offset) { item in
                    plain(item.element).typeStyle(theme.type.typedSm).ink(theme.palette.inkSecondary).lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.top, 6)
            if size == .medium { Spacer(minLength: 0) }
        }
        .frame(maxHeight: .infinity, alignment: .topLeading)
    }

    private var label: String {
        switch display.document {
        case .ok: display.primary?.stateText ?? display.stateText
        case .stale: Tokens.FindingState.stale.label
        default: display.stateText
        }
    }

    /// "Claude Code" / "+1 new change" / "4 min ago" (design desktop-panel), or why there is nothing to show.
    var meta: [String] {
        var lines: [String] = []
        if let name = display.primary?.name { lines.append(name) }
        switch (display.document, display.freshness) {
        case (.ok, .fresh(let age)):
            if display.newEventCount > 0 { lines.append(AppCopy.newChangesShort(display.newEventCount)) }
            let ago = "\(AppCopy.preciseDuration(age)) ago"
            lines.append(size == .medium && display.newEventCount == 0 ? "updated \(ago)" : ago)
        case (.stale, .stale(let age)):
            lines.append("checked \(AppCopy.preciseDuration(age)) ago")
        case (.stale, _), (.unreadable, _):
            lines.append(AppCopy.lastKnownPrefix.lowercased() + " state")
        case (.ok, _), (.empty, _):
            lines.append(AppCopy.updated(display.freshness).lowercased())
        default:
            lines.append(AppCopy.localOnly)
        }
        if display.scanFailed { lines.append("last scan failed") }
        if display.demo { lines.append("demo data") }
        return lines
    }

    /// "errors per day, 14 days" over the medium panel's 176 pt strip; "unread edits per day" where the days would not
    /// fit (`fits`: the caption is never clipped).
    static func caption(_ strip: Strip, _ p: AgentDisplay, fits: (String) -> Bool = { StripLayout.captionWidth($0) <= 176 }) -> String {
        let unit = p.metrics.first { $0.id == strip.metric }?.unit ?? ""
        let k = MetricWords.words(strip.metric, unit: unit).k
        return ["\(k) per day, 14 days", "\(k) per day"].first(where: fits) ?? "\(k) per day"
    }

    /// The single-glyph label plus the panel's own lines, in plain words.
    private var accessibilityText: String {
        ([display.accessibilityLabel] + meta.dropFirst(display.primary == nil ? 0 : 1)).joined(separator: ". ")
    }
}
