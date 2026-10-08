import Foundation
import Testing
@testable import WasitmeCore

@Suite struct FreshnessTests {
    let now = Date(timeIntervalSince1970: 1_791_115_200)

    @Test func freshWithinTwoHours() {
        let f = Freshness.evaluate(generatedAt: now.addingTimeInterval(-60), now: now)
        #expect(f == .fresh(age: 60))
        #expect(f.isFresh)
    }

    @Test func staleOnlyBeyondTwoHours() {
        #expect(Freshness.evaluate(generatedAt: now.addingTimeInterval(-7200), now: now) == .fresh(age: 7200))
        #expect(Freshness.evaluate(generatedAt: now.addingTimeInterval(-7201), now: now) == .stale(age: 7201))
        #expect(!Freshness.evaluate(generatedAt: now.addingTimeInterval(-7201), now: now).isFresh)
    }

    @Test func clockSkewWithinToleranceIsFreshWithZeroAge() {
        // Engine's clock a minute ahead of ours: never a negative age.
        let f = Freshness.evaluate(generatedAt: now.addingTimeInterval(60), now: now)
        #expect(f == .fresh(age: 0))
    }

    @Test func farFutureTimestampIsNotTrustedAsFresh() {
        // User set the clock back a day after the engine wrote the file.
        let f = Freshness.evaluate(generatedAt: now.addingTimeInterval(86_400), now: now)
        #expect(f == .futureDated(by: 86_400))
        #expect(!f.isFresh)
    }

    @Test func missingTimestampIsUnknown() {
        #expect(Freshness.evaluate(generatedAt: nil, now: now) == .unknown)
    }

    @Test func nonFiniteIsUnknown() {
        #expect(Freshness.evaluate(generatedAt: Date(timeIntervalSince1970: .infinity), now: now) == .unknown)
    }

    @Test func customThresholds() {
        let f = Freshness.evaluate(generatedAt: now.addingTimeInterval(-30), now: now, staleAfter: 10)
        #expect(f == .stale(age: 30))
    }
}

@Suite struct GlyphTests {
    private func glance(state: VerdictState = .agent, scanOk: Bool = true, agents: [AgentGlance]? = nil) -> Glance {
        Glance(scanOk: scanOk, agents: agents ?? [AgentGlance(agent: .claudeCode, state: state, headline: "h")])
    }
    private let fresh = Freshness.fresh(age: 5)

    @Test func verdictStatesMapOneToOne() {
        let expected: [(VerdictState, MenuBarGlyph)] = [
            (.insufficient, .insufficient), (.noDetectableChange, .noDetectableChange), (.you, .you),
            (.agent, .agent), (.unclear, .unclear),
        ]
        for (state, glyph) in expected {
            #expect(MenuBarGlyph.resolve(status: .ok, glance: glance(state: state), freshness: fresh) == glyph)
        }
    }

    @Test func problemsOutrankTheVerdict() {
        let g = glance(state: .noDetectableChange)
        #expect(MenuBarGlyph.resolve(status: .notLoaded, glance: nil, freshness: .unknown) == .loading)
        #expect(MenuBarGlyph.resolve(status: .missing, glance: nil, freshness: .unknown) == .notSetUp)
        #expect(MenuBarGlyph.resolve(status: .updateNeeded(found: "x/2"), glance: nil, freshness: .unknown) == .updateNeeded)
        #expect(MenuBarGlyph.resolve(status: .refused("r"), glance: nil, freshness: .unknown) == .refused)
        #expect(MenuBarGlyph.resolve(status: .invalid("bad"), glance: g, freshness: fresh) == .error)   // even with a last-good glance
    }

    /// `scanOk: false` is orthogonal (contract display rules): the state glyph stays, drawn dimmed, with a notice.
    @Test func aFailedScanKeepsTheStateGlyph() {
        #expect(MenuBarGlyph.resolve(status: .ok, glance: glance(state: .noDetectableChange, scanOk: false), freshness: fresh) == .noDetectableChange)
        #expect(MenuBarGlyph.resolve(status: .ok, glance: glance(state: .you, scanOk: false), freshness: .stale(age: 9_000)) == .stale)
    }

    @Test func staleFutureAndUnknownAgeAllShowStale() {
        let g = glance(state: .noDetectableChange)
        for f in [Freshness.stale(age: 99_999), .futureDated(by: 99_999), .unknown] {
            #expect(MenuBarGlyph.resolve(status: .ok, glance: g, freshness: f) == .stale)
        }
    }

