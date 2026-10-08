import Dispatch
import Foundation
import os

/// Watches a DIRECTORY for entries being added, removed or replaced.
///
/// Why the directory and not the file: the engine writes `glance.json` atomically (temp file, then
/// `rename`). A watch on the file itself would stay attached to the old, now-unlinked inode and never
/// fire again. A `.write` event on the directory fires for every rename-into-place.
///
/// If the directory does not exist yet (the engine never ran), `startIfPossible()` returns false and
/// the owner retries on its fallback timer. If the watched directory itself is deleted or renamed, the
/// watcher detaches (and reports a change) so the next `startIfPossible()` re-attaches to the new one.
///
/// Thread-safe. The handler runs on `queue` (a background queue by default) and must be cheap and
/// non-blocking; hop to your own actor from it.
public final class DirectoryWatcher: @unchecked Sendable {
    private struct Attached {
        let source: any DispatchSourceFileSystemObject
    }

    private let path: String
    private let queue: DispatchQueue
    private let handler: @Sendable () -> Void
    private let state = OSAllocatedUnfairLock<Attached?>(initialState: nil)

    public init(
        directory: URL,
        queue: DispatchQueue = DispatchQueue(label: "dev.wasitme.directory-watcher", qos: .utility),
        onChange: @escaping @Sendable () -> Void
    ) {
        self.path = directory.path
        self.queue = queue
        self.handler = onChange
    }

    deinit { stop() }

    public var isAttached: Bool { state.withLock { $0 != nil } }

    /// Attaches if not already attached and the directory exists. Returns whether a watch is active.
    @discardableResult
    public func startIfPossible() -> Bool {
        state.withLock { current in
            if current != nil { return true }
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue else { return false }
            // O_EVTONLY: lets us watch without keeping the volume busy / preventing unmount.
            let fd = open(path, O_EVTONLY)
            guard fd >= 0 else { return false }

            let source = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: fd,
                eventMask: [.write, .extend, .attrib, .delete, .rename, .revoke],
                queue: queue)
            source.setEventHandler { [weak self, weak source] in
                guard let self, let source else { return }
                if !source.data.isDisjoint(with: [.delete, .rename, .revoke]) {
                    // The directory itself went away: this watch is dead. Detach so a later
                    // startIfPossible() can attach to whatever lives at the path now.
                    self.detach(ifSource: source)
                }
                self.handler()
            }
            source.setCancelHandler { close(fd) }
            current = Attached(source: source)
            source.resume()
            return true
        }
    }

    public func stop() {
        let attached = state.withLock { current -> Attached? in
            defer { current = nil }
            return current
        }
        attached?.source.cancel()
    }

    private func detach(ifSource source: any DispatchSourceFileSystemObject) {
        let matched = state.withLock { current -> Bool in
            guard let c = current, c.source === source else { return false }
            current = nil
            return true
        }
        if matched { source.cancel() }
    }
}
