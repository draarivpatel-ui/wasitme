import Foundation
import Testing
@testable import WasitmeCore

/// The shared contract goldens (`contract/fixtures/`): every file decodes the way `manifest.json` says
/// (docs/CONTRACT.md#display-rules), and tolerant decoding keeps every item a valid golden carries.
@Suite struct GoldenTests {
    struct Manifest: Decodable {
        struct Agent: Decodable {
            let agent: String
            let state: String
            let reason: String?
            let pending: Bool
            let calibrated: Bool
            let display: String
        }
        struct Expect: Decodable {
            let display: String
            let scanFailed: Bool
            let lead: String
            let demo: Bool
            let agents: [Agent]
            let firstEventSide: String?
        }
        struct Entry: Decodable {
            let file: String
            let contract: String
            let valid: Bool
            let now: String
            let covers: [String]
            let expect: Expect
        }
        let defaultStaleAfterSec: Int
        let futureToleranceSec: Int
        let fixtures: [Entry]
    }

    static let manifest: Manifest = {
        let data = (try? Fixtures.golden("manifest.json")) ?? Data()
        return (try? JSONDecoder().decode(Manifest.self, from: data))
            ?? Manifest(defaultStaleAfterSec: 0, futureToleranceSec: 0, fixtures: [])
    }()

    struct Decoded: Equatable {
        var display: String
        var scanFailed = false
        var lead = "timeline"
        var demo = false
        var agents: [Manifest.Agent] = []
        var firstEventSide: String?

        static func == (a: Decoded, b: Decoded) -> Bool { a.display == b.display }
    }

    /// The app's own decode + freshness, mapped onto the contract's display words.
    static func decode(_ entry: Manifest.Entry) throws -> (Decoded, Glance?, Snapshot?) {
        let data = try Fixtures.golden(entry.file)
        let now = try #require(ContractDate.parse(entry.now))
        func refusal(_ error: Error) -> Decoded {
            switch error as? ContractError {
            case .schemaMismatch?, .notAnObject?: return Decoded(display: "mismatch")
            default: return Decoded(display: "refused")
            }
        }
        var glance: Glance?
        var snapshot: Snapshot?
        let head: (generatedAt: Date?, staleAfterSec: Int, scanOk: Bool, lead: Lead, demo: Bool, agents: [AgentGlance])
        do {
            if entry.contract == "glance" {
                let g = try ContractDecoder.decodeGlance(data)
                glance = g
                head = (g.generatedAt, g.staleAfterSec, g.scanOk, g.lead, g.demo, g.agents)
            } else {
                let s = try ContractDecoder.decodeSnapshot(data)
                snapshot = s
                head = (s.generatedAt, s.staleAfterSec, s.scanOk, s.lead, s.demo, s.agents.map(\.summary))
            }
        } catch {
            return (refusal(error), nil, nil)
        }
        let fresh = Freshness.evaluate(generatedAt: head.generatedAt, now: now, staleAfter: TimeInterval(head.staleAfterSec)).isFresh
        let display = !fresh ? "stale" : head.agents.isEmpty ? "empty" : "ok"
        let agents = head.agents.map {
            Manifest.Agent(agent: $0.agent.rawValue, state: $0.state.rawValue, reason: $0.reason?.rawValue,
                           pending: $0.pending, calibrated: $0.calibrated, display: fresh ? $0.state.rawValue : "stale")
        }
        let decoded = Decoded(display: display, scanFailed: !head.scanOk, lead: head.lead.rawValue, demo: head.demo,
                              agents: agents, firstEventSide: head.agents.first?.events.first?.side.rawValue)
        return (decoded, glance, snapshot)
    }

