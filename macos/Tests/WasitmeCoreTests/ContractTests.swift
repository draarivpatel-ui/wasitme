import Foundation
import Testing
@testable import WasitmeCore

@Suite struct ContractDateTests {
    @Test func parsesPlainZulu() {
        #expect(ContractDate.parse("2026-10-04T12:00:00Z")?.timeIntervalSince1970 == 1_791_115_200)
    }

    /// The reason ContractDate exists: JSONDecoder's .iso8601 rejects fractional seconds.
    @Test func parsesFractionalSecondsFromNode() throws {
        let t = try #require(ContractDate.parse("2026-10-04T12:00:00.123Z"))
        #expect(abs(t.timeIntervalSince1970 - 1_791_115_200.123) < 0.0005)
    }

    @Test func parsesOffsetsWithAndWithoutColon() throws {
        let utc = try #require(ContractDate.parse("2026-10-04T12:00:00Z"))
        #expect(ContractDate.parse("2026-10-04T14:00:00+02:00") == utc)
        #expect(ContractDate.parse("2026-10-04T14:00:00+0200") == utc)
        #expect(ContractDate.parse("2026-10-04T07:30:00-04:30") == utc)
    }

    @Test func handlesLeapDaysAndEpoch() {
        #expect(ContractDate.parse("1970-01-01T00:00:00Z")?.timeIntervalSince1970 == 0)
        #expect(ContractDate.parse("2024-02-29T00:00:00Z") != nil)
        #expect(ContractDate.parse("2026-02-29T00:00:00Z") == nil)
        #expect(ContractDate.parse("2100-02-29T00:00:00Z") == nil)   // 2100 is not a leap year
        #expect(ContractDate.parse("2000-02-29T00:00:00Z") != nil)   // 2000 is
        #expect(ContractDate.parse("2026-04-31T00:00:00Z") == nil)
    }

    @Test(arguments: [
        "", "garbage", "2026-10-04", "2026-10-04T12:00:00",          // no zone
        "2026-10-04 12:00:00Z", "2026-13-01T00:00:00Z", "2026-10-04T24:00:00Z",
        "2026-10-04T12:60:00Z", "2026-10-04T12:00:60Z", "2026-10-04T12:00:00.Z",
        "2026-10-04T12:00:00+25:00", "2026-10-04T12:00:00Zjunk", "2026-1-4T12:00:00Z",
    ])
    func rejectsInvalid(_ raw: String) {
        #expect(ContractDate.parse(raw) == nil)
    }

    @Test func formatParseRoundTripsIncludingPreEpoch() throws {
        for ts in [0.0, 1_791_115_200.5, 951_782_400.001, -86_400.25, 4_102_444_800] {
            let d = Date(timeIntervalSince1970: ts)
            let back = try #require(ContractDate.parse(ContractDate.format(d)))
            #expect(abs(back.timeIntervalSince(d)) < 0.001, "round trip of \(ts)")
        }
        #expect(ContractDate.format(Date(timeIntervalSince1970: 1_791_115_200.5)) == "2026-10-04T12:00:00.500Z")
    }
}

@Suite struct SchemaVersionTests {
    @Test func parsesMajorAndMinor() {
        #expect(SchemaID.parse("wasitme.glance/1") == SchemaID(name: "wasitme.glance", major: 1))
        #expect(SchemaID.parse("wasitme.snapshot/2.7") == SchemaID(name: "wasitme.snapshot", major: 2, minor: 7))
    }

    @Test(arguments: ["", "wasitme.glance", "/1", "wasitme.glance/", "wasitme.glance/x", "wasitme.glance/1.",
                      "wasitme.glance/1.2.3", "wasitme.glance/1/2", "wasitme.glance/-1", "wasitme.glance/1e3"])
    func rejectsMalformed(_ raw: String) {
        #expect(SchemaID.parse(raw) == nil)
    }