    /// Display rule 4: no agents is `empty` (nothing was judged), not `unclear`; stale still wins (rule 3 first).
    @Test func noAgentsIsEmptyNotACrash() {
        #expect(MenuBarGlyph.resolve(status: .ok, glance: glance(agents: []), freshness: fresh) == .empty)
        #expect(MenuBarGlyph.resolve(status: .ok, glance: glance(agents: []), freshness: .unknown) == .stale)
    }

    /// There is no `primaryAgent` in the frozen contract: the engine orders agents, the glyph speaks for the first.
    @Test func firstAgentDecidesTheGlyph() {
        let g = Glance(agents: [
            AgentGlance(agent: .codex, state: .you, headline: ""),
            AgentGlance(agent: .claudeCode, state: .agent, headline: ""),
        ])
        #expect(MenuBarGlyph.resolve(status: .ok, glance: g, freshness: fresh) == .you)
    }
}

@Suite(.serialized) struct DirectoryWatcherTests {
    @Test func firesWhenAFileIsAtomicallyRenamedIntoPlace() async throws {
        let dir = try TempDir("watch")
        let hits = Counter()
        let watcher = DirectoryWatcher(directory: dir.url) { hits.increment() }
        #expect(watcher.startIfPossible())
        #expect(watcher.isAttached)

        try dir.write("glance.json", "{}", atomic: true)
        #expect(await waitUntil { hits.value >= 1 })

        let before = hits.value
        try dir.write("glance.json", "{\"again\":true}", atomic: true)   // replaces the inode
        #expect(await waitUntil { hits.value > before })
        watcher.stop()
    }

    @Test func missingDirectoryCannotAttachUntilItExists() async throws {
        let parent = try TempDir("watch-parent")
        let target = parent.file("not-yet")
        let hits = Counter()
        let watcher = DirectoryWatcher(directory: target) { hits.increment() }
        #expect(!watcher.startIfPossible())
        #expect(!watcher.isAttached)

        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        #expect(watcher.startIfPossible())
        try Data("x".utf8).write(to: target.appendingPathComponent("f"), options: .atomic)
        #expect(await waitUntil { hits.value >= 1 })
        watcher.stop()
    }

    @Test func stopSilencesTheWatcher() async throws {
        let dir = try TempDir("watch-stop")
        let hits = Counter()
        let watcher = DirectoryWatcher(directory: dir.url) { hits.increment() }
        #expect(watcher.startIfPossible())
        watcher.stop()
        #expect(!watcher.isAttached)
        try dir.write("a", "1")
        try await Task.sleep(for: .milliseconds(200))
        #expect(hits.value == 0)
    }

    @Test func detachesWhenTheDirectoryIsRemovedAndCanReattach() async throws {
        let parent = try TempDir("watch-gone")
        let target = parent.file("home")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        let hits = Counter()
        let watcher = DirectoryWatcher(directory: target) { hits.increment() }
        #expect(watcher.startIfPossible())

        try FileManager.default.removeItem(at: target)
        #expect(await waitUntil { !watcher.isAttached }, "watch on a deleted directory must detach")
        #expect(hits.value >= 1, "removal is reported as a change")

        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        #expect(watcher.startIfPossible())
        let before = hits.value
        try Data("x".utf8).write(to: target.appendingPathComponent("f"), options: .atomic)
        #expect(await waitUntil { hits.value > before })
        watcher.stop()
    }
}

@Suite(.serialized) @MainActor struct GlanceStoreTests {
    /// Only the watcher can trigger reloads within a test (the fallback timer is an hour away).
    private func watcherOnlyConfig() -> GlanceStoreConfig {
        var c = GlanceStoreConfig()
        c.fallbackInterval = 3600
        c.debounce = 0.02
        return c
    }

    private func makeStore(_ dir: TempDir, config: GlanceStoreConfig? = nil, clock: TestClock = TestClock()) -> GlanceStore {
        GlanceStore(directory: WasitmeDirectory(dir.url), config: config ?? watcherOnlyConfig(), clock: clock.closure)
    }

    private func glanceJSON(at clock: TestClock, ageSeconds: TimeInterval = 0, state: String = "agent") -> String {
        Fixtures.glanceJSON(generatedAt: ContractDate.format(clock.date.addingTimeInterval(-ageSeconds)), state: state)
    }

    @Test func emptyDirectoryReportsMissing() async throws {
        let dir = try TempDir("store-empty")
        let store = makeStore(dir)
        #expect(store.glanceStatus == .notLoaded && store.glyph == .loading)
        await store.reload()
        #expect(store.glanceStatus == .missing)
        #expect(store.snapshotStatus == .missing)
        #expect(store.glance == nil)
        #expect(store.glyph == .notSetUp)
        #expect(!store.isStale)
    }

