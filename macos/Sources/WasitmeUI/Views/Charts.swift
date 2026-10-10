import SwiftUI
import WasitmeCore

/// The geometry of the compact evidence strip (DESIGN.md §8 "Compact variant"; design/system/gen/screens/kit.mjs
/// `strip(..., compact: true)`): one solid column per day on the case line, your numbered stickers above it, the agent's
/// lettered tags below, the k row under it, a dotted "today" tail. Pure, so tests can check it without drawing.
/// Crowded lanes group as the canvas groups them (UX-V2 §7.3): one mark a day per lane, a range ("1–3") where days
/// collide, changes of unknown origin as one faint tick a day on the line.
struct StripLayout: Equatable {
    struct Column: Equatable { let x, y, width, height: CGFloat; let zero: Bool }
    struct Label: Equatable { let x: CGFloat; let text: String; let muted: Bool }
    /// One mark on a lane: a change's own sticker / tag, or a range ("1–3", "B–C") for consecutive changes on one day or
    /// on days too close for their marks (docs/design/UX-V2.md §7.3, crowded lanes; ui/src/charts.ts `laneMarks`).
    struct Marker: Equatable {
        enum Kind: Equatable { case you, agentStrong, agentRoutine }
        let kind: Kind
        let text: String
        /// Left edge of the sticker / tag.
        let x: CGFloat
        /// Its width: the token size for one or two characters, wider for a range.
        let width: CGFloat
        /// Where its connector meets the case line: one x per day it covers, oldest first.
        let lineXs: [CGFloat]
        /// How many changes it stands for.
        let count: Int
        /// The first day's x (the only one, for a single change).
        var lineX: CGFloat { lineXs.first ?? x }
    }

    let width: CGFloat
    let height: CGFloat
    /// The case line's y (kit.mjs `yA`).
    let axisY: CGFloat
    let axisFrom: CGFloat
    let axisTo: CGFloat
    let columns: [Column]
    let markers: [Marker]
    /// Changes of unknown origin: one faint tick a day on the case line (no "?" circle; UX-V2 §7.3).
    let unknownTicks: [CGFloat]
    /// Every change in view (yours, the agent's, unknown origin), however the marks group them.
    let marked: Int
    let kRow: [Label]
    let kRowY: CGFloat?
    let caption: String
    let days: [StripDay]

    static let stickerTop: CGFloat = 20       // 4 + oy (16)
    static let connectorTop: CGFloat = 42     // 26 + oy
    /// The agent tag's point sits this far below the case line's centre, clear of the 2 pt rule (kit.mjs `yA + 3`).
    static let tagTop: CGFloat = 3
    /// How far below the point the tag's shoulders are (kit.mjs `yA + 9`).
    static let tagShoulder: CGFloat = 6

    /// The agent's pointed tag hanging below the case line, left edge `x`: point, right shoulder, bottom right, bottom
    /// left, left shoulder. Its box is `Tokens.Size.tag` (20 × 22, DESIGN.md §7), so it ends 25 pt below the line.
    /// A range is the same tag stretched to `width`, its point at the centre.
    static func tagOutline(x: CGFloat, axisY yA: CGFloat, width: CGFloat = Tokens.Size.tag.width) -> [CGPoint] {
        let size = Tokens.Size.tag, top = yA + tagTop, shoulder = top + tagShoulder, bottom = top + size.height
        return [CGPoint(x: x + width / 2, y: top), CGPoint(x: x + width, y: shoulder),
                CGPoint(x: x + width, y: bottom), CGPoint(x: x, y: bottom), CGPoint(x: x, y: shoulder)]
    }

    /// How wide `text` is drawn in the caption's face (typedSm), so a surface can pick a caption that fits its strip.
    @MainActor static func captionWidth(_ text: String) -> CGFloat {
        (text as NSString).size(withAttributes: [.font: theme.type.typedSm.nsFont]).width
    }

    /// A mark's width: the sticker's 20 pt for one or two characters, else the text (mono 12: 0.6 em a character, rounded
    /// up) plus 3 pt a side.
    static func markWidth(_ text: String) -> CGFloat {
        text.count <= 2 ? Tokens.Size.sticker.width : (CGFloat(text.count) * 7.3 + 6).rounded(.up)
    }