    @Test func theManifestIsThereAndCoversTheContract() {
        let m = Self.manifest
        #expect(m.fixtures.count >= 30, "contract/fixtures/manifest.json not found or empty")
        #expect(m.defaultStaleAfterSec == Glance.defaultStaleAfterSec)
        #expect(TimeInterval(m.futureToleranceSec) == Freshness.defaultFutureTolerance)
        let covers = Set(m.fixtures.flatMap(\.covers))
        for state in VerdictState.allCases { #expect(covers.contains("state:\(state.rawValue)"), "state \(state.rawValue)") }
        for reason in VerdictReason.allCases { #expect(covers.contains("reason:\(reason.rawValue)"), "reason \(reason.rawValue)") }
        for c in ["stale", "pending", "calibration_pending", "mismatch", "empty", "demo", "hostile", "unknown-state", "refused"] {
            #expect(covers.contains(c), "\(c)")
        }
    }

    @Test(arguments: GoldenTests.manifest.fixtures.map(\.file))
    func decodesAsTheManifestSays(_ file: String) throws {
        let entry = try #require(Self.manifest.fixtures.first { $0.file == file })
        let (got, _, _) = try Self.decode(entry)
        let want = entry.expect
        #expect(got.display == want.display, "\(file): display")
        guard want.display == "ok" || want.display == "stale" || want.display == "empty" else { return }
        #expect(got.scanFailed == want.scanFailed, "\(file): scanFailed")
        #expect(got.lead == want.lead, "\(file): lead")
        #expect(got.demo == want.demo, "\(file): demo")
        #expect(got.agents.count == want.agents.count, "\(file): agent count")
        for (g, w) in zip(got.agents, want.agents) {
            #expect(g.agent == w.agent, "\(file): agent id (the app keeps raw ids; views sanitize)")
            #expect(g.state == w.state, "\(file): \(w.agent) state")
            #expect(g.reason == w.reason, "\(file): \(w.agent) reason")
            #expect(g.pending == w.pending && g.calibrated == w.calibrated, "\(file): \(w.agent) pending/calibrated")
            #expect(g.display == w.display, "\(file): \(w.agent) display")
        }
        if let side = want.firstEventSide { #expect(got.firstEventSide == side, "\(file): first event side") }
    }

    /// Tolerant decoding must not "pass" by dropping things: every valid golden keeps every agent, metric,
    /// event, strip day, timeline entry and candidate it carries.
    @Test(arguments: GoldenTests.manifest.fixtures.filter(\.valid).map(\.file))
    func validGoldensLoseNothing(_ file: String) throws {
        let entry = try #require(Self.manifest.fixtures.first { $0.file == file })
        let raw = try #require(try JSONSerialization.jsonObject(with: Fixtures.golden(file)) as? [String: Any])
        let rawAgents = try #require(raw["agents"] as? [[String: Any]])
        let (_, glance, snapshot) = try Self.decode(entry)
        let summaries = glance?.agents ?? snapshot?.agents.map(\.summary) ?? []
        #expect(summaries.count == rawAgents.count, "\(file): agents")
        for (a, r) in zip(summaries, rawAgents) {
            #expect(a.topMetrics.count == (r["topMetrics"] as? [Any])?.count, "\(file): topMetrics")
            #expect(a.events.count == (r["events"] as? [Any])?.count, "\(file): events")
            #expect(a.strip?.days.count == ((r["strip"] as? [String: Any])?["days"] as? [Any])?.count, "\(file): strip days")
            #expect((a.progress?.unlock.count ?? 0) == (((r["progress"] as? [String: Any])?["unlock"] as? [Any])?.count ?? 0), "\(file): unlock")
            #expect(a.label == r["label"] as? String && a.headline == r["headline"] as? String, "\(file): words")
        }
        if let snapshot {
            for (a, r) in zip(snapshot.agents, rawAgents) {
                #expect(a.metrics.count == (r["metrics"] as? [Any])?.count, "\(file): metrics")
                #expect(a.timeline.count == (r["timeline"] as? [Any])?.count, "\(file): timeline")
                #expect(a.candidates.count == (r["candidates"] as? [Any])?.count, "\(file): candidates")
                #expect(a.trace.count == (r["trace"] as? [Any])?.count, "\(file): trace")
                #expect(a.setup.count == (r["setup"] as? [String: Any])?.count, "\(file): setup")
            }
            let health = try #require(raw["health"] as? [String: Any])
            #expect(snapshot.health.sources.count == (health["sources"] as? [Any])?.count, "\(file): sources")
        }
    }

    @Test func spotChecksOfGoldenContent() throws {
        let you = try ContractDecoder.decodeGlance(Fixtures.golden("glance/you-verdict.json"))
        let a = try #require(you.agents.first)
        #expect(a.topMetrics.count == 3 && a.events.count == 5 && a.strip?.days.count == 28)
        #expect(a.state == .you && a.label == "Your side" && !a.band.isEmpty)

        let two = try ContractDecoder.decodeGlance(Fixtures.golden("glance/calibration_pending.json"))
        #expect(two.agents.map(\.agent) == [.claudeCode, .codex])
        #expect(two.agents[1].reason == .calibrationPending && two.agents[1].label == "Timeline only" && two.agents[1].strip == nil)

        let hostile = try ContractDecoder.decodeGlance(Fixtures.golden("glance/hostile-labels.json"))
        #expect(hostile.agents.first?.agent.rawValue.contains("\u{1B}") == true, "the app keeps raw text; views must sanitize")
        #expect(hostile.agents.first?.label.count == 24)
    }

    @Test func menuBarGlyphFollowsTheManifestForEveryGlanceGolden() throws {
        for entry in Self.manifest.fixtures where entry.contract == "glance" {
            let (decoded, glance, _) = try Self.decode(entry)
            let now = try #require(ContractDate.parse(entry.now))
            // The store's own classification of the bytes (the same path `--capture` uses).
            let (status, _) = ContractFile.readGlance(try Fixtures.golden(entry.file))
            switch decoded.display {
            case "mismatch": guard case .updateNeeded = status else { Issue.record("\(entry.file): \(status)"); continue }
            case "refused": guard case .refused = status else { Issue.record("\(entry.file): \(status)"); continue }
            default: #expect(status == .ok, "\(entry.file)")
            }
            let freshness = Freshness.evaluate(generatedAt: glance?.generatedAt, now: now,
                                               staleAfter: TimeInterval(glance?.staleAfterSec ?? 7200))
            let glyph = MenuBarGlyph.resolve(status: status, glance: glance, freshness: freshness)
            // Display rules, first match wins; `scanOk: false` never changes the glyph (it is drawn dimmed).
            let expected: MenuBarGlyph
            switch (decoded.display, entry.expect.agents.first?.state) {
            case ("mismatch", _): expected = .updateNeeded
            case ("refused", _): expected = .refused
            case ("stale", _): expected = .stale
            case ("empty", _): expected = .empty
            case (_, "insufficient"?): expected = .insufficient
            case (_, "none"?): expected = .noDetectableChange
            case (_, "you"?): expected = .you
            case (_, "agent"?): expected = .agent
            default: expected = .unclear
            }
            #expect(glyph == expected, "\(entry.file): glyph \(glyph), expected \(expected)")
        }
    }
}