    @Test func nonexistentDirectoryIsNotAnError() async throws {
        let dir = try TempDir("store-nodir")
        let store = GlanceStore(directory: WasitmeDirectory(dir.file("nope")), config: watcherOnlyConfig())
        store.start()
        defer { store.stop() }
        #expect(await waitUntil { store.glanceStatus == .missing })
        #expect(!store.isWatching)
    }

    @Test func loadsGlanceAndSnapshot() async throws {
        let dir = try TempDir("store-load")
        let clock = TestClock()
        try dir.write("glance.json", glanceJSON(at: clock))
        try dir.write("snapshot.json", Fixtures.snapshotJSON)
        let store = makeStore(dir, clock: clock)
        await store.reload()
        #expect(store.glanceStatus == .ok && store.snapshotStatus == .ok)
        #expect(store.glance?.primary?.state == .agent)
        #expect(store.snapshot?.agents.count == 2)
        #expect(store.freshness.isFresh)
        #expect(store.glyph == .agent)
    }

    /// The core promise: the engine replaces glance.json atomically, the store notices by itself.
    @Test func watcherPicksUpAtomicReplacementWithoutPolling() async throws {
        let dir = try TempDir("store-watch")
        let clock = TestClock()
        try dir.write("glance.json", glanceJSON(at: clock, state: "none"))
        let store = makeStore(dir, clock: clock)
        store.start()
        defer { store.stop() }
        #expect(await waitUntil { store.glyph == .noDetectableChange })
        #expect(store.isWatching)

        try dir.write("glance.json", glanceJSON(at: clock, state: "you"), atomic: true)
        #expect(await waitUntil { store.glyph == .you }, "glyph is \(store.glyph)")
    }

    /// Two atomic replaces give two reloads, each within 1 s, with no polling (the fallback timer is an
    /// hour away) and the production debounce. A watch on the file itself would die after the first rename.
    @Test func twoAtomicReplacesGiveTwoReloadsWithinOneSecondEach() async throws {
        let dir = try TempDir("store-two-replaces")
        let clock = TestClock()
        try dir.write("glance.json", glanceJSON(at: clock, state: "none"))
        var config = GlanceStoreConfig()
        config.fallbackInterval = 3600
        let store = makeStore(dir, config: config, clock: clock)
        store.start()
        defer { store.stop() }
        #expect(await waitUntil { store.glyph == .noDetectableChange })
        #expect(store.isWatching)
        let before = store.reloadCount

        let first = Monotonic.now()
        try dir.write("glance.json", glanceJSON(at: clock, state: "you"), atomic: true)
        #expect(await waitUntil(timeout: 1) { store.glyph == .you }, "first replace not picked up within 1 s")
        #expect(Monotonic.seconds(from: first) < 1)
        let afterFirst = store.reloadCount
        #expect(afterFirst > before)

        try await Task.sleep(for: .milliseconds(250))
        let second = Monotonic.now()
        try dir.write("glance.json", glanceJSON(at: clock, state: "agent"), atomic: true)
        #expect(await waitUntil(timeout: 1) { store.glyph == .agent }, "second replace not picked up within 1 s")
        #expect(Monotonic.seconds(from: second) < 1)
        #expect(store.reloadCount > afterFirst, "the second replace needs its own reload")
    }

    /// The file's own staleAfterSec wins over the app's default.
    @Test func staleAfterSecComesFromTheGlance() async throws {
        let dir = try TempDir("store-stale-after")
        let clock = TestClock()
        let json = glanceJSON(at: clock, ageSeconds: 700).replacingOccurrences(of: "\"staleAfterSec\": 7200", with: "\"staleAfterSec\": 600")
        try dir.write("glance.json", json)
        let store = makeStore(dir, clock: clock)
        await store.reload()
        #expect(store.glance?.staleAfterSec == 600)
        #expect(store.isStale && store.glyph == .stale)
    }

    @Test func staleDetectionUsesTheTwoHourRule() async throws {
        let dir = try TempDir("store-stale")
        let clock = TestClock()
        try dir.write("glance.json", glanceJSON(at: clock, ageSeconds: 7000))
        let store = makeStore(dir, clock: clock)
        await store.reload()
        #expect(store.freshness.isFresh)
        #expect(store.glyph == .agent)

        clock.advance(300)                   // now 7300 s old
        await store.reload()
        #expect(store.isStale)
        guard case .stale(let age) = store.freshness else { Issue.record("expected stale, got \(store.freshness)"); return }
        #expect(age == 7300)
        #expect(store.glyph == .stale)
        #expect(store.glance != nil, "stale data stays visible, flagged")
    }