    /// One lane's marks (the canvas's `laneMarks`, ui/src/charts.ts; docs/design/UX-V2.md §7.3): one mark a day, except
    /// an agent change that isn't a routine update, which keeps its own tag; neighbours overlapping by more than a nudge
    /// (4 pt) merge into a range over their days, again with the mark before; then the least movement that keeps every
    /// gap (pool-adjacent-violators on the left edges, a kept change held at its day), held between `minLeft` and
    /// `maxRight`; and while a mark sits more than half a sticker from its days, it joins the neighbour that pushed it.
    /// The glance carries no candidates, so the canvas's "lines up with the shift" rule has nothing to hold here.
    /// `items` are the lane's changes in view, oldest first, with their markers and their day's x.
    static func laneMarks(_ items: [(event: GlanceEvent, text: String, x: CGFloat)], agent: Bool,
                          minLeft: CGFloat, maxRight: CGFloat) -> [Marker] {
        typealias Item = (event: GlanceEvent, text: String, x: CGFloat)
        struct M {
            var members: [Item], lo: CGFloat, hi: CGFloat, w: CGFloat, text: String, pinned: Bool, x: CGFloat = 0
            var mid: CGFloat { x + w / 2 }
            var off: CGFloat { mid < lo ? lo - mid : mid > hi ? mid - hi : 0 }
        }
        let gap: CGFloat = 2, nudge: CGFloat = 4, slack = Tokens.Size.sticker.width / 2
        let pin = { (e: GlanceEvent) in agent && e.strength != .routine }
        func mark(_ members: [Item]) -> M {
            let text = members.count == 1 ? members[0].text : "\(members[0].text)–\(members[members.count - 1].text)"
            let xs = members.map(\.x)
            return M(members: members, lo: xs.min()!, hi: xs.max()!, w: markWidth(text), text: text,
                     pinned: members.count == 1 && pin(members[0].event))
        }
        var days: [M] = [], run: [Item] = []
        func flush() { if !run.isEmpty { days.append(mark(run)); run = [] } }
        for it in items {
            if pin(it.event) { flush(); days.append(mark([it])); continue }
            if let first = run.first, first.event.day != it.event.day { flush() }
            run.append(it)
        }
        flush()
        var out: [M] = []
        for m in days {
            out.append(m)
            while out.count >= 2 {
                let b = out[out.count - 1], a = out[out.count - 2]
                if a.pinned || b.pinned || (b.lo + b.hi) / 2 - (a.lo + a.hi) / 2 >= (a.w + b.w) / 2 + gap - nudge { break }
                out.removeLast(2)
                out.append(mark(a.members + b.members))
            }
        }
        func place() {
            guard !out.isEmpty else { return }
            var offs: [CGFloat] = [], acc: CGFloat = 0
            for m in out { offs.append(acc); acc += m.w + gap }
            var blocks: [(sum: CGFloat, wt: CGFloat, n: Int)] = []
            for (i, m) in out.enumerated() {
                let wt: CGFloat = m.pinned ? 1000 : 1
                blocks.append((((m.lo + m.hi) / 2 - m.w / 2 - offs[i]) * wt, wt, 1))
                while blocks.count >= 2 {
                    let b = blocks[blocks.count - 1], a = blocks[blocks.count - 2]
                    if a.sum / a.wt <= b.sum / b.wt { break }
                    blocks.removeLast(2)
                    blocks.append((a.sum + b.sum, a.wt + b.wt, a.n + b.n))
                }
            }
            let last = out.count - 1, hiY = maxRight - out[last].w - offs[last]
            var i = 0
            for b in blocks {
                let y = max(minLeft, min(hiY, b.sum / b.wt))
                for _ in 0..<b.n { out[i].x = y + offs[i]; i += 1 }
            }
        }
        var stuck = Set<String>()
        while true {
            place()
            var worst = -1, most = slack
            for (i, m) in out.enumerated() where !m.pinned && !stuck.contains(m.text) && m.off > most { most = m.off; worst = i }
            if worst < 0 { break }
            let m = out[worst], right = m.mid > m.hi
            let order = right ? [worst - 1, worst + 1] : [worst + 1, worst - 1]
            guard let j = order.first(where: { $0 >= 0 && $0 < out.count && !out[$0].pinned }) else { stuck.insert(m.text); continue }
            let (a, b) = j < worst ? (out[j], m) : (m, out[j])
            out.replaceSubrange(min(worst, j)...max(worst, j), with: [mark(a.members + b.members)])
        }
        return out.map { m in
            let strong = m.members.contains { $0.event.strength != .routine }
            var xs: [CGFloat] = []
            for it in m.members where xs.last != it.x { xs.append(it.x) }
            return Marker(kind: agent ? (strong ? .agentStrong : .agentRoutine) : .you, text: m.text, x: m.x, width: m.w,
                          lineXs: xs, count: m.members.count)
        }
    }

