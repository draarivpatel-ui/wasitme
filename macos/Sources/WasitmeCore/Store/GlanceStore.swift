import Foundation
import Observation

public struct GlanceStoreConfig: Sendable {
    /// Safety-net poll: catches a watcher that missed an event and re-attaches the watcher when the
    /// directory appears later. Contract: 60 s.
    public var fallbackInterval: TimeInterval = 60
    /// Directory events are coalesced: one reload this long after the last event.
    public var debounce: TimeInterval = 0.15
    /// Fallback only: a glance carries its own `staleAfterSec` (contract default 2 h), which wins.
    public var staleAfter: TimeInterval = Freshness.defaultStaleAfter
    /// `generatedAt` further than this into the future is reported as future-dated.
    public var futureTolerance: TimeInterval = Freshness.defaultFutureTolerance
    /// The glance is specified as <= 16 KB; anything above this is refused rather than read.
    public var maxGlanceBytes: Int = 1 << 20
    public var maxSnapshotBytes: Int = 32 << 20
    /// The menu bar only needs the glance; the Control Center turns this on for the full snapshot.
    public var loadSnapshot: Bool = true

    public init() {}
}

/// Main-actor model every surface reads: menu bar glyph, popover, desktop panel, Control Center.
///
/// Reads `glance.json` / `snapshot.json` from the engine's directory (`~/.wasitme` by default),
/// reloads when the directory changes (atomic renames) and on a 60 s fallback timer, and publishes the
/// decoded state through Observation. Read-only: it never writes to the directory.
///
/// Policy for a bad read: `missing` and `updateNeeded` clear the value (old data would mislead);
/// `invalid` keeps the last good value and reports the problem in `*Status`.
@MainActor @Observable
public final class GlanceStore {
    public let directory: WasitmeDirectory
    public let config: GlanceStoreConfig

    public private(set) var glance: Glance?
    public private(set) var glanceStatus: SourceStatus = .notLoaded
    public private(set) var snapshot: Snapshot?
    public private(set) var snapshotStatus: SourceStatus = .notLoaded
    /// Wall-clock time of the last reload. Freshness is judged against this, so views update on every poll.
    public private(set) var now: Date
    public private(set) var reloadCount = 0
    /// False while the directory does not exist; the fallback timer keeps trying to attach.
    public private(set) var isWatching = false

    @ObservationIgnored private let clock: @Sendable () -> Date
    @ObservationIgnored private let loader: StateLoader
    @ObservationIgnored private var watcher: DirectoryWatcher?
    @ObservationIgnored private var fallbackTask: Task<Void, Never>?
    @ObservationIgnored private var debounceTask: Task<Void, Never>?
    @ObservationIgnored private var lastApplied: UInt64 = 0

    public init(
        directory: WasitmeDirectory = .standard(),
        config: GlanceStoreConfig = GlanceStoreConfig(),
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.directory = directory
        self.config = config
        self.clock = clock
        self.now = clock()
        self.loader = StateLoader(directory: directory, maxGlanceBytes: config.maxGlanceBytes,
                                  maxSnapshotBytes: config.maxSnapshotBytes, loadSnapshot: config.loadSnapshot)
    }

    // MARK: derived state

    public var freshness: Freshness {
        Freshness.evaluate(generatedAt: glance?.generatedAt, now: now,
                           staleAfter: glance.map { TimeInterval($0.staleAfterSec) } ?? config.staleAfter,
                           futureTolerance: config.futureTolerance)
    }

    public var snapshotFreshness: Freshness {
        Freshness.evaluate(generatedAt: snapshot?.generatedAt, now: now,
                           staleAfter: snapshot.map { TimeInterval($0.staleAfterSec) } ?? config.staleAfter,
                           futureTolerance: config.futureTolerance)
    }

    public var glyph: MenuBarGlyph {
        MenuBarGlyph.resolve(status: glanceStatus, glance: glance, freshness: freshness)
    }

    /// True when a glance is on screen but is old, future-dated or of unknown age.
    public var isStale: Bool { glance != nil && !freshness.isFresh }

    // MARK: lifecycle

    /// Starts watching and polling. Idempotent. Performs an initial load immediately.
    public func start() {
        guard fallbackTask == nil else { return }
        attachWatcher()
        fallbackTask = Task { [weak self] in
            await self?.reload()
            while !Task.isCancelled {
                guard let interval = self?.config.fallbackInterval else { return }
                try? await Task.sleep(for: .seconds(interval))
                guard !Task.isCancelled, let self else { return }
                self.attachWatcher()     // the directory may have appeared (or been recreated)
                await self.reload()
            }
        }
    }

    public func stop() {
        fallbackTask?.cancel(); fallbackTask = nil
        debounceTask?.cancel(); debounceTask = nil
        watcher?.stop(); watcher = nil
        isWatching = false
    }

    /// Reads both files now and publishes the result. Safe to call concurrently; results are applied
    /// in the order the reads were issued.
    public func reload() async {
        let result = await loader.load()
        apply(result)
    }

    // MARK: internals

    private func attachWatcher() {
        if watcher == nil {
            watcher = DirectoryWatcher(directory: directory.url) { [weak self] in
                Task { @MainActor in self?.watcherFired() }
            }
        }
        isWatching = watcher?.startIfPossible() ?? false
    }

    private func watcherFired() {
        isWatching = watcher?.isAttached ?? false
        debounceTask?.cancel()
        let delay = config.debounce
        debounceTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.reload()
        }
    }

    private func apply(_ result: StateLoader.Result) {
        guard result.sequence > lastApplied else { return }   // an older read finished late
        lastApplied = result.sequence
        now = clock()
        reloadCount += 1
        Self.merge(result.glance, value: &glance, status: &glanceStatus)
        Self.merge(result.snapshot, value: &snapshot, status: &snapshotStatus)
    }

    private static func merge<V: Sendable>(_ read: FileRead<V>, value: inout V?, status: inout SourceStatus) {
        switch read {
        case .unchanged: break
        case .missing: value = nil; status = .missing
        case .loaded(let v): value = v; status = .ok
        case .updateNeeded(let found): value = nil; status = .updateNeeded(found: found)
        case .refused(let why): value = nil; status = .refused(why)
        case .invalid(let why): status = .invalid(why)       // keep the last good value (shown as "last known" only)
        }
    }
}