    @Test func compatibilityIsDetectable() {
        #expect(SchemaCompatibility.check("wasitme.glance/1", expecting: .glance) == .compatible)
        // D45 / display rule 1: only the exact id matches. Minor ids are reserved and never written.
        #expect(SchemaCompatibility.check("wasitme.glance/1.4", expecting: .glance) == .nonCanonical(found: "wasitme.glance/1.4"))
        #expect(SchemaCompatibility.check("wasitme.glance/1.0", expecting: .glance) == .nonCanonical(found: "wasitme.glance/1.0"))
        #expect(SchemaCompatibility.check("wasitme.glance/01", expecting: .glance) == .nonCanonical(found: "wasitme.glance/01"))
        #expect(SchemaCompatibility.check("wasitme.snapshot/1", expecting: .snapshot) == .compatible)
        #expect(!SchemaCompatibility.check("wasitme.glance/1 ", expecting: .glance).isCompatible)
        #expect(SchemaCompatibility.check("wasitme.glance/2", expecting: .glance) == .newerMajor(found: "wasitme.glance/2"))
        #expect(SchemaCompatibility.check("wasitme.glance/0", expecting: .glance) == .olderMajor(found: "wasitme.glance/0"))
        #expect(SchemaCompatibility.check("wasitme.snapshot/1", expecting: .glance) == .wrongDocument(found: "wasitme.snapshot/1"))
        #expect(SchemaCompatibility.check(nil, expecting: .glance) == .unparseable(found: nil))
        #expect(SchemaCompatibility.check("nonsense", expecting: .glance) == .unparseable(found: "nonsense"))
    }
}

@Suite struct GlanceDecodingTests {
    @Test func decodesFullGlance() throws {
        let g = try ContractDecoder.decodeGlance(Fixtures.data(Fixtures.glanceJSON()))
        #expect(g.schema == "wasitme.glance/1")
        #expect(g.scanOk && g.scanError == nil)
        #expect(g.staleAfterSec == 7200 && g.demo == false && g.lead == .verdict)
        #expect(abs((g.generatedAt?.timeIntervalSince1970 ?? 0) - 1_791_115_200.123) < 0.0005)
        #expect(g.agents.count == 2)
        #expect(g.primary?.agent == .claudeCode)
        let a = try #require(g.agents.first)
        #expect(a.state == .agent && a.reason == nil && a.calibrated && !a.pending)
        #expect(a.label == "Agent side" && a.band == "Agent side: synthetic band line.")
        #expect(a.n == SampleCounts(exchanges: 312, sessions: 9, sessionDays: 40, days: 14))
        #expect(a.topMetrics.first?.recent == KN(k: 30, n: 312))
        #expect(a.topMetrics.first?.range == [1.6, 3.4])
        #expect(a.topMetrics.first?.mde == 2.0)
        #expect(a.topMetrics.first?.status == .worse && a.topMetrics.first?.family == .errors && a.topMetrics.first?.role == .vote)
        #expect(a.events.first?.side == .agent && a.events.first?.strength == .strong && a.events.first?.isNew == true)
        #expect(a.strip?.days.count == 2)
        #expect(a.strip?.days.last?.rate == nil)          // a day with no opportunities has no rate
        #expect(a.strip?.window.lo == 1.6)
        let c = try #require(g.agents.last)
        #expect(c.state == .insufficient && c.reason == .calibrationPending && !c.calibrated)
        #expect(c.progress?.tier == 1 && c.progress?.unlock.first?.fraction == 0.3)
    }

    @Test func ignoresUnknownFieldsAtEveryLevel() throws {
        var json = Fixtures.glanceJSON(extraTopLevel: ", \"futureField\": {\"a\": [1,2,3]}")
        json = json.replacingOccurrences(of: "\"headline\": \"Synthetic headline.\",",
                                         with: "\"headline\": \"Synthetic headline.\", \"newThing\": 42,")
        let g = try ContractDecoder.decodeGlance(Fixtures.data(json))
        #expect(g.agents.first?.headline == "Synthetic headline.")
    }

    @Test func unknownStateRendersAsUnclear() throws {
        let g = try ContractDecoder.decodeGlance(Fixtures.data(Fixtures.glanceJSON(state: "vendor_side_v2")))
        #expect(g.agents.first?.state == .unclear)
    }