    /// `show` contiguous days ending at the strip's last day (missing days have no sessions); events in that range.
    static func make(strip: Strip, events: [GlanceEvent], width: CGFloat, show: Int = 14, columnArea: CGFloat? = nil,
                     compactHeight: CGFloat, kRow: Bool, caption: String) -> StripLayout {
        let byDay = Dictionary(strip.days.compactMap { d in DayIndex.of(d.d).map { ($0, d) } }, uniquingKeysWith: { a, _ in a })
        let last = byDay.keys.max() ?? 0
        let first = last - show + 1
        let rows: [StripDay] = (first...last).map { i in byDay[i] ?? StripDay(d: DayIndex.day(i), k: 0, n: 0) }

        let x0: CGFloat = 0
        let x1 = columnArea ?? (width - 20)
        let pitch = (x1 - x0) / CGFloat(rows.count)
        let colW = min(Tokens.Chart.Strip.columnWidth, pitch - 4)
        let maxK = max(rows.map(\.k).max() ?? 0, 10)
        // Rounded up to a multiple of 5 in floating point: the Int product trapped for a count near Int.max (a file
        // outside the schema's 1e9 bound; GlanceDisplay now bounds it too, this keeps the layout total on its own).
        let top = CGFloat((Double(maxK) / 5).rounded(.up) * 5)
        let yTop: CGFloat = 24 + 16
        let yA = yTop + compactHeight
        let cu = compactHeight / top

        var columns: [Column] = []
        for (i, r) in rows.enumerated() where r.n > 0 {
            let cx = x0 + CGFloat(i) * pitch + (pitch - colW) / 2
            if r.k > 0 {
                let h = CGFloat(r.k) * cu
                let w = r.n < Tokens.Chart.Strip.lowNThreshold ? colW / 2 : colW
                columns.append(Column(x: cx + (colW - w) / 2, y: yA - h, width: w, height: h, zero: false))
            } else {
                columns.append(Column(x: cx + colW / 2 - 1, y: yA - 3, width: 2, height: 2, zero: true))
            }
        }

        // Markers: numbered / lettered over every event the glance carries, oldest first (the canvas letters over the
        // whole timeline, which the glance doesn't have: see `markerLabels`). Each lane laid out by `laneMarks`: one
        // mark a day, ranges where days collide, nothing past the strip's ends; unknown origin as one tick a day.
        let labels = markerLabels(events)
        let firstDay = rows.first?.d ?? "", lastDay = rows.last?.d ?? ""
        var you: [(event: GlanceEvent, text: String, x: CGFloat)] = [], agent = you
        var unknownTicks: [CGFloat] = []
        var marked = 0
        for (e, text) in labels where e.day >= firstDay && e.day <= lastDay {
            guard let di = DayIndex.of(e.day) else { continue }
            let bx = x0 + CGFloat(di - first) * pitch - 0.5
            marked += 1
            switch e.side {
            case .you: you.append((e, text, bx))
            case .agent: agent.append((e, text, bx))
            case .unknown: unknownTicks.append(bx + 2)
            case .meta: marked -= 1
            }
        }
        // the frame bleeds 4 pt left of the first column (CaseLineStrip.bleed) and ends at `width`
        let markers = (laneMarks(you, agent: false, minLeft: x0 - CaseLineStrip.bleed, maxRight: width)
            + laneMarks(agent, agent: true, minLeft: x0 - CaseLineStrip.bleed, maxRight: width))
            .sorted { ($0.x, $0.kind == .you ? 0 : 1) < ($1.x, $1.kind == .you ? 0 : 1) }     // left to right, yours first

        let yk = yA + 41
        let k: [Label] = kRow ? rows.enumerated().map { i, r in
            Label(x: x0 + CGFloat(i) * pitch + pitch / 2, text: r.n == 0 ? "–" : String(r.k), muted: r.n == 0)
        } : []
        let height = kRow ? yk + 6 : yA + 30
        return StripLayout(width: width, height: height, axisY: yA, axisFrom: x0 - 4, axisTo: x1, columns: columns,
                           markers: markers, unknownTicks: Array(Set(unknownTicks)).sorted(), marked: marked, kRow: k, kRowY: kRow ? yk : nil,
                           caption: caption, days: rows)
    }

