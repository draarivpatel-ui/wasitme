import AppKit
import WasitmeCore

/// One running copy per user: the `--supervised` LaunchAgent instance plus a user `open`
/// would otherwise show two status items.
///
/// Two checks, because each misses a case the other catches:
///  - `NSRunningApplication` by bundle id (the obvious check) sees any other bundled copy, but an unbundled dev
///    binary has no bundle id;
///  - an exclusive `flock` on a per-user lock file keyed by bundle id + home directory is race-free (two
///    launches in the same instant) and works unbundled. Keying by home lets a temp-home test instance run
///    beside the real one.
/// A second launch hands off to the first (a distributed notification: "open your popover") and exits.
public enum SingleInstance {
    public enum Decision: Equatable, Sendable { case proceed, handOff }

    /// Posted by a second launch; the running instance opens its popover.
    public static let handOffNotification = Notification.Name("\(WasitmeIdentity.bundleIdentifier).reopen")

    public static func decide(lockAcquired: Bool, otherInstancePIDs: [pid_t]) -> Decision {
        lockAcquired && otherInstancePIDs.isEmpty ? .proceed : .handOff
    }

    /// `<tmp>/wasitme-<fnv1a(bundleID + home)>.lock` (the user's own temp directory).
    public static func lockURL(bundleID: String, home: URL, tempDirectory: URL = FileManager.default.temporaryDirectory) -> URL {
        let key = "\(bundleID)\u{0}\(home.standardizedFileURL.path)"
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in key.utf8 { hash = (hash ^ UInt64(b)) &* 0x0000_0100_0000_01B3 }
        return tempDirectory.appendingPathComponent("wasitme-\(String(hash, radix: 16)).lock", isDirectory: false)
    }

    /// Other running copies with our bundle id (none for an unbundled binary).
    @MainActor
    public static func otherInstances(bundleID: String?, selfPID: pid_t = getpid()) -> [pid_t] {
        guard let bundleID else { return [] }
        return NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .map(\.processIdentifier).filter { $0 != selfPID && $0 > 0 }
    }

    public static func postHandOff() {
        DistributedNotificationCenter.default().postNotificationName(handOffNotification, object: nil, userInfo: nil,
                                                                     deliverImmediately: true)
    }
}

/// An exclusive advisory lock held for the life of the process (released by the kernel on exit/crash).
public final class InstanceLock: @unchecked Sendable {
    private let fd: Int32
    public let url: URL

    /// nil when another process (or another open file description) holds the lock.
    public init?(url: URL) {
        let fd = open(url.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return nil }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); return nil }
        self.fd = fd
        self.url = url
    }

    deinit {
        flock(fd, LOCK_UN)
        close(fd)
    }
}