    @Test(arguments: ["your_side", "no_change"])
    func preFreezeStateNamesAreNotSilentlyMapped(_ old: String) throws {
        let g = try ContractDecoder.decodeGlance(Fixtures.data(Fixtures.glanceJSON(state: old)))
        #expect(g.agents.first?.state == .unclear)
    }

    @Test func d22RawValuesAreExactlyTheContractVocabulary() {
        #expect(VerdictState.allCases.map(\.rawValue).sorted() == ["agent", "insufficient", "none", "unclear", "you"])
        #expect(ChangeSide.allCases.map(\.rawValue).sorted() == ["agent", "meta", "unknown", "you"])
        #expect(VerdictReason.allCases.count == 10)
    }

    @Test func missingOrWrongTypedStateIsUnclear() throws {
        let json = """
        {"schema":"wasitme.glance/1","privacy":{"containsText":false},"agents":[{"agent":"codex"},{"agent":"claude-code","state":7}]}
        """
        let g = try ContractDecoder.decodeGlance(Fixtures.data(json))
        #expect(g.agents.map(\.state) == [.unclear, .unclear])
        #expect(g.agents.allSatisfy { !$0.calibrated && !$0.pending && $0.reason == nil })   // no claim
    }

    @Test func unknownEnumsBecomeNilNotErrorsAndUnknownSidesAreNeverAgent() throws {
        let json = """
        {"schema":"wasitme.glance/1","privacy":{"containsText":false},"lead":"sideways","scanOk":false,"scanError":"kaboom",
         "agents":[{"agent":"codex","state":"none","reason":"aliens",
         "topMetrics":[{"id":"m","label":"M","recent":{"k":1,"n":2},"baseline":{"k":2,"n":4},"status":"melting","family":"vibes"}],
         "events":[{"day":"2026-10-01","kind":"k","side":"aliens","strength":"mega","label":"L"},
                   {"day":"2026-10-02","kind":"k","side":"unclear","label":"pre-freeze side name"}]}]}
        """
        let g = try ContractDecoder.decodeGlance(Fixtures.data(json))
        let a = try #require(g.agents.first)
        #expect(a.state == .noDetectableChange)
        #expect(a.reason == nil)
        #expect(a.topMetrics.first?.status == nil && a.topMetrics.first?.family == nil)
        #expect(a.events.map(\.side) == [.unknown, .unknown])
        #expect(a.events.first?.strength == nil)
        #expect(g.lead == .timeline)
        #expect(g.scanError == .internal)
    }

    @Test func unknownAgentIdsStillDecode() throws {
        let json = #"{"schema":"wasitme.glance/1","privacy":{"containsText":false},"agents":[{"agent":"opencode","state":"none"}]}"#
        let g = try ContractDecoder.decodeGlance(Fixtures.data(json))
        #expect(g.primary?.agent.rawValue == "opencode")
        #expect(g.primary?.agent.displayName == "opencode")
    }

    @Test func oneBadAgentEntryDoesNotSinkTheRest() throws {
        let json = """
        {"schema":"wasitme.glance/1","privacy":{"containsText":false},"agents":[{"state":"agent"},"junk",null,{"agent":"codex","state":"none","headline":"ok"}]}
        """
        let g = try ContractDecoder.decodeGlance(Fixtures.data(json))
        #expect(g.agents.map(\.agent) == [.codex])
    }

    @Test func wronglyTypedFieldsDegradeToNilAndDefaults() throws {
        let json = """
        {"schema":"wasitme.glance/1","privacy":{"containsText":false},"generatedAt":12345,"scanOk":"yes","agents":"not-an-array","engine":7,"staleAfterSec":5}
        """
        let g = try ContractDecoder.decodeGlance(Fixtures.data(json))
        #expect(g.generatedAt == nil)
        #expect(g.scanOk == false)       // no claim of health
        #expect(g.agents.isEmpty)
        #expect(g.engine == nil)
        #expect(g.staleAfterSec == 7200) // out of the contract's range: the default
    }

