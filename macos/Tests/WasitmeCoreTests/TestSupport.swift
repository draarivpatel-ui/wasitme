import Foundation
import os
@testable import WasitmeCore

/// A throwaway directory under the system temp dir. Tests never touch ~/.wasitme, ~/.claude,
/// ~/.codex or ~/Library.
final class TempDir: @unchecked Sendable {
    let url: URL

    init(_ label: String = "t") throws {
        url = FileManager.default.temporaryDirectory
            .appendingPathComponent("wasitme-test-\(label)-\(UUID().uuidString.prefix(8))", isDirectory: true)
            .standardizedFileURL
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: url) }

    func file(_ name: String) -> URL { url.appendingPathComponent(name) }

    @discardableResult
    func write(_ name: String, _ contents: String, atomic: Bool = true, executable: Bool = false) throws -> URL {
        let target = file(name)
        try Data(contents.utf8).write(to: target, options: atomic ? .atomic : [])
        if executable { try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: target.path) }
        return target
    }
}

/// Polls until `condition` is true or `timeout` passes (real file-system events and subprocesses are
/// asynchronous; a fixed sleep would be either flaky or slow).
@MainActor @discardableResult
func waitUntil(timeout: TimeInterval = 5, interval: Duration = .milliseconds(10),
               _ condition: @MainActor @Sendable () -> Bool) async -> Bool {
    let deadline = Monotonic.deadline(after: timeout)
    while Monotonic.now() < deadline {
        if condition() { return true }
        try? await Task.sleep(for: interval)
    }
    return condition()
}

/// Mutable clock for tests of staleness.
final class TestClock: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock<Date>(initialState: Date(timeIntervalSince1970: 1_791_115_200))
    var date: Date {
        get { lock.withLock { $0 } }
        set { lock.withLock { $0 = newValue } }
    }
    func advance(_ seconds: TimeInterval) { lock.withLock { $0 = $0.addingTimeInterval(seconds) } }
    var closure: @Sendable () -> Date { { [self] in date } }
}

final class Counter: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock<Int>(initialState: 0)
    var value: Int { lock.withLock { $0 } }
    func increment() { lock.withLock { $0 += 1 } }
}
