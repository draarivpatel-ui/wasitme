import AppKit
import Foundation
import Testing
@testable import WasitmeCore
@testable import WasitmeUI

/// What the popover and the desktop panel say and where the strip puts things (design/system popover-*, desktop-panel).
@Suite @MainActor struct PopoverContentTests {
    func display(_ file: String) throws -> GlanceDisplay {
        let entry = try #require(Repo.manifest.first { $0.file == file })
        return try #require(Repo.display(entry))
    }

    /// The headline is the design's state headline; the deck is the engine's sentence; the chip the engine's label.
    @Test func headWordsFollowTheDesign() throws {
        let you = PopoverHead.make(try display("glance/you-timeline.json"))
        #expect(you.title == "Your side changed." && you.chip == "Your side" && you.agentName == "Claude Code")
        #expect(you.deck == "Your numbers moved around the time of your effort change (Sep 21).")
        #expect(you.glyph == .you)
        let early = PopoverHead.make(try display("glance/insufficient-timeline.json"))
        #expect(early.title == "Too early to tell." && early.deck.hasPrefix("wasitme can already rule out"))
        let codex = PopoverHead.make(try display("glance/calibration_pending.json"))
        #expect(codex.title == "Your side changed.", "agents[0] speaks for the popover")
        let utc = try #require(TimeZone(identifier: "UTC"))
        let stale = PopoverHead.make(try display("glance/stale.json"), timeZone: utc)
        #expect(stale.glyph == .stale && stale.chip == "Out of date" && stale.title == "Out of date.")
        #expect(stale.deck == "The last check ran at 09:00, 9 h 30 min ago. Below is what it found then.")
        let mismatch = PopoverHead.make(try display("tamper/glance-schema-mismatch.json"))
        #expect(mismatch.glyph == .updateNeeded && mismatch.title == "Update needed.")
        #expect(!mismatch.deck.contains("Update needed"), "the deck doesn't repeat the title: \(mismatch.deck)")
    }

    /// App copy marks a command with backticks; the surfaces draw it as code and never draw a backtick.
    @Test func commandsAreDrawnWithoutBackticks() throws {
        let deck = AppCopy.detail(.notSetUp)
        #expect(deck.contains("`wasitme doctor`"))
        #expect(commandWords(deck) == "wasitme hasn't checked this Mac yet. Run wasitme doctor in Terminal.")
        // the parts the Text is built from: verbatim runs, the command marked as code, no backtick anywhere
        let parts = commandParts(deck)
        #expect(parts.map(\.text) == ["wasitme hasn't checked this Mac yet. Run ", "wasitme doctor", " in Terminal."])
        #expect(parts.map(\.code) == [false, true, false])
        #expect(commandParts("no command").map(\.text) == ["no command"])
        for doc in DocumentDisplay.allCases {
            #expect(commandParts(AppCopy.detail(doc)).allSatisfy { !$0.text.contains("`") }, "\(doc)")
        }
    }

    /// A failed scan's notice comes with the way to its details: a "See Sources" button that opens Sources.
    @Test func scanFailedNoticeOpensSources() throws {
        let d = try display("glance/scan-failed.json")
        let n = try #require(PopoverView.notices(d).first)
        #expect(n == PopoverView.Notice(text: "Last scan failed (permission denied).", opens: .sources))
        #expect(PopoverView.notices(try display("glance/you-timeline.json")).isEmpty)
        #expect(AppCopy.seeSources == "See Sources")
    }

