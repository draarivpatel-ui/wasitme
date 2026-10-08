import Foundation
import Testing
@testable import WasitmeCore

/// The display model every surface renders from, held to the shared manifest (docs/CONTRACT.md#display-rules).
@Suite struct GlanceDisplayTests {
    typealias Entry = GoldenTests.Manifest.Entry

    static func display(for entry: Entry) throws -> GlanceDisplay {
        let data = try Fixtures.golden(entry.file)
        let now = try #require(ContractDate.parse(entry.now))
        if entry.contract == "glance" {
            let (status, glance) = ContractFile.readGlance(data)
            return GlanceDisplay.make(status: status, glance: glance, now: now)
        }
        let (status, snapshot) = ContractFile.readSnapshot(data)
        return GlanceDisplay.make(status: status, glance: snapshot?.glancePart, now: now)
    }

    @Test(arguments: GoldenTests.manifest.fixtures.map(\.file))
    func everyGoldenDisplaysAsTheManifestSays(_ file: String) throws {
        let entry = try #require(GoldenTests.manifest.fixtures.first { $0.file == file })
        let d = try Self.display(for: entry)
        let want = entry.expect
        #expect(d.document.rawValue == want.display, "\(file): document")
        #expect(d.agents.count == want.agents.count, "\(file): agents")
        for (a, w) in zip(d.agents, want.agents) {
            #expect(a.state.rawValue == w.state && a.reason?.rawValue == w.reason, "\(file): \(w.agent)")
            #expect(a.pending == w.pending && a.calibrated == w.calibrated, "\(file): \(w.agent) flags")
            #expect(a.isCurrent == (w.display != "stale"), "\(file): \(w.agent) current")
            #expect(!a.stateText.isEmpty)
        }
        if want.display == "mismatch" || want.display == "refused" {
            #expect(d.agents.isEmpty && !d.scanFailed && !d.demo, "\(file): nothing from the document is shown")
        } else {
            #expect(d.scanFailed == want.scanFailed && d.demo == want.demo && d.lead.rawValue == want.lead, "\(file)")
        }
        if let side = want.firstEventSide { #expect(d.primary?.events.first?.side.rawValue == side, "\(file)") }
    }

    /// The display model and the store's glyph resolution never disagree.
    @Test(arguments: GoldenTests.manifest.fixtures.filter { $0.contract == "glance" }.map(\.file))
    func glyphMatchesTheStoreResolution(_ file: String) throws {
        let entry = try #require(GoldenTests.manifest.fixtures.first { $0.file == file })
        let now = try #require(ContractDate.parse(entry.now))
        let (status, glance) = ContractFile.readGlance(try Fixtures.golden(file))
        let freshness = Freshness.evaluate(generatedAt: glance?.generatedAt, now: now,
                                           staleAfter: TimeInterval(glance?.staleAfterSec ?? 7200))
        let d = GlanceDisplay.make(status: status, glance: glance, now: now)
        #expect(d.glyph == MenuBarGlyph.resolve(status: status, glance: glance, freshness: freshness), "\(file)")
    }

    @Test func staleShowsTheLastKnownStateDimmedNeverAsCurrent() throws {
        let entry = try #require(GoldenTests.manifest.fixtures.first { $0.file == "glance/stale.json" })
        let d = try Self.display(for: entry)
        #expect(d.document == .stale && d.glyph == .stale && d.glyphDimmed && !d.newEventMark)
        #expect(d.primary?.isCurrent == false && d.primary?.state == .you)
        #expect(d.stateText == "Out of date")
        #expect(d.accessibilityLabel.contains("Last known: Your side"))
    }

    @Test func aFailedScanKeepsTheStateAndAddsANotice() throws {
        let entry = try #require(GoldenTests.manifest.fixtures.first { $0.file == "glance/scan-failed.json" })
        let d = try Self.display(for: entry)
        #expect(d.document == .ok && d.glyph == .insufficient && d.glyphDimmed && d.scanFailed)
        #expect(d.accessibilityLabel.hasPrefix("wasitme: Too early to tell"))
        #expect(d.accessibilityLabel.contains("Last scan failed"))
    }

    @Test func mismatchRefusedEmptyAndFileStatesHaveTheirOwnWords() {
        let now = Date(timeIntervalSince1970: 1_791_115_200)
        let cases: [(SourceStatus, Glance?, DocumentDisplay, MenuBarGlyph)] = [
            (.notLoaded, nil, .loading, .loading),
            (.missing, nil, .notSetUp, .notSetUp),
            (.updateNeeded(found: "wasitme.glance/2"), nil, .mismatch, .updateNeeded),
            (.refused("r"), nil, .refused, .refused),
            (.invalid("too large"), nil, .unreadable, .error),
            (.ok, Glance(generatedAt: now, agents: []), .empty, .empty),
        ]
        var labels = Set<String>()
        for (status, glance, doc, glyph) in cases {
            let d = GlanceDisplay.make(status: status, glance: glance, now: now)
            #expect(d.document == doc && d.glyph == glyph, "\(status)")
            #expect(!d.stateText.isEmpty && !AppCopy.detail(doc).isEmpty)
            labels.insert(d.accessibilityLabel)
        }
        #expect(labels.count == cases.count, "every state has its own spoken label")
        let mismatch = GlanceDisplay.make(status: .updateNeeded(found: "x"), glance: nil, now: now)
        #expect(mismatch.accessibilityLabel == "wasitme: Update needed. Run wasitme update")
        // the body says what to do and never repeats its title ("Update needed." then "Update needed: run ...")
        #expect(AppCopy.detail(.mismatch) == "This version can't read the status file's format. Run `wasitme update` in Terminal.")
        for doc in DocumentDisplay.allCases where doc != .ok {
            #expect(!AppCopy.detail(doc).localizedCaseInsensitiveContains(AppCopy.title(doc)), "\(doc): the detail repeats the title")
            // a command is marked once, as a pair of backticks the surfaces draw as code; spoken text has none
            #expect(AppCopy.detail(doc).filter { $0 == "`" }.count % 2 == 0, "\(doc)")
            #expect(!AppCopy.spokenDetail(doc).contains("`"))
        }
        #expect(AppCopy.scanFailed(.permissionDenied) == "Last scan failed (permission denied).", "no 'See Sources.' without a way there")
        let failed = GlanceDisplay(document: .ok, freshness: .fresh(age: 60), agents: [], scanFailed: true, scanError: .timeout,
                                   demo: false, lead: .timeline, generatedAt: now)
        #expect(failed.accessibilityLabel.hasSuffix("Last scan failed (timed out)"))
    }

    /// Every D22 state + stale + mismatch + refused + empty (+ the app's file states) has a VoiceOver label
    /// a screen reader can say: no backticks, no control characters, starts with the product name.
    @Test func everyStateHasASpeakableLabel() throws {
        var seen = Set<MenuBarGlyph>()
        for entry in GoldenTests.manifest.fixtures {
            let d = try Self.display(for: entry)
            seen.insert(d.glyph)
            let label = d.accessibilityLabel
            #expect(label.hasPrefix("wasitme: "), "\(entry.file)")
            #expect(!label.contains("`"), "\(entry.file)")
            #expect(label.unicodeScalars.allSatisfy { $0.value >= 0x20 && !(0x7F...0x9F).contains($0.value) }, "\(entry.file)")
        }
        for g: MenuBarGlyph in [.insufficient, .noDetectableChange, .unclear, .you, .agent, .stale, .updateNeeded, .refused, .empty] {
            #expect(seen.contains(g), "no golden reaches \(g)")
        }
    }

    @Test func newEventMarkOnlyOnACurrentDocument() {
        let now = Date(timeIntervalSince1970: 1_791_115_200)
        let ev = GlanceEvent(day: "2026-10-01", kind: "served-model", side: .agent, strength: .strong, label: "x", isNew: true)
        let g = Glance(generatedAt: now, agents: [AgentGlance(agent: .claudeCode, state: .agent, events: [ev])])
        #expect(GlanceDisplay.make(status: .ok, glance: g, now: now).newEventMark)
        #expect(!GlanceDisplay.make(status: .ok, glance: g, now: now.addingTimeInterval(9_000)).newEventMark)
        #expect(GlanceDisplay.make(status: .ok, glance: g, now: now).accessibilityLabel.contains("1 new change on the timeline"))
        #expect(GlanceDisplay.make(status: .ok, glance: g, now: now).newEventCount == 1)
        #expect(GlanceDisplay.make(status: .ok, glance: g, now: now.addingTimeInterval(9_000)).newEventCount == 0)
    }

    @Test func footerSaysWhenAndThatItIsLocal() throws {
        let entry = try #require(GoldenTests.manifest.fixtures.first { $0.file == "glance/you-verdict.json" })
        let d = try Self.display(for: entry)
        #expect(d.footer == "Updated 30 min ago, local only")
        #expect(GlanceDisplay.make(status: .missing, glance: nil, now: Date()).footer == "local only")
    }

    /// App-owned words obey the copy lint (DESIGN.md §3).
    @Test func appCopyPassesTheCopyLint() throws {
        var strings = DocumentDisplay.allCases.flatMap { [AppCopy.title($0), AppCopy.detail($0)] }
        strings += VerdictState.allCases.map { AppCopy.stateLabel($0, reason: nil) }
        strings += [AppCopy.pendingNote, AppCopy.demoRibbon, AppCopy.scanFailed(.timeout), AppCopy.staleReason(.unknown)]
        let banned = try Regex(#"(?i)\bquality\b|\bscore\b|dumber|smarter|nerf|\bproves?\b|caused by|nothing changed on your side|\blooks? like\b|99%|^no change$"#)
        for s in strings { #expect(s.firstMatch(of: banned) == nil, "\(s)") }
    }
}

@Suite struct TextSanitizerTests {
    @Test func stripsEscapeSequencesWhole() {
        #expect(TextSanitizer.clean("\u{1B}[31mred\u{1B}[0m", maxCharacters: 80) == "red")
        #expect(TextSanitizer.clean("a\u{1B}]8;;https://x.invalid/\u{1B}\\link\u{1B}]8;;\u{1B}\\b", maxCharacters: 80) == "alinkb")
        #expect(TextSanitizer.clean("x\u{1B}]0;title\u{07}y", maxCharacters: 80) == "xy")
        #expect(TextSanitizer.clean("\u{9B}2Jz", maxCharacters: 80) == "z")
        #expect(TextSanitizer.clean("trailing\u{1B}", maxCharacters: 80) == "trailing")
    }

    @Test func dropsBidiInvisibleAndControlCharacters() {
        let raw = "a\u{202E}b\u{2066}c\u{200B}d\u{FEFF}e\u{00AD}f\u{0000}g\u{0007}h\u{E000}i\u{E0041}j"
        #expect(TextSanitizer.clean(raw, maxCharacters: 80) == "abcdefghij")
    }

    @Test func breaksAndOddSpacesBecomeOneSpace() {
        #expect(TextSanitizer.clean("  one\r\ntwo\u{2028}three\u{85}four\u{3000}\u{3000}five\t ", maxCharacters: 80)
                == "one two three four five")
    }

    @Test func capsStackedCombiningMarks() {
        let zalgo = "m" + String(repeating: "\u{0301}", count: 30)
        let out = TextSanitizer.clean(zalgo, maxCharacters: 80)
        #expect(out.unicodeScalars.count == 1 + TextSanitizer.maxCombiningMarks)
        #expect(TextSanitizer.clean("café naïve", maxCharacters: 80) == "café naïve")
    }

    @Test func boundsByCharactersWithAnEllipsis() {
        #expect(TextSanitizer.clean(String(repeating: "宽", count: 200), maxCharacters: 160).count == 160)
        #expect(TextSanitizer.clean(String(repeating: "x", count: 30), maxCharacters: 24).hasSuffix("…"))
        #expect(TextSanitizer.clean("short", maxCharacters: 24) == "short")
    }

    /// The hostile golden renders as harmless plain text through the display model.
    @Test func hostileGoldenIsCleanEverywhere() throws {
        let (status, glance) = ContractFile.readGlance(try Fixtures.golden("glance/hostile-labels.json"))
        let d = GlanceDisplay.make(status: status, glance: glance, now: try #require(ContractDate.parse("2026-10-04T18:30:00Z")))
        let a = try #require(d.primary)
        var strings = [a.name, a.stateText, a.headline, a.because, a.tryThis, a.confidence]
        strings += a.events.map(\.label) + a.events.map(\.kind) + a.metrics.map(\.label) + a.metrics.map(\.unit)
        for s in strings {
            for u in s.unicodeScalars {
                #expect(u.value >= 0x20 && !(0x7F...0x9F).contains(u.value), "control U+\(String(u.value, radix: 16)) in \(s)")
                #expect(!(0x202A...0x202E).contains(u.value) && !(0x2066...0x2069).contains(u.value) && !(0x200B...0x200F).contains(u.value))
                #expect(!(0xE000...0xF8FF).contains(u.value))
            }
            #expect(!s.contains("[31m") && !s.contains("]8;;"), "escape residue in \(s)")
        }
        #expect(a.name == "Claude Code", "the hostile id is still recognisable once its escapes are gone")
        #expect(a.stateText.count <= 24 && a.headline.count <= 80 && a.because.count <= 200 && a.confidence.count <= 160)
    }

    /// The other goldens are already clean: sanitizing must not change a single character of them.
    @Test(arguments: GoldenTests.manifest.fixtures.filter { $0.valid && $0.contract == "glance" && !$0.covers.contains("hostile") }.map(\.file))
    func cleanTextPassesThroughUnchanged(_ file: String) throws {
        let g = try ContractDecoder.decodeGlance(Fixtures.golden(file))
        for raw in g.agents {
            let a = AgentDisplay(raw, isCurrent: true)
            #expect(a.headline == raw.headline && a.because == raw.because && a.tryThis == raw.tryThis && a.confidence == raw.confidence, "\(file)")
            #expect(a.events.map(\.label) == raw.events.map(\.label), "\(file)")
            #expect(raw.label.isEmpty || a.stateText == raw.label, "\(file)")
        }
    }
}

/// The unlock counter's display rule (docs/CONTRACT.md#display-rules; the engine's `bindingGate` is the reference): the
/// one pair still short of its target and furthest from it, never a met count against another quantity's target.
@Suite struct UnlockBindingTests {
    let need = GateCounts(events: 40, sessions: 5, sessionDays: 10)

    @Test func thousandsOfEventsButTooFewSessionDaysShowTheSessionDays() {
        // The live defect: 3,150 of 10 is met; 7 of 10 session-days is what keeps the indicator locked.
        let u = Unlock(metric: "readsPerEdit", have: GateCounts(events: 3150, sessions: 7, sessionDays: 7),
                       need: GateCounts(events: 10, sessions: 5, sessionDays: 10))
        #expect(u.binding == GatePair(unit: .sessionDays, have: 7, need: 10))
        #expect(u.fraction == 0.7)
    }

    @Test func theFurthestUnitWinsAndTiesGoToTheEarlierOne() {
        #expect(Unlock(metric: "readsPerEdit", have: GateCounts(events: 31, sessions: 4, sessionDays: 9), need: need).binding
                == GatePair(unit: .events, have: 31, need: 40))
        #expect(Unlock(metric: "readsPerEdit", have: GateCounts(events: 40, sessions: 4, sessionDays: 8), need: need).binding
                == GatePair(unit: .sessions, have: 4, need: 5))
        #expect(Unlock(metric: "readsPerEdit", have: GateCounts(events: 0, sessions: 0, sessionDays: 0), need: need).binding
                == GatePair(unit: .sessions, have: 0, need: 5))
    }

    @Test func noShortPairMeansNoCount() {
        // Only one session dominating: every pair is met, so there is nothing to count.
        #expect(Unlock(metric: "readsPerEdit", have: GateCounts(events: 2100, sessions: 43, sessionDays: 56), need: need).binding == nil)
        #expect(Unlock(metric: "readsPerEdit").binding == nil)
        #expect(Unlock(metric: "x", have: GateCounts(events: 0), need: GateCounts(events: 0)).binding == nil, "a target of 0 is met")
    }

    @Test func aMissingOrNegativeCountIsNeverZeroOfN() throws {
        let json = """
        {"metric":"readsPerEdit","have":{"events":3150,"sessions":"7","sessionDays":7},"need":{"events":10,"sessions":5,"sessionDays":10}}
        """
        let u = try JSONDecoder().decode(Unlock.self, from: Data(json.utf8))
        #expect(u.have.sessions == nil)
        #expect(u.binding == GatePair(unit: .sessionDays, have: 7, need: 10))
        #expect(Unlock(metric: "x", have: GateCounts(sessions: -1), need: need).binding == nil)
    }
}