    /// Your changes numbered 1, 2, 3 and the agent's lettered A, B, C, oldest first (ui/src/decode.ts rule). Wasitme's
    /// own (meta) events get no marker. The glance holds only the newest five events, so for a long timeline these can
    /// differ from the Control Center's letters (contract gap, reported).
    static func markerLabels(_ events: [GlanceEvent]) -> [(GlanceEvent, String)] {
        var you = 0, agent = 0
        return events.reversed().compactMap { e in
            switch e.side {
            case .you: you += 1; return (e, String(you))
            case .agent: agent += 1; return (e, letters(agent - 1))
            case .unknown: return (e, "?")
            case .meta: return nil
            }
        }
    }

    static func letters(_ i: Int) -> String {
        var n = i, s = ""
        repeat {
            s = String(UnicodeScalar(UInt8(65 + n % 26))) + s
            n = n / 26 - 1
        } while n >= 0
        return s
    }
}

/// Draws a `StripLayout` (kit.mjs classes: c-tick, c-zero, c-axis, c-today, c-conn, c-you, c-agent(-routine), c-label).
struct CaseLineStrip: View {
    let layout: StripLayout
    var accessibilityText: String

    /// The case line and the label row start 4 pt left of the first column (SVG overflow: visible).
    static let bleed: CGFloat = 4