    /// kit.mjs `strip(c, {width: 320, show: 14, compact: true, compactHeight: 28})`: 14 days ending at the last strip day,
    /// one column per day with sessions (half width under 100 opportunities), markers numbered / lettered oldest first.
    @Test func stripGeometryMatchesTheDesignGenerator() throws {
        let d = try display("glance/you-timeline.json")
        let p = try #require(d.primary)
        let strip = try #require(p.strip)
        let l = StripLayout.make(strip: strip, events: p.events, width: 320, compactHeight: 28, kRow: true, caption: "c")
        #expect(l.days.count == 14 && l.days.first?.d == "2026-09-20" && l.days.last?.d == "2026-10-03")
        #expect(l.axisY == 68 && l.height == 115 && l.axisTo == 300 && l.axisFrom == -4)
        #expect(l.columns.count == 14)
        let pitch: CGFloat = 300 / 14
        let lowN = try #require(l.columns.first { $0.width == 7 })      // Sep 28: 6 errors in 64 calls
        #expect(abs(lowN.x - (8 * pitch + (pitch - 14) / 2 + 3.5)) < 0.01)
        #expect(l.markers.map(\.text) == ["1", "B", "2", "C"])
        #expect(l.markers.map(\.kind) == [.you, .agentRoutine, .you, .agentRoutine])
        let first = try #require(l.markers.first)
        #expect(abs(first.lineX - (1 * pitch - 0.5)) < 0.01 && abs(first.x - (first.lineX - 10)) < 0.01)
        #expect(l.kRow.map(\.text) == ["7", "19", "24", "22", "18", "15", "26", "21", "6", "23", "25", "27", "30", "33"])
        #expect(PopoverView.caption(strip: strip, metric: p.metrics.first) == "tool errors per day, Sep 20 – Oct 3")
    }

    /// The agent's tag is the design token's size (tokens.json size.tag, 20 × 22), not a hand-drawn 23 pt (D68 follow-up).
    @Test func agentTagIsTheTokenSize() {
        let outline = StripLayout.tagOutline(x: 40, axisY: 68)
        let xs = outline.map(\.x), ys = outline.map(\.y)
        let box = CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
        #expect(box == CGRect(x: 40, y: 71, width: 20, height: 22))
        #expect(box.size == Tokens.Size.tag && Tokens.Size.tag == theme.metrics.tag)
        #expect(outline.first == CGPoint(x: 50, y: 71), "the point is centred, 3 pt under the line, clear of the 2 pt rule")
    }

    /// Crowded lanes (UX-V2 §7.3): the newest five changes all on the strip's last day (three of yours, two of unknown
    /// origin) become one range "1–3" held inside the strip and one tick, in the popover and on the desktop panel's
    /// narrow strip; two agent updates on neighbouring days merge into one range over both days on the panel.
    @Test func crowdedLanesGroupIntoRangesInsideTheStrip() throws {
        let d = try display("glance/you-timeline.json")
        let strip = try #require(d.primary?.strip)
        let last = try #require(strip.days.last?.d), prev = DayIndex.day(try #require(DayIndex.of(last)) - 1)
        func ev(_ day: String, _ side: ChangeSide, _ label: String) -> GlanceEvent {
            GlanceEvent(day: day, kind: "mcp", side: side, strength: side == .agent ? .routine : .strong, label: label)
        }
        // newest first, as the glance carries them
        let crowded = [ev(last, .unknown, "u2"), ev(last, .you, "c"), ev(last, .unknown, "u1"), ev(last, .you, "b"), ev(last, .you, "a")]
        for (width, height) in [(CGFloat(320), CGFloat(28)), (176, 36)] {
            let l = StripLayout.make(strip: strip, events: crowded, width: width, compactHeight: height, kRow: false, caption: "c")
            #expect(l.markers.map(\.text) == ["1–3"] && l.markers.first?.count == 3 && l.markers.first?.lineXs.count == 1)
            let m = try #require(l.markers.first)
            #expect(m.x >= -CaseLineStrip.bleed && m.x + m.width <= width, "\(width): the range stays inside the strip")
            #expect(m.width > Tokens.Size.sticker.width)
            #expect(l.unknownTicks.count == 1 && l.marked == 5)
        }
        let updates = [ev(last, .agent, "B"), ev(prev, .agent, "A")]
        let panel = StripLayout.make(strip: strip, events: updates, width: 176, compactHeight: 36, kRow: false, caption: "c")
        #expect(panel.markers.map(\.text) == ["A–B"] && panel.markers.first?.lineXs.count == 2 && panel.markers.first?.kind == .agentRoutine)
        let popover = StripLayout.make(strip: strip, events: updates, width: 320, compactHeight: 28, kRow: false, caption: "c")
        let xs = popover.markers.map(\.x)
        #expect(popover.markers.count == 1 || zip(popover.markers, popover.markers.dropFirst()).allSatisfy { $1.x - ($0.x + $0.width) >= 2 - 0.001 }, "\(xs)")
    }