    @Test func clockGoingBackwardNeverProducesNegativeAgeOrFalseFreshness() async throws {
        let dir = try TempDir("store-backward")
        let clock = TestClock()
        try dir.write("glance.json", glanceJSON(at: clock))
        let store = makeStore(dir, clock: clock)
        await store.reload()
        clock.advance(-86_400)               // user sets the clock back a day
        await store.reload()
        #expect(store.freshness == .futureDated(by: 86_400))
        #expect(store.glyph == .stale)
        clock.advance(-60 + 86_400)          // restored, a minute later than the file
        await store.reload()
        #expect(store.freshness == .fresh(age: 0))
    }

    @Test func newerSchemaMajorClearsTheValueAndAsksForAnUpdate() async throws {
        let dir = try TempDir("store-newer")
        let clock = TestClock()
        try dir.write("glance.json", glanceJSON(at: clock))
        let store = makeStore(dir, clock: clock)
        await store.reload()
        #expect(store.glance != nil)

        try dir.write("glance.json", #"{"schema":"wasitme.glance/2","whatever":true}"#)
        await store.reload()
        #expect(store.glanceStatus == .updateNeeded(found: "wasitme.glance/2"))
        #expect(store.glance == nil, "a verdict from before the engine changed shape must not stay on screen")
        #expect(store.glyph == .updateNeeded)

        try dir.write("glance.json", glanceJSON(at: clock, state: "none"))
        await store.reload()
        #expect(store.glanceStatus == .ok && store.glyph == .noDetectableChange)
    }

    /// Display rule 1: a file that is not a JSON object is a mismatch, and nothing from before stays on screen.
    @Test func notAJSONObjectIsAMismatch() async throws {
        let dir = try TempDir("store-corrupt")
        let clock = TestClock()
        try dir.write("glance.json", glanceJSON(at: clock))
        let store = makeStore(dir, clock: clock)
        await store.reload()
        try dir.write("glance.json", "{ this is not json")
        await store.reload()
        #expect(store.glanceStatus == .updateNeeded(found: "not a JSON object"))
        #expect(store.glance == nil)
        #expect(store.glyph == .updateNeeded)
        #expect(store.snapshotStatus == .missing, "the other file is judged independently")
    }

    /// An OS-level read problem (here: the file grew past the size cap) keeps the last good glance, which
    /// surfaces show only as "last known", next to an error glyph.
    @Test func unreadableFileKeepsTheLastGoodGlanceButReportsTheProblem() async throws {
        let dir = try TempDir("store-unreadable")
        let clock = TestClock()
        let small = glanceJSON(at: clock)
        try dir.write("glance.json", small)
        var config = watcherOnlyConfig()
        config.maxGlanceBytes = small.utf8.count + 10
        let store = makeStore(dir, config: config, clock: clock)
        await store.reload()
        #expect(store.glance != nil)
        try dir.write("glance.json", small + String(repeating: " ", count: 100))
        await store.reload()
        guard case .invalid = store.glanceStatus else { Issue.record("got \(store.glanceStatus)"); return }
        #expect(store.glance != nil)
        #expect(store.glyph == .error)
    }

    @Test func deletingTheFileClearsTheGlance() async throws {
        let dir = try TempDir("store-delete")
        let clock = TestClock()
        let file = try dir.write("glance.json", glanceJSON(at: clock))
        let store = makeStore(dir, clock: clock)
        await store.reload()
        try FileManager.default.removeItem(at: file)
        await store.reload()
        #expect(store.glanceStatus == .missing && store.glance == nil)
    }

    @Test func oversizedFilesAreRefusedNotRead() async throws {
        let dir = try TempDir("store-big")
        let clock = TestClock()
        try dir.write("glance.json", glanceJSON(at: clock))
        var config = watcherOnlyConfig()
        config.maxGlanceBytes = 200
        let store = makeStore(dir, config: config, clock: clock)
        await store.reload()
        guard case .invalid(let why) = store.glanceStatus else { Issue.record("got \(store.glanceStatus)"); return }
        #expect(why.contains("larger"))
        #expect(store.glance == nil)
    }

    /// Display rule 2: refused, and the last good glance is dropped too (it would otherwise show as current).
    @Test func glanceDeclaringTextIsRefused() async throws {
        let dir = try TempDir("store-text")
        let clock = TestClock()
        try dir.write("glance.json", glanceJSON(at: clock))
        let store = makeStore(dir, clock: clock)
        await store.reload()
        #expect(store.glance != nil)
        try dir.write("glance.json", #"{"schema":"wasitme.glance/1","agents":[],"privacy":{"containsText":true}}"#)
        await store.reload()
        guard case .refused = store.glanceStatus else { Issue.record("got \(store.glanceStatus)"); return }
        #expect(store.glance == nil)
        #expect(store.glyph == .refused)
    }

    @Test func glanceWithoutAPrivacyDeclarationIsRefused() async throws {
        let dir = try TempDir("store-noprivacy")
        try dir.write("glance.json", #"{"schema":"wasitme.glance/1","agents":[]}"#)
        let store = makeStore(dir)
        await store.reload()
        guard case .refused(let why) = store.glanceStatus else { Issue.record("got \(store.glanceStatus)"); return }
        #expect(why.contains("text-free"))
        #expect(store.glance == nil)
    }

    @Test func snapshotCanBeSwitchedOffForTheMenuBarOnly() async throws {
        let dir = try TempDir("store-nosnap")
        let clock = TestClock()
        try dir.write("glance.json", glanceJSON(at: clock))
        try dir.write("snapshot.json", Fixtures.snapshotJSON)
        var config = watcherOnlyConfig()
        config.loadSnapshot = false
        let store = makeStore(dir, config: config, clock: clock)
        await store.reload()
        #expect(store.snapshot == nil && store.snapshotStatus == .notLoaded)
        #expect(store.glanceStatus == .ok)
    }

    /// First run: ~/.wasitme does not exist; the engine creates it later. The fallback timer must
    /// notice and attach the watcher.
    @Test func directoryAppearingLaterIsPickedUpByTheFallbackTimer() async throws {
        let parent = try TempDir("store-late")
        let home = parent.file("wasitme-home")
        let clock = TestClock()
        var config = GlanceStoreConfig()
        config.fallbackInterval = 0.05
        config.debounce = 0.01
        let store = GlanceStore(directory: WasitmeDirectory(home), config: config, clock: clock.closure)
        store.start()
        defer { store.stop() }
        #expect(await waitUntil { store.glanceStatus == .missing })
        #expect(!store.isWatching)

        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try Data(glanceJSON(at: clock).utf8).write(to: home.appendingPathComponent("glance.json"), options: .atomic)
        #expect(await waitUntil { store.glanceStatus == .ok })
        #expect(await waitUntil { store.isWatching })
    }

    @Test func directoryRecreatedWhileRunningIsReattached() async throws {
        let parent = try TempDir("store-recreate")
        let home = parent.file("wasitme-home")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let clock = TestClock()
        var config = GlanceStoreConfig()
        config.fallbackInterval = 0.05
        config.debounce = 0.01
        let store = GlanceStore(directory: WasitmeDirectory(home), config: config, clock: clock.closure)
        store.start()
        defer { store.stop() }
        #expect(await waitUntil { store.isWatching })

        try FileManager.default.removeItem(at: home)
        #expect(await waitUntil { store.glanceStatus == .missing })
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try Data(glanceJSON(at: clock, state: "you").utf8).write(to: home.appendingPathComponent("glance.json"), options: .atomic)
        #expect(await waitUntil { store.glyph == .you })
        #expect(await waitUntil { store.isWatching })
    }

    @Test func overlappingReloadsApplyInOrder() async throws {
        let dir = try TempDir("store-order")
        let clock = TestClock()
        try dir.write("glance.json", glanceJSON(at: clock, state: "none"))
        let store = makeStore(dir, clock: clock)
        async let a: Void = store.reload()
        async let b: Void = store.reload()
        async let c: Void = store.reload()
        _ = await (a, b, c)
        #expect(store.glanceStatus == .ok)
        #expect(store.reloadCount >= 1 && store.reloadCount <= 3)
    }

    @Test func standardDirectoryIsDotWasitmeUnderTheGivenHome() {
        let home = URL(fileURLWithPath: "/tmp/fake-home", isDirectory: true)
        let d = WasitmeDirectory.standard(home: home)
        #expect(d.url.path.hasSuffix("/fake-home/.wasitme"))
        #expect(d.glanceURL.lastPathComponent == "glance.json")
        #expect(d.snapshotURL.lastPathComponent == "snapshot.json")
        #expect(d.engineConfigURL.lastPathComponent == "engine.json")
    }
}