    @Test func metricsNeedBothWindowsAndAnOrderedRange() throws {
        let json = """
        {"schema":"wasitme.glance/1","privacy":{"containsText":false},"agents":[{"agent":"codex","state":"agent","topMetrics":[
          {"id":"a","label":"A","recent":{"k":1,"n":2},"baseline":{"k":2,"n":4},"range":[1]},
          {"id":"b","label":"B","recent":{"k":1,"n":2}},
          {"id":"c","label":"C","recent":{"k":1,"n":2},"baseline":{"k":2,"n":4},"range":[3,1]}]}]}
        """
        let m = try #require(try ContractDecoder.decodeGlance(Fixtures.data(json)).agents.first).topMetrics
        #expect(m.map(\.id) == ["a", "c"])  // "b" lacks its baseline counts: dropped
        #expect(m.allSatisfy { $0.range == nil })   // a range that is not two ordered numbers is not trusted
    }

    @Test func progressNeverShowsADayCountWhenNotAtCurrentPaceAndNeverForInterrupts() throws {
        let json = """
        {"schema":"wasitme.glance/1","privacy":{"containsText":false},"agents":[{"agent":"codex","state":"insufficient",
          "progress":{"tier":2,"etaDate":"2026-12-01","notAtCurrentPace":true,"unlock":[
            {"metric":"interrupts","have":{"sessions":1},"need":{"sessions":5}},
            {"metric":"blindEdits","have":{"sessionDays":2},"need":{"sessionDays":10}}]}}]}
        """
        let p = try #require(try ContractDecoder.decodeGlance(Fixtures.data(json)).agents.first?.progress)
        #expect(p.etaDate == nil)
        #expect(p.unlock.map(\.metric) == ["blindEdits"])
    }

    @Test func primaryIsTheFirstAgentInEngineOrder() throws {
        let json = #"{"schema":"wasitme.glance/1","privacy":{"containsText":false},"primaryAgent":"claude-code","agents":[{"agent":"codex"},{"agent":"claude-code"}]}"#
        #expect(try ContractDecoder.decodeGlance(Fixtures.data(json)).primary?.agent == .codex)
        #expect(Glance(agents: []).primary == nil)
    }

    @Test func roundTripsThroughOwnEncoder() throws {
        let original = try ContractDecoder.decodeGlance(Fixtures.data(Fixtures.glanceJSON()))
        let data = try ContractDecoder.makeEncoder().encode(original)
        let again = try ContractDecoder.decodeGlance(data)
        #expect(again.agents == original.agents)
        #expect(again.staleAfterSec == original.staleAfterSec && again.lead == original.lead)
        let t0 = try #require(original.generatedAt), t1 = try #require(again.generatedAt)
        #expect(abs(t0.timeIntervalSince(t1)) < 0.001)
    }
}

@Suite struct SchemaMismatchTests {
    @Test func newerMajorIsDetectedBeforeDecoding() {
        // A v2 document may have a completely different shape; we must not try to read it.
        let data = Fixtures.data(#"{"schema":"wasitme.glance/2","agents":{"totally":"different"}}"#)
        #expect(throws: ContractError.schemaMismatch(.newerMajor(found: "wasitme.glance/2"))) {
            try ContractDecoder.decodeGlance(data)
        }
    }

