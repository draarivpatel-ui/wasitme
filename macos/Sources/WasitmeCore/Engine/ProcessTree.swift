import Darwin
import Foundation

/// A process identified by pid AND start time, so a pid that was recycled for an unrelated process
/// is never signalled by mistake.
struct ProcessIdentity: Hashable, Sendable {
    let pid: pid_t
    let startSeconds: UInt64
    let startMicroseconds: UInt64
}

/// Process-tree inspection and signalling on top of libproc (no `ps`, no shell).
enum ProcessTree {
    /// Hard cap so a fork bomb cannot make the walk unbounded.
    static let maxDescendants = 512

    static func identity(of pid: pid_t) -> ProcessIdentity? {
        guard pid > 0 else { return nil }
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return ProcessIdentity(pid: pid, startSeconds: info.pbi_start_tvsec, startMicroseconds: info.pbi_start_tvusec)
    }

    static func parent(of pid: pid_t) -> pid_t? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return pid_t(info.pbi_ppid)
    }

    /// Alive means: still the same process (start time matches) and not a zombie.
    static func isLive(_ id: ProcessIdentity) -> Bool {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(id.pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return false }
        return info.pbi_start_tvsec == id.startSeconds && info.pbi_start_tvusec == id.startMicroseconds
            && info.pbi_status != UInt32(SZOMB)
    }

    static func children(of pid: pid_t) -> [pid_t] {
        var capacity = 64
        while true {
            var buffer = [pid_t](repeating: 0, count: capacity)
            // Returns the number of pids written (not bytes).
            let n = Int(proc_listchildpids(pid, &buffer, Int32(capacity * MemoryLayout<pid_t>.size)))
            if n < 0 { return [] }
            if n < capacity || capacity >= maxDescendants { return Array(buffer.prefix(n)).filter { $0 > 0 } }
            capacity *= 2
        }
    }

    /// `root` (if it is alive) and every live descendant, breadth first.
    static func descendants(of root: pid_t) -> [ProcessIdentity] {
        var result: [ProcessIdentity] = []
        var seen: Set<pid_t> = [root]
        var queue: [pid_t] = [root]
        var index = 0
        while index < queue.count, result.count < maxDescendants {
            let pid = queue[index]
            index += 1
            if let id = identity(of: pid), isLive(id) { result.append(id) }
            for child in children(of: pid) where seen.insert(child).inserted { queue.append(child) }
        }
        return result
    }

    /// Signals the process only if it is still the same one we identified.
    @discardableResult
    static func signal(_ id: ProcessIdentity, _ signal: Int32) -> Bool {
        guard isLive(id) else { return false }
        return kill(id.pid, signal) == 0
    }

    /// True when `pid` leads its own process group (Foundation's `Process` starts children that way
    /// on current macOS; this is checked at runtime instead of assumed).
    static func leadsOwnGroup(_ pid: pid_t) -> Bool { getpgid(pid) == pid }
}