    var body: some View {
        Canvas { ctx, _ in
            ctx.translateBy(x: Self.bleed, y: 0)
            draw(&ctx)
        }
        .frame(width: layout.width + Self.bleed, height: layout.height)
        .padding(.leading, -Self.bleed)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: accessibilityText))
    }

    private func draw(_ ctx: inout GraphicsContext) {
        let p = theme.palette
        let yA = layout.axisY
        // caption
        text(&ctx, layout.caption, x: 0, baseline: 11, font: theme.type.typedSm, color: p.chartLabel, anchor: .leading)
        // columns
        for c in layout.columns {
            ctx.fill(Path(CGRect(x: c.x, y: c.y, width: c.width, height: c.height)), with: .color(p.chartMark.color))
        }
        // connectors, then stickers / tags
        let dashed = StrokeStyle(lineWidth: 1, dash: [2, 2])
        for m in layout.markers {
            let mid = m.x + m.width / 2
            let aligned = m.lineXs.count == 1 && abs(mid - m.lineX) < 1.5      // a nudge of a point needs no elbow
            let lo = min(mid, m.lineXs.min() ?? mid), hi = max(mid, m.lineXs.max() ?? mid)
            switch m.kind {
            case .you:
                var line = Path()
                if aligned {
                    line.move(to: CGPoint(x: m.lineX, y: StripLayout.connectorTop)); line.addLine(to: CGPoint(x: m.lineX, y: yA))
                } else {
                    // a range (or a mark moved off its day): a comb, from under the sticker to the line at each of its days
                    let yc = StripLayout.connectorTop
                    line.move(to: CGPoint(x: mid, y: StripLayout.stickerTop + theme.metrics.sticker.height)); line.addLine(to: CGPoint(x: mid, y: yc))
                    line.move(to: CGPoint(x: lo, y: yc)); line.addLine(to: CGPoint(x: hi, y: yc))
                    for x in m.lineXs { line.move(to: CGPoint(x: x, y: yc)); line.addLine(to: CGPoint(x: x, y: yA)) }
                }
                ctx.stroke(line, with: .color(p.chartConnector.color), style: dashed)
                let r = CGRect(x: m.x, y: StripLayout.stickerTop, width: m.width, height: theme.metrics.sticker.height)
                let shape = Path(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), cornerRadius: theme.radii.sticker)
                ctx.fill(shape, with: .color(p.youFill.color))
                ctx.stroke(shape, with: .color(p.youKeyline.color), lineWidth: theme.stroke.keyline)
                text(&ctx, m.text, x: mid, baseline: StripLayout.stickerTop + 14, font: theme.type.typedSm.bold, color: p.youInk, anchor: .center)
            case .agentStrong, .agentRoutine:
                if !aligned {
                    // the agent's lane has no connectors: a range marks the days it covers on the underside of the line
                    ctx.fill(Path(CGRect(x: lo - 1, y: yA + 1, width: hi - lo + 2, height: 1.5)), with: .color(p.agentKeyline.color))
                }
                let tag = Path { t in t.addLines(StripLayout.tagOutline(x: m.x, axisY: yA, width: m.width)); t.closeSubpath() }
                let strong = m.kind == .agentStrong
                ctx.fill(tag, with: .color((strong ? p.agentFill : p.sheet).color))
                ctx.stroke(tag, with: .color(p.agentKeyline.color), lineWidth: theme.stroke.keyline)
                text(&ctx, m.text, x: mid, baseline: yA + 22, font: theme.type.typedSm.bold,
                     color: strong ? p.agentInk : p.inkSecondary, anchor: .center)
            }
        }
        // changes of unknown origin: one faint tick a day across the line, in the gap beside the day's edge
        for x in layout.unknownTicks {
            var tick = Path(); tick.move(to: CGPoint(x: x, y: yA - 6)); tick.addLine(to: CGPoint(x: x, y: yA + 2.5))
            ctx.stroke(tick, with: .color(p.inkSecondary.color), lineWidth: 1.5)
        }
        // the case line and today's dotted tail
        var axis = Path(); axis.move(to: CGPoint(x: layout.axisFrom, y: yA)); axis.addLine(to: CGPoint(x: layout.axisTo, y: yA))
        ctx.stroke(axis, with: .color(p.chartAxis.color), lineWidth: Tokens.Chart.Timeline.rule)
        var today = Path(); today.move(to: CGPoint(x: layout.axisTo + 4, y: yA)); today.addLine(to: CGPoint(x: layout.axisTo + 18, y: yA))
        ctx.stroke(today, with: .color(p.chartLabel.color), style: StrokeStyle(lineWidth: 1, dash: [1, 3]))
        // k row
        if let yk = layout.kRowY {
            for l in layout.kRow {
                text(&ctx, l.text, x: l.x, baseline: yk, font: theme.type.typedSm, color: l.muted ? p.chartLabel : p.ink, anchor: .center)
            }
        }
    }

    /// Text placed by its baseline, like SVG `<text y=…>`; `anchor` is the horizontal text-anchor.
    private func text(_ ctx: inout GraphicsContext, _ s: String, x: CGFloat, baseline: CGFloat, font: FontToken,
                      color: ColorToken, anchor: HorizontalAlignment) {
        let resolved = ctx.resolve(Text(verbatim: s).font(font.font).foregroundStyle(color.color))
        let size = resolved.measure(in: CGSize(width: 1_000, height: 100))
        let ascent = resolved.firstBaseline(in: size)
        let left: CGFloat
        switch anchor {
        case .center: left = x - size.width / 2
        case .trailing: left = x - size.width
        default: left = x
        }
        ctx.draw(resolved, in: CGRect(x: left, y: baseline - ascent, width: size.width, height: size.height))
    }
}