    /// A strip day outside the schema (count above 1e9) must not trap: `Int(...) * 5` overflowed for k >= 2^63 - 512.
    @Test(arguments: [Int.max, Int.max - 511, 1_000_000_000])
    func anOutOfRangeStripCountDoesNotTrap(k: Int) throws {
        let d = try display("glance/you-timeline.json")
        let strip = try #require(d.primary?.strip)
        let last = try #require(strip.days.last?.d)
        let huge = Strip(metric: strip.metric, days: strip.days.dropLast() + [StripDay(d: last, k: k, n: 5)], window: strip.window)
        let l = StripLayout.make(strip: huge, events: [], width: 320, compactHeight: 28, kRow: true, caption: "c")
        let column = try #require(l.columns.last)
        #expect(column.height.isFinite && column.height > 0 && column.height <= 28 + 0.001, "the tallest column fills the chart")
    }

    /// The display model bounds a hostile strip to the schema's range, so no later sum over the days can overflow either.
    @Test func theDisplayBoundsStripCountsToTheSchemaRange() throws {
        let entry = try #require(Repo.manifest.first { $0.file == "glance/you-timeline.json" })
        let data = try Data(contentsOf: Repo.fixtures.appendingPathComponent(entry.file))
        var agent = try #require(ContractFile.readGlance(data).glance?.agents.first)
        let days = [StripDay(d: "2026-10-01", k: Int.max, n: Int.max), StripDay(d: "2026-10-02", k: Int.max, n: -5),
                    StripDay(d: "2026-10-03", k: -7, n: 3)]
        agent.strip = Strip(metric: "tool_errors", days: days)
        let shown = try #require(AgentDisplay(agent, isCurrent: true).strip)
        #expect(shown.days.map(\.k) == [1_000_000_000, 1_000_000_000, 0])
        #expect(shown.days.map(\.n) == [1_000_000_000, 0, 3])
        let layout = StripLayout.make(strip: shown, events: [], width: 320, compactHeight: 28, kRow: true, caption: "c")
        #expect(!PopoverView.stripAccessibility(layout, metric: nil, strip: shown).isEmpty)
    }

    @Test func markerLettersRunPastZ() {
        #expect(StripLayout.letters(0) == "A" && StripLayout.letters(25) == "Z" && StripLayout.letters(26) == "AA")
    }

    /// Glance rules (DESIGN.md §3): the panel says the state, the agent, a count and the time; never a cause.
    @Test func desktopPanelLinesAreGlanceOnly() throws {
        let you = try display("glance/you-timeline.json")
        #expect(DesktopPanelView(display: you, size: .small).meta == ["Claude Code", "30 min ago"])
        #expect(DesktopPanelView(display: you, size: .medium).meta == ["Claude Code", "updated 30 min ago"])
        let fresh = try display("glance/unclear-timeline.json")
        #expect(DesktopPanelView(display: fresh, size: .small).meta == ["Claude Code", "+1 new change", "30 min ago"])
        let stale = try display("glance/stale.json")
        #expect(DesktopPanelView(display: stale, size: .small).meta == ["Claude Code", "checked 9 h 30 min ago"])
        for entry in Repo.manifest where entry.contract == "glance" {
            let d = try #require(Repo.display(entry))
            for line in DesktopPanelView(display: d, size: .medium).meta {
                #expect(line.firstMatch(of: /(?i)\b(worse|better|nerf\w*|degrad\w*|improv\w*)\b/) == nil, "\(entry.file): \(line)")
            }
        }
    }