    @Test func snapshotInGlanceFileIsWrongDocument() {
        let data = Fixtures.data(Fixtures.snapshotJSON)
        #expect(throws: ContractError.schemaMismatch(.wrongDocument(found: "wasitme.snapshot/1"))) {
            try ContractDecoder.decodeGlance(data)
        }
    }

    @Test func missingSchemaIsUnparseable() {
        #expect(throws: ContractError.schemaMismatch(.unparseable(found: nil))) {
            try ContractDecoder.decodeGlance(Fixtures.data(#"{"agents":[]}"#))
        }
        #expect(throws: ContractError.schemaMismatch(.unparseable(found: nil))) {
            try ContractDecoder.decodeGlance(Fixtures.data(#"{"schema":5}"#))
        }
    }

    @Test(arguments: ["", "not json", "[1,2]", "42", "\"str\"", "{\"schema\":", "null"])
    func nonObjectsAreRejected(_ raw: String) {
        #expect(throws: ContractError.notAnObject) {
            try ContractDecoder.decodeGlance(Fixtures.data(raw))
        }
    }

    @Test func documentDeclaringTextIsRefused() {
        let json = #"{"schema":"wasitme.glance/1","agents":[],"privacy":{"containsText":true}}"#
        #expect(throws: ContractError.declaresText) { try ContractDecoder.decodeGlance(Fixtures.data(json)) }
    }

    /// The privacy gate fails closed: both schemas require `privacy.containsText: false`, so a document
    /// that omits the block, omits the field or gives it the wrong type is refused, not trusted.
    @Test(arguments: [
        #"{"schema":"wasitme.glance/1","agents":[]}"#,
        #"{"schema":"wasitme.glance/1","agents":[],"privacy":null}"#,
        #"{"schema":"wasitme.glance/1","agents":[],"privacy":{}}"#,
        #"{"schema":"wasitme.glance/1","agents":[],"privacy":"none"}"#,
        #"{"schema":"wasitme.glance/1","agents":[],"privacy":{"containsText":"true"}}"#,
        #"{"schema":"wasitme.glance/1","agents":[],"privacy":{"containsText":"false"}}"#,
        #"{"schema":"wasitme.glance/1","agents":[],"privacy":{"containsText":0}}"#,
        #"{"schema":"wasitme.glance/1","agents":[],"privacy":{"containsText":null}}"#,
        #"{"schema":"wasitme.glance/1","agents":[],"privacy":{"contains_text":false}}"#,
    ])
    func glanceWithoutAnExplicitTextFreeDeclarationIsRefused(_ json: String) {
        #expect(throws: ContractError.privacyUndeclared) { try ContractDecoder.decodeGlance(Fixtures.data(json)) }
    }

    @Test func glanceExplicitlyDeclaringTextFreeIsAccepted() throws {
        let json = #"{"schema":"wasitme.glance/1","agents":[],"privacy":{"containsText":false,"extra":1}}"#
        #expect(try ContractDecoder.decodeGlance(Fixtures.data(json)).privacy == PrivacyDeclaration(containsText: false))
    }

    /// D45: minor ids are reserved and never written; every consumer treats them as a mismatch (fail closed).
    @Test(arguments: ["wasitme.glance/1.9", "wasitme.glance/1.0", "wasitme.glance/01"])
    func minorAndNonCanonicalIdsAreAMismatch(_ schema: String) {
        #expect(throws: ContractError.schemaMismatch(.nonCanonical(found: schema))) {
            try ContractDecoder.decodeGlance(Fixtures.data(Fixtures.glanceJSON(schema: schema)))
        }
    }
}

