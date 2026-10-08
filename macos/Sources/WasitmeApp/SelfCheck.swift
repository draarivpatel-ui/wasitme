import Foundation
import WasitmeCore
import WasitmeUI

/// Headless wiring check, `WasitmeApp --self-check [--home DIR] [--engine ACTION]`.
///
/// Runs the same `GlanceStore` / `EngineRunner` the GUI uses, prints ONE line of aggregate state
/// (status names, counts, freshness; never file contents), and exits. It never touches AppKit, so no
/// window, status item, Dock icon or focus change can happen. This is how the plumbing is verified
/// on a machine where the app must not be launched.
enum SelfCheck {
    @MainActor
    static func run(_ options: LaunchOptions) -> Never {
        Task { @MainActor in
            var config = GlanceStoreConfig()
            config.fallbackInterval = 3600
            let store = GlanceStore(directory: options.home, config: config)
            await store.reload()

            var parts: [String] = [
                "glance=\(describe(store.glanceStatus))",
                "snapshot=\(describe(store.snapshotStatus))",
                "glyph=\(store.glyph)",
                "freshness=\(describe(store.freshness))",
                "agents=\(store.glance?.agents.count ?? 0)",
                "snapshotAgents=\(store.snapshot?.agents.count ?? 0)",
            ]
            var failed = false

            if let raw = options.selfCheckEngineAction {
                let runner = EngineRunner(directory: options.home)
                do {
                    let out = try await runner.run(action: raw)
                    parts.append("engine=\(out.action.rawValue):ok:\(out.stdout.count)B:\(Int(out.duration * 1000))ms")
                } catch {
                    failed = true
                    parts.append("engine=failed:\(label(error))")
                }
            }
            print(parts.joined(separator: " "))
            fflush(stdout)
            exit(failed ? 1 : 0)
        }
        dispatchMain()
    }

    /// Case name only: the engine's stderr text is deliberately not echoed.
    private static func label(_ error: Error) -> String {
        guard let e = error as? EngineError else { return "unexpected" }
        switch e {
        case .notConfigured: return "notConfigured"
        case .invalidConfig: return "invalidConfig"
        case .invalidArgument: return "invalidArgument"
        case .launchFailed: return "launchFailed"
        case .timedOut: return "timedOut"
        case .outputTooLarge: return "outputTooLarge"
        case .cancelled: return "cancelled"
        case .nonZeroExit(let code, _): return "nonZeroExit(\(code))"
        case .killedBySignal(let signal, _): return "killedBySignal(\(signal))"
        }
    }

    private static func describe(_ status: SourceStatus) -> String {
        switch status {
        case .notLoaded: "notLoaded"
        case .ok: "ok"
        case .missing: "missing"
        case .updateNeeded(let found): "updateNeeded(\(found))"
        case .refused(let why): "refused(\(why))"
        case .invalid(let why): "invalid(\(why))"
        }
    }

    private static func describe(_ f: Freshness) -> String {
        switch f {
        case .fresh(let age): "fresh(\(Int(age))s)"
        case .stale(let age): "stale(\(Int(age))s)"
        case .futureDated(let by): "futureDated(\(Int(by))s)"
        case .unknown: "unknown"
        }
    }
}