    /// A popover metric row under an unlock gate: the binding pair in its own unit ("7 of 10" over "session-days so far"),
    /// never "3,023 of 10" over "edits so far" next to "Not enough yet" (docs/CONTRACT.md#display-rules).
    @Test func unlockRowsShowTheBindingGateInItsOwnUnit() throws {
        let need10 = GateCounts(events: 10, sessions: 5, sessionDays: 10)
        let days = Unlock(metric: "readsPerEdit", have: GateCounts(events: 3023, sessions: 7, sessionDays: 7), need: need10)
        #expect(MetricRow.unlockWords(days)?.value == "7 of 10")
        #expect(MetricRow.unlockWords(days)?.nLine == "session-days so far")
        let blind = Unlock(metric: "blindEdits", have: GateCounts(events: 798, sessions: 3, sessionDays: 12), need: need10)
        #expect(MetricRow.unlockWords(blind)?.value == "3 of 5")
        #expect(MetricRow.unlockWords(blind)?.nLine == "sessions so far")
        let edits = Unlock(metric: "readsPerEdit", have: GateCounts(events: 31, sessions: 4, sessionDays: 9),
                           need: GateCounts(events: 40, sessions: 5, sessionDays: 10))
        #expect(MetricRow.unlockWords(edits)?.value == "31 of 40")
        #expect(MetricRow.unlockWords(edits)?.nLine == "edits so far")
        // every pair met (one session dominating): no gate words, the row keeps its plain counts
        #expect(MetricRow.unlockWords(Unlock(metric: "readsPerEdit", have: GateCounts(events: 2100, sessions: 43, sessionDays: 56), need: need10)) == nil)
        #expect(MetricRow.unlockWords(nil) == nil)
        // the shared golden: still "31 of 40" over "edits so far"
        let d = try display("glance/insufficient-verdict.json")
        let u = try #require(d.primary?.progress?.unlock.first { $0.metric == "readsPerEdit" })
        #expect(MetricRow.unlockWords(u)?.value == "31 of 40" && MetricRow.unlockWords(u)?.nLine == "edits so far")
    }