@Suite struct SnapshotDecodingTests {
    @Test func decodesTheSharedSnapshotGolden() throws {
        let s = try ContractDecoder.decodeSnapshot(Fixtures.data(Fixtures.snapshotJSON))
        #expect(s.scanOk && s.scanError == nil && s.staleAfterSec == 7200 && s.lead == .verdict)
        #expect(s.health.sources.count == 2)
        #expect(s.health.sources[0].unknownTypes == ["relocated": 2])
        #expect(s.health.sources[1].unknownTypes == ["codex:event_msg:future_event_kind": 1])
        #expect(s.health.parserVersions["toolErrors"] == 1 && s.health.sandbox == true)
        #expect(s.calibration.agents.map(\.calibrated) == [true, false])
        #expect(s.calibration.methodId == "session-day-t99-cr2")

        let r = try #require(s.report(for: .claudeCode))
        #expect(r.state == .you && r.summary.reason == nil && r.summary.calibrated)
        #expect(r.summary.topMetrics.count == 3)
        #expect(r.tier == 1)
        #expect(r.windows?.recent.sessions == 9)
        #expect(r.windows?.baseline.days == 28)
        #expect(r.metrics.count == 7)
        #expect(r.metrics[0].base.id == "toolErrors" && r.metrics[0].eligible && r.metrics[0].shifted)
        #expect(r.metrics[0].series.count == 28)
        #expect(r.metrics[0].standardized?.ratio != nil)
        #expect(r.metrics.contains { $0.id == "churn" && $0.base.family == nil })
        #expect(r.onset == Onset(from: "2026-09-19", to: "2026-09-23"))
        #expect(r.timeline.count == 6)
        #expect(r.timeline.first?.provenance == .logField && r.timeline.contains { $0.provenance == .command })
        #expect(r.candidates.contains { $0.status == .open })
        #expect(r.candidates.contains { $0.status == .background && $0.test == .routine })
        #expect(r.confounders.map(\.id).contains("project_mix"))
        #expect(r.observation.fullyObservedDays == 14 && !r.observation.note.isEmpty)
        #expect(r.setup["mcpServers"] == .number(6))
        #expect(r.setup["model"] == .string("opus-5-5"))
        #expect(r.trace.last?.matched == true && r.trace.last?.row == 7)
        #expect(r.disclaimer == "These indicators don't measure answer quality. Evidence, not proof.")

        let cx = try #require(s.report(for: .codex))
        #expect(cx.state == .insufficient && cx.summary.reason == .calibrationPending && !cx.summary.calibrated)
        #expect(cx.metrics.isEmpty && cx.windows == nil && cx.tier == nil)
        #expect(cx.trace.map(\.row) == [1])
        #expect(cx.disclaimer == nil)
    }

    @Test func unknownVerdictStateAndRoleAreSafe() throws {
        let json = """
        {"schema":"wasitme.snapshot/1","privacy":{"containsText":false},"agents":[{"agent":"codex","state":"quantum","headline":"h",
          "metrics":[{"id":"m","label":"M","role":"oracle","recent":{"k":1,"n":2},"baseline":{"k":1,"n":2},"eligible":true}],
          "timeline":[{"id":"e1","day":"2026-10-01","kind":"model","side":"unclear"}]}]}
        """
        let r = try #require(try ContractDecoder.decodeSnapshot(Fixtures.data(json)).agents.first)
        #expect(r.state == .unclear)
        #expect(r.metrics.first?.base.role == .context)    // unknown metrics must not vote
        #expect(r.timeline.first?.side == .unknown)        // never .agent
    }

    @Test func snapshotDeclaringTextIsRefused() {
        let json = Fixtures.snapshotJSON.replacingOccurrences(
            of: #""containsText": false"#, with: #""containsText": true"#)
        #expect(json != Fixtures.snapshotJSON, "fixture no longer contains the privacy block this test edits")
        #expect(throws: ContractError.declaresText) { try ContractDecoder.decodeSnapshot(Fixtures.data(json)) }
    }

    @Test func snapshotWithoutAnExplicitTextFreeDeclarationIsRefused() {
        let json = Fixtures.snapshotJSON.replacingOccurrences(of: #""containsText": false"#, with: #""x": 1"#)
        #expect(json != Fixtures.snapshotJSON, "fixture no longer contains the privacy field")
        #expect(throws: ContractError.privacyUndeclared) { try ContractDecoder.decodeSnapshot(Fixtures.data(json)) }
    }

    @Test func snapshotSchemaMismatchIsDetectable() {
        let json = Fixtures.snapshotJSON.replacingOccurrences(of: "wasitme.snapshot/1", with: "wasitme.snapshot/3")
        #expect(throws: ContractError.schemaMismatch(.newerMajor(found: "wasitme.snapshot/3"))) {
            try ContractDecoder.decodeSnapshot(Fixtures.data(json))
        }
    }

    @Test func roundTripsThroughOwnEncoder() throws {
        let original = try ContractDecoder.decodeSnapshot(Fixtures.data(Fixtures.snapshotJSON))
        let again = try ContractDecoder.decodeSnapshot(ContractDecoder.makeEncoder().encode(original))
        #expect(again.agents == original.agents)
        #expect(again.health == original.health)
        #expect(again.calibration == original.calibration)
    }
}
