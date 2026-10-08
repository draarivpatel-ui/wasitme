import Foundation
import Observation
import WasitmeCore

/// App-level state every surface reads: the file store, the engine-run state, and the display decision.
/// (`@Observable` is fine with Command Line Tools; the SwiftUI `@State` / `#Preview` macros are not.)
@MainActor @Observable
public final class AppController {
    public let store: GlanceStore
    @ObservationIgnored let runner: EngineRunner

    public private(set) var isScanning = false
    /// Plain-language result of the last engine run, or nil before any run.
    public private(set) var lastEngineMessage: String?

    public init(store: GlanceStore, runner: EngineRunner) {
        self.store = store
        self.runner = runner
    }

    /// The contract display rules over the store's current state (re-evaluated on every reload/poll).
    public var display: GlanceDisplay {
        GlanceDisplay.make(status: store.glanceStatus, glance: store.glance, now: store.now,
                           futureTolerance: store.config.futureTolerance)
    }

    /// What the Control Center shows: the snapshot's glance part when the snapshot can be shown, else the glance.
    public var controlCenterDisplay: GlanceDisplay {
        if store.snapshotStatus == .ok, let snap = store.snapshot {
            return GlanceDisplay.make(status: .ok, glance: snap.glancePart, now: store.now, futureTolerance: store.config.futureTolerance)
        }
        return display
    }

    /// The snapshot only when it may be shown as-is (ok status); never a refused or mismatched one.
    public var shownSnapshot: Snapshot? { store.snapshotStatus == .ok ? store.snapshot : nil }

    /// Runs `scan` through the allow-listed runner, then re-reads the files. Overlapping presses are
    /// coalesced by the runner and ignored here while one is in flight.
    public func scanNow() {
        guard !isScanning else { return }
        isScanning = true
        lastEngineMessage = "Scanning…"
        Task {
            do {
                let out = try await runner.run(.scan)
                lastEngineMessage = "Scan finished in \(Int(out.duration * 1000)) ms."
            } catch {
                lastEngineMessage = Self.message(for: error)
            }
            await store.reload()
            isScanning = false
        }
    }

    /// Plain words for an engine failure; never the engine's stderr text.
    static func message(for error: Error) -> String {
        guard let e = error as? EngineError else { return "Scan failed." }
        switch e {
        case .notConfigured: return "wasitme's engine isn't set up. Run `wasitme doctor`."
        case .invalidConfig: return "wasitme's engine isn't where it was. Run `wasitme doctor --repair`."
        case .timedOut: return "Scan timed out."
        case .cancelled: return "Scan cancelled."
        default: return "Scan failed. Run `wasitme doctor`."
        }
    }
}