    /// Every indicator the engine lists in the snapshot (engine/src/words/build.ts `SNAPSHOT_METRICS`), with the label and
    /// unit the engine gives it (engine/src/words/names.ts), read from the engine's own source: a new indicator can't
    /// reach the app without its words.
    static func engineIndicators() throws -> [(id: String, label: String, unit: String)] {
        let words = Repo.root.appendingPathComponent("engine/src/words", isDirectory: true)
        let build = try String(contentsOf: words.appendingPathComponent("build.ts"), encoding: .utf8)
        let names = try String(contentsOf: words.appendingPathComponent("names.ts"), encoding: .utf8)
        let list = try #require(build.firstMatch(of: /SNAPSHOT_METRICS[^=]*=\s*\[([^\]]*)\]/), "SNAPSHOT_METRICS in build.ts")
        return try list.1.matches(of: /"(\w+)"/).map { m in
            let id = String(m.1)
            let row = try Regex("\\b\(id): \\{ label: \"([^\"]+)\", unit: \"([^\"]+)\"")
            let found = try #require(names.firstMatch(of: row), "\(id): its label in names.ts")
            return (id, String(try #require(found.output[1].substring)), String(try #require(found.output[2].substring)))
        }
    }

    /// The words tables cover every indicator. toolErrorsNonCmd (the tool-error construct that votes on real installs)
    /// had none, so the desktop panel called its columns "events" and its unlock row counted "events".
    @Test func everyIndicatorHasItsWords() throws {
        _ = Headless.ready
        let all = try Self.engineIndicators()
        #expect(all.count >= 8 && all.contains { $0.id == "toolErrorsNonCmd" }, "\(all.map(\.id))")
        for m in all {
            #expect(MetricWords.kn[m.id] != nil, "\(m.id): no counted words in MetricWords.kn")
            #expect(MetricWords.gate[m.id] != nil, "\(m.id): no gate noun in MetricWords.gate")
        }
        let w = MetricWords.words("toolErrorsNonCmd", unit: "per 100 tool calls")
        #expect(w.k == "errors" && w.n == "tool calls")
        #expect(MetricWords.gateUnitNoun("toolErrorsNonCmd", .events) == "errors")
        let p = try #require(try display("glance/you-timeline.json").primary)
        #expect(DesktopPanelView.caption(Strip(metric: "toolErrorsNonCmd"), p) == "errors per day, 14 days")
        let u = Unlock(metric: "toolErrorsNonCmd", have: GateCounts(events: 4, sessions: 9, sessionDays: 20),
                       need: GateCounts(events: 10, sessions: 5, sessionDays: 10))
        #expect(MetricRow.unlockWords(u)?.nLine == "errors so far")
    }

    /// A metric the glance names without a label of its own is drawn by the engine's label, never by its id: the Codex
    /// demo's Control Center printed "toolErrors" under Next to unlock. MetricNames is word for word the engine's table,
    /// and an id this version does not know is drawn as its words.
    @Test func everyIndicatorIsNamedNeverByItsId() throws {
        for m in try Self.engineIndicators() {
            #expect(MetricNames.name(m.id) == m.label, "\(m.id)")
            let json = #"{"id":"\#(m.id)","unit":"\#(m.unit)","recent":{"k":2,"n":120},"baseline":{"k":2,"n":120}}"#
            let decoded = try JSONDecoder().decode(GlanceMetric.self, from: Data(json.utf8))
            #expect(decoded.label == m.label, "\(m.id): a metric without its label decodes as \"\(decoded.label)\"")
        }
        #expect(MetricNames.name("fooBarBaz") == "Foo bar baz")
        #expect(MetricNames.name("--") == "Indicator")
        #expect(MetricNames.name(String(repeating: "aA", count: 16)) == "Indicator", "words longer than a label's 40 are no name")

        // The display every surface draws: a row whose label is empty (or emptied by the sanitizer) gets its name, and the
        // unlock row under it counts in words, so no camelCase id reaches the popover or the panel.
        let entry = try #require(Repo.manifest.first { $0.file == "glance/insufficient-verdict.json" })
        let data = try Data(contentsOf: Repo.fixtures.appendingPathComponent(entry.file))
        var raw = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        var agents = try #require(raw["agents"] as? [[String: Any]])
        var top = try #require(agents[0]["topMetrics"] as? [[String: Any]])
        let ids = top.compactMap { $0["id"] as? String }
        for i in top.indices { top[i]["label"] = i == 0 ? "" : "\u{200B}" }
        agents[0]["topMetrics"] = top
        raw["agents"] = agents
        let (status, glance) = ContractFile.readGlance(try JSONSerialization.data(withJSONObject: raw))
        let now = try #require(ContractDate.parse(entry.now))
        let d = try #require(GlanceDisplay.make(status: status, glance: glance, now: now).primary)
        #expect(d.metrics.map(\.id) == ids)
        #expect(d.metrics.map(\.label) == ids.map { MetricNames.label[$0] ?? "" }, "\(d.metrics.map(\.label))")
        for m in d.metrics {
            let words = [m.label, MetricRow.unlockWords(d.progress?.unlock.first { $0.metric == m.id })?.nLine ?? ""].joined(separator: " ")
            #expect(words.firstMatch(of: /\b[a-z]+[A-Z]\w*\b/) == nil, "\(m.id): \(words)")
        }
    }

    /// A strip's caption is drawn whole (never clipped at the strip's edge) with both dates, for every indicator at the
    /// widest dates ("Sep 30 – Oct 13"): the longest names, "Tool errors (excl. commands)" and "Edits without reading
    /// first", draw a shorter form; the accessibility label keeps the whole title.
    @Test func stripCaptionsFitWholeWithTheirDates() throws {
        _ = Headless.ready
        #expect(FontRegistry.isRegistered, "measured with the app's own face")
        let start = try #require(DayIndex.of("2026-09-30"))
        let days = (0..<14).map { StripDay(d: DayIndex.day(start + $0), k: 2, n: 120) }
        let p = try #require(try display("glance/you-timeline.json").primary)
        let popoverFits = { (s: String) in StripLayout.captionWidth(s) <= 320 }
        var drawn: [String: String] = [:]
        for m in try Self.engineIndicators() {
            let strip = Strip(metric: m.id, days: days)
            let metric = GlanceMetric(id: m.id, label: m.label, unit: m.unit, recent: KN(k: 2, n: 120), baseline: KN(k: 2, n: 120))
            let shown = PopoverView.caption(strip: strip, metric: metric, fits: popoverFits)
            drawn[m.id] = shown
            #expect(StripLayout.captionWidth(shown) <= 320, "\(m.id): \"\(shown)\" is \(StripLayout.captionWidth(shown)) pt")
            #expect(shown.hasSuffix(" per day, Sep 30 – Oct 13"), "\(m.id): \(shown)")
            let whole = PopoverView.caption(strip: strip, metric: metric)
            #expect(whole == "\(MetricWords.inSentence(m.label)) per day, Sep 30 – Oct 13")
            let layout = StripLayout.make(strip: strip, events: [], width: 320, compactHeight: 28, kRow: true, caption: shown)
            #expect(layout.caption == shown)
            #expect(PopoverView.stripAccessibility(layout, metric: metric, strip: strip).hasPrefix("\(whole): "), "\(m.id)")
            let panel = DesktopPanelView.caption(strip, p)
            #expect(StripLayout.captionWidth(panel) <= 176, "\(m.id): the panel's \"\(panel)\"")
        }
        #expect(drawn["toolErrorsNonCmd"] == "tool errors per day, Sep 30 – Oct 13")
        #expect(drawn["blindEdits"] == "unread edits per day, Sep 30 – Oct 13")
        #expect(drawn["toolErrors"] == "tool errors per day, Sep 30 – Oct 13", "a name that fits is drawn as it is")
    }

    /// An unlock row's second line fits whole beside "Not enough yet" in every unit, for every indicator: "edits without
    /// reading first so far" was cut to "edits without reading first…", losing "so far".
    @Test func unlockLinesFitBesideTheirStatus() throws {
        _ = Headless.ready
        let row = theme.metrics.popover.width - 2 * theme.spacing.s4
        let status = StripLayout.captionWidth("Not enough yet")
        let need = GateCounts(events: 10, sessions: 5, sessionDays: 10)
        let short: [GateCounts] = [GateCounts(events: 3, sessions: 5, sessionDays: 10), GateCounts(events: 10, sessions: 3, sessionDays: 10),
                                   GateCounts(events: 10, sessions: 5, sessionDays: 7)]
        for m in try Self.engineIndicators() {
            for have in short {
                let line = try #require(MetricRow.unlockWords(Unlock(metric: m.id, have: have, need: need))?.nLine)
                #expect(line.hasSuffix(" so far"))
                #expect(StripLayout.captionWidth(line) + theme.spacing.s2 + status <= row, "\(m.id): \"\(line)\"")
            }
        }
        let blind = Unlock(metric: "blindEdits", have: GateCounts(events: 3, sessions: 9, sessionDays: 20), need: need)
        #expect(MetricRow.unlockWords(blind)?.nLine == "unread edits so far")
        #expect(MetricRow.unlockWords(blind)?.value == "3 of 10")
    }

    /// The demo-data line under the popover footer is drawn whole on one line: "demo data (wasitme demo) — not from your
    /// logs" was 45 mono characters at 12 pt, wider than the 320 pt row, and was cut to "not from your lo…".
    @Test func demoLineFitsThePopoverWhole() throws {
        _ = Headless.ready
        #expect(FontRegistry.isRegistered, "measured with the app's own face")
        let row = theme.metrics.popover.width - 2 * theme.spacing.s4
        let line = PopoverView.demoLine
        #expect(line == Tokens.Copy.demoNote && !line.isEmpty)
        #expect(StripLayout.captionWidth(line) <= row, "\"\(line)\" is \(StripLayout.captionWidth(line)) pt in a \(row) pt row")
        #expect(StripLayout.captionWidth("demo data (wasitme demo) — not from your logs") > row, "the old line is measured as too wide")
    }
}

/// "Copy evidence report" / "Open as Markdown": the pasteboard, the private temp file, and nothing but that file opened.
@Suite @MainActor struct ReportExporterTests {
    struct Fixed: ReportMarkdownSource {
        let text: String
        func markdown(agentID: String?) async throws -> String { text }
    }

    struct Failing: ReportMarkdownSource {
        func markdown(agentID: String?) async throws -> String { throw ReportExportError.unavailable("no report yet") }
    }

    @Test func copiesThePlainTextAndCleansIt() async throws {
        let board = NSPasteboard(name: NSPasteboard.Name("wasitme-test-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        let dir = try TempDir("report")
        let e = ReportExporter(source: Fixed(text: "# Report\n\u{1B}[31m×2.69\u{202E}\tok"), pasteboard: board, directory: dir.url,
                               openFile: { _ in Issue.record("copy must not open anything"); return false })
        guard case .success = await e.copy(agentID: "claude-code") else { Issue.record("copy failed"); return }
        #expect(board.string(forType: .string) == "# Report\n[31m×2.69\tok")
    }

    @Test func opensOnlyItsOwnTempMarkdownFile() async throws {
        let dir = try TempDir("report-open")
        let reports = dir.url.appendingPathComponent("wasitme-reports", isDirectory: true)
        var opened: [URL] = []
        let e = ReportExporter(source: Fixed(text: "# Report"), directory: reports, openFile: { opened.append($0); return true },
                               now: { Date(timeIntervalSince1970: 1_791_115_200) })
        let url = try (await e.openMarkdown(agentID: "claude-code")).get()
        #expect(opened == [url] && url.isFileURL && url.pathExtension == "md")
        #expect(url.lastPathComponent == "wasitme-report-claude-code-2026-10-04T120000.md")
        #expect(try String(contentsOf: url, encoding: .utf8) == "# Report")
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        #expect((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        #expect(ReportExporter.isOwnReportFile(url, in: reports))
        #expect(!ReportExporter.isOwnReportFile(URL(string: "https://example.invalid/r.md")!, in: reports))
        #expect(!ReportExporter.isOwnReportFile(dir.url.appendingPathComponent("elsewhere.md"), in: reports))
    }

    @Test func aMissingReportSaysSoAndDoesNothing() async throws {
        let board = NSPasteboard(name: NSPasteboard.Name("wasitme-test-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        board.clearContents()
        board.setString("before", forType: .string)
        let dir = try TempDir("report-missing")
        let e = ReportExporter(source: Failing(), pasteboard: board, directory: dir.url, openFile: { _ in Issue.record("opened"); return true })
        guard case .failure(.unavailable("no report yet")) = await e.copy(agentID: nil) else { Issue.record("copied"); return }
        guard case .failure(let err) = await e.openMarkdown(agentID: nil) else { Issue.record("opened"); return }
        #expect(err.message.contains("Nothing was copied or opened"))
        #expect(board.string(forType: .string) == "before")
    }

    /// The engine has no `report` command yet (WP-30): with no engine set up, the source says so in plain words.
    @Test func engineSourceWithoutAnEngine() async throws {
        let dir = try TempDir("report-engine")
        let source = EngineReportSource(runner: EngineRunner(directory: WasitmeDirectory(dir.url)))
        await #expect(throws: ReportExportError.unavailable("wasitme's engine isn't set up")) {
            _ = try await source.markdown(agentID: "claude-code")
        }
    }
}
