import Darwin
import Dispatch
import Foundation
import os

/// Everything needed to run one child process. No shell is ever involved: `executable` is exec'd
/// directly with `arguments` as its argv.
public struct ProcessSpec: Sendable {
    public var executable: URL
    public var arguments: [String]
    /// The child's entire environment (nothing is inherited implicitly).
    public var environment: [String: String]
    public var currentDirectory: URL?
    /// Limit for the child's lifetime, on a monotonic clock (a wall-clock step cannot shorten or
    /// stretch it).
    public var timeout: TimeInterval
    /// Limit on stdout + stderr combined.
    public var maxOutputBytes: Int
    /// After SIGTERM, how long processes get to exit before SIGKILL.
    public var killGrace: TimeInterval
    /// TEST HOOK (internal, not part of the public initialiser): delay before the pipe readers start,
    /// to make "the child exited before its output was read" deterministic.
    var readerStartDelay: TimeInterval = 0
    /// How long after the child has exited its pipes are still read. A descendant that inherited the
    /// pipes and keeps writing cannot hold the run open past this (and never past the timeout, apart
    /// from a short floor that lets already-buffered output be collected). Internal so tests can use a
    /// short value; production code uses the default.
    var postExitDrain: TimeInterval = 1

    public init(
        executable: URL, arguments: [String] = [], environment: [String: String] = [:],
        currentDirectory: URL? = nil, timeout: TimeInterval = 60, maxOutputBytes: Int = 8 * 1024 * 1024,
        killGrace: TimeInterval = 2
    ) {
        self.executable = executable; self.arguments = arguments; self.environment = environment
        self.currentDirectory = currentDirectory; self.timeout = timeout
        self.maxOutputBytes = maxOutputBytes; self.killGrace = killGrace
    }
}

public struct ProcessResult: Sendable, Equatable {
    public var stdout: Data
    public var stderr: Data
    /// Exit code, or the signal number when `terminatedBySignal`.
    public var status: Int32
    public var terminatedBySignal: Bool
    /// Elapsed run time, measured on a monotonic clock: never negative, whatever the wall clock does.
    public var duration: TimeInterval
}

public enum ProcessFailure: Error, Equatable, Sendable {
    case launchFailed(String)
    case timedOut(after: TimeInterval)
    case outputTooLarge(limitBytes: Int)
    case cancelled
}

/// Runs a child process with a timeout, a bounded output budget, concurrent draining of stdout and
/// stderr (waiting for exit before draining deadlocks once a pipe buffer fills), and tree-wide kill.
///
/// Tree kill: Foundation's `Process` starts the child as leader of its own process group on current
/// macOS (verified at runtime per run, not assumed), so `kill(-pgid)` reaches every descendant that
/// stayed in the group. Descendants that left the group (setsid) are found through libproc and
/// signalled individually, verified by start time so a recycled pid is never hit. Blocking work (pipe
/// reads, the kill grace wait) runs on Dispatch threads, never on the Swift concurrency pool.
///
/// Time: every duration and deadline here comes from `Monotonic`, never from `Date`, so a clock that
/// is stepped backwards or forwards mid-run cannot produce a negative duration or stretch or cut a
/// grace period.
///
/// Boundedness: the child's lifetime is limited by `timeout` (then SIGTERM, SIGKILL after
/// `killGrace`). Once the child has exited, reading its pipes is limited by `postExitDrain`, so a
/// descendant that inherited the pipes cannot hold the run open, whether it is silent or keeps
/// writing. If that happens after a clean exit the result is still the child's own (its status and
/// the output read so far, which may include the descendant's writes): the same rule as for any
/// timeout or cancel that arrives after the child has finished. The pipes are then closed, so the
/// descendant's next write fails with EPIPE/SIGPIPE.
public enum ProcessRunner {
    public static func run(_ spec: ProcessSpec) async throws -> ProcessResult {
        let job = Job(spec)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<ProcessResult, Error>) in
                job.start(cont)
            }
        } onCancel: {
            job.cancel()
        }
    }
}

// MARK: - Implementation

/// stdout + stderr share one byte budget.
private final class OutputBudget: @unchecked Sendable {
    private let lock: OSAllocatedUnfairLock<Int>
    init(_ limit: Int) { lock = OSAllocatedUnfairLock(initialState: max(0, limit)) }
    /// Returns how many of `n` bytes may be kept.
    func take(_ n: Int) -> Int { lock.withLock { remaining in let g = min(n, remaining); remaining -= g; return g } }
}

private final class Sink: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock<Data>(initialState: Data())
    func append(_ chunk: Data) { lock.withLock { $0.append(chunk) } }
    var data: Data { lock.withLock { $0 } }
}

private final class Flag: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock<Bool>(initialState: false)
    func set() { lock.withLock { $0 = true } }
    var isSet: Bool { lock.withLock { $0 } }
}

/// A monotonic clock in nanoseconds (mach absolute time via Dispatch). Unlike `Date`, it never goes
/// backwards, so elapsed time is never negative and a deadline neither stretches nor collapses.
enum Monotonic {
    static func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

    /// `seconds` as nanoseconds, clamped to a range that cannot overflow (negative and NaN become 0).
    static func nanoseconds(_ seconds: TimeInterval) -> UInt64 {
        guard seconds > 0 else { return 0 }                    // also false for NaN
        let limit = 100.0 * 365 * 24 * 3600                     // far beyond any timeout we are given
        return UInt64(min(seconds, limit) * 1_000_000_000)
    }

    static func deadline(after seconds: TimeInterval) -> UInt64 { now() &+ nanoseconds(seconds) }

    /// Seconds from `start` to `end` (default: now). Zero rather than negative or a trap if the
    /// arguments are ever out of order.
    static func seconds(from start: UInt64, to end: UInt64 = now()) -> TimeInterval {
        end >= start ? Double(end - start) / 1_000_000_000 : 0
    }
}

/// How long a finished child's pipes are still read.
enum PostExitDrain {
    /// A floor, so output the child wrote just before exiting is still collected when it exits at the
    /// very edge of its timeout (otherwise the allowance would be about zero and a reader that has not
    /// been scheduled yet could miss bytes that were already in the pipe).
    static let floor: TimeInterval = 0.1

    /// After the window, a reader still takes what is already buffered in its pipe, up to this much (a macOS pipe
    /// holds at most 64 KiB, so this is the child's leftover output, never an endless stream).
    static let finalSweepBytes = 256 * 1024

    /// `drain`, but not past the timeout, and never less than `floor`.
    static func window(drain: TimeInterval, timeout: TimeInterval, elapsed: TimeInterval) -> TimeInterval {
        let remaining = max(0, timeout - elapsed)
        return min(max(0, drain), max(remaining, floor))
    }
}

private final class Deadline: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock<UInt64>(initialState: .max)
    /// Monotonic nanoseconds; `.max` means "not set".
    func set(_ nanos: UInt64) { lock.withLock { $0 = nanos } }
    var hasPassed: Bool { let d = lock.withLock { $0 }; return d != .max && Monotonic.now() >= d }
}

/// `DispatchWorkItem` is not `Sendable` in the SDK, but cancelling one from any thread is its documented
/// use, and that is all this wrapper allows.
private struct CancelableTimer: @unchecked Sendable {
    private let item: DispatchWorkItem
    init(_ item: DispatchWorkItem) { self.item = item }
    func cancel() { item.cancel() }
}

private final class Job: @unchecked Sendable {
    private struct State {
        var failure: ProcessFailure?
        var cancelRequested = false
        var started = false
        var exited = false
        var finished = false
        var pid: pid_t = 0
        var leader = false
        var continuation: CheckedContinuation<ProcessResult, Error>?
        /// Timers. They capture the job weakly and are cancelled in `finish`, so a finished run is not
        /// kept alive (with its pipes' file descriptors) until its timeout would have fired.
        var timeoutTimer: CancelableTimer?
        var insuranceTimer: CancelableTimer?
    }

    private let spec: ProcessSpec
    private let state = OSAllocatedUnfairLock(initialState: State())
    private let budget: OutputBudget
    private let stdout = Sink()
    private let stderr = Sink()
    /// Set when the child has exited: from then on a reader may stop once its pipe is idle.
    private let readersMayStop = Flag()
    /// Hard stop for the readers (monotonic): when the child has exited, the end of the post-exit
    /// drain window.
    private let drainDeadline = Deadline()
    /// Hard stop for the readers, set explicitly.
    private let mustStop = Flag()
    private let group = DispatchGroup()
    private let startedAt = Monotonic.now()
    // Foundation objects used only from this class (never handed to another isolation domain).
    private let process = Process()
    private let outPipe = Pipe()
    private let errPipe = Pipe()

    init(_ spec: ProcessSpec) {
        self.spec = spec
        self.budget = OutputBudget(spec.maxOutputBytes)
    }

    // MARK: lifecycle

    func start(_ continuation: CheckedContinuation<ProcessResult, Error>) {
        let cancelledBeforeStart = state.withLock { s -> Bool in
            s.continuation = continuation
            return s.cancelRequested
        }
        if cancelledBeforeStart { finish(.failure(ProcessFailure.cancelled)); return }
        DispatchQueue.global(qos: .utility).async { self.launch() }
    }

    func cancel() {
        let notStarted = state.withLock { s -> Bool in
            s.cancelRequested = true
            return !s.started
        }
        if !notStarted { fail(.cancelled, onlyWhileRunning: true) }
        // If it has not started, start()/launch() observes cancelRequested.
    }

    private func launch() {
        process.executableURL = spec.executable
        process.arguments = spec.arguments
        process.environment = spec.environment
        if let dir = spec.currentDirectory { process.currentDirectoryURL = dir }
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = outPipe
        process.standardError = errPipe

        // A cancel that arrived between `start()` and here: nothing has been launched yet, so nothing is launched (one
        // that arrives after `run()` is caught below, once the pid is known, and kills the child).
        if state.withLock({ $0.cancelRequested }) { finish(.failure(ProcessFailure.cancelled)); return }

        group.enter()      // balanced by the termination handler (or below, if launching fails)
        process.terminationHandler = { [self] _ in
            state.withLock { $0.exited = true }
            drainDeadline.set(postExitDrainDeadline())
            readersMayStop.set()
            group.leave()
        }
        do {
            try process.run()
        } catch {
            process.terminationHandler = nil
            group.leave()
            finish(.failure(ProcessFailure.launchFailed(error.localizedDescription)))
            return
        }

        let pid = process.processIdentifier
        let cancelNow = state.withLock { s -> Bool in
            s.started = true
            s.pid = pid
            s.leader = ProcessTree.leadsOwnGroup(pid)
            return s.cancelRequested
        }

        for (pipe, sink) in [(outPipe, stdout), (errPipe, stderr)] {
            let fd = pipe.fileHandleForReading.fileDescriptor
            group.enter()
            DispatchQueue.global(qos: .utility).async {
                if self.spec.readerStartDelay > 0 { usleep(UInt32(self.spec.readerStartDelay * 1_000_000)) }
                self.drain(fd: fd, into: sink)
                self.group.leave()
            }
        }

        let timer = DispatchWorkItem { [weak self] in self?.timeoutFired() }
        let cancelable = CancelableTimer(timer)
        state.withLock { $0.timeoutTimer = cancelable }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + max(0, spec.timeout), execute: timer)

        group.notify(queue: .global(qos: .utility)) { [self] in complete() }
        if cancelNow { fail(.cancelled, onlyWhileRunning: true) }
    }

    // MARK: draining

    /// When to stop reading after the child exited (see `PostExitDrain`).
    private func postExitDrainDeadline() -> UInt64 {
        Monotonic.deadline(after: PostExitDrain.window(
            drain: spec.postExitDrain, timeout: spec.timeout, elapsed: Monotonic.seconds(from: startedAt)))
    }

    /// The timeout timer. While the child runs, that is a failure plus a tree kill. If the child has
    /// already exited the run is only waiting for its pipes, so the readers are stopped now (their own
    /// deadline normally got there first).
    private func timeoutFired() {
        let exited = state.withLock { $0.exited }
        if exited { mustStop.set() } else { fail(.timedOut(after: spec.timeout), onlyWhileRunning: true) }
    }

    /// Reads until EOF. Never reads past a hard stop, checked on EVERY iteration: a descendant that
    /// inherited the pipe and keeps it readable would otherwise never let an idle check run. After the
    /// child has exited it also stops as soon as the pipe has no buffered data, so a silent descendant
    /// costs one poll interval.
    private func drain(fd: Int32, into sink: Sink) {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            if mustStop.isSet || drainDeadline.hasPassed {
                finalSweep(fd: fd, buffer: &buffer, into: sink)
                return
            }
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let rc = poll(&pfd, 1, 100)
            if rc < 0 {
                if errno == EINTR { continue }
                return
            }
            if rc == 0 {
                // The child has exited and its pipe sat idle for a whole poll interval. Take anything that landed in the
                // microseconds between the poll returning and this check (the same zero-wait sweep the deadline path
                // does), then stop.
                if readersMayStop.isSet {
                    finalSweep(fd: fd, buffer: &buffer, into: sink)
                    return
                }
                continue
            }
            let n = read(fd, &buffer, buffer.count)
            if n > 0 {
                if !keep(n, from: buffer, into: sink) { return }
                continue
            }
            if n == 0 { return }                         // EOF
            if errno == EINTR || errno == EAGAIN { continue }
            return
        }
    }

    /// Charges `n` read bytes to the shared budget; false (and the overflow recorded) when they don't all fit.
    private func keep(_ n: Int, from buffer: [UInt8], into sink: Sink) -> Bool {
        let granted = budget.take(n)
        if granted > 0 { sink.append(Data(buffer[0..<granted])) }
        if granted < n {
            fail(.outputTooLarge(limitBytes: spec.maxOutputBytes))
            return false
        }
        return true
    }

    /// The post-exit window (or the timeout) is over, but a reader scheduled late on a loaded machine may not have
    /// looked at its pipe yet, and what the child wrote before it exited is sitting there. Take what is ALREADY
    /// buffered, without waiting (poll with a zero timeout) and at most `PostExitDrain.finalSweepBytes`, so a chatty
    /// descendant still cannot hold the run open. Fixes the flaky `outputIsBounded`: a 5,000-byte overflow used to be
    /// missed when the reader started after the window, and the run "succeeded" with nothing read.
    private func finalSweep(fd: Int32, buffer: inout [UInt8], into sink: Sink) {
        var swept = 0
        while swept < PostExitDrain.finalSweepBytes {
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let rc = poll(&pfd, 1, 0)
            if rc < 0, errno == EINTR { continue }
            guard rc > 0, pfd.revents & Int16(POLLIN) != 0 else { return }
            let n = read(fd, &buffer, min(buffer.count, PostExitDrain.finalSweepBytes - swept))
            if n > 0 {
                swept += n
                if !keep(n, from: buffer, into: sink) { return }
                continue
            }
            if n < 0, errno == EINTR { continue }
            return                                       // EOF or an error
        }
    }

    // MARK: failure and kill

    /// Records the first failure and, if the child is still running, kills its whole tree.
    ///
    /// Recording and killing are separate decisions. A failure is recorded even when the child has
    /// already exited, because the result it describes is then wrong: output that overflowed the budget
    /// is truncated, so reporting success would hand the caller silently cut-off data. Only `timedOut`
    /// and `cancelled` pass `onlyWhileRunning`: if the child finished first, its result stands.
    private func fail(_ reason: ProcessFailure, onlyWhileRunning: Bool = false) {
        let shouldKill = state.withLock { s -> Bool in
            guard s.failure == nil, !s.finished else { return false }
            if onlyWhileRunning && s.exited { return false }
            s.failure = reason
            guard s.started, !s.exited else { return false }     // nothing left to kill
            group.enter()          // safe: the exit entry is still outstanding because `exited` is false
            return true
        }
        guard shouldKill else { return }
        DispatchQueue.global(qos: .utility).async {
            self.killTree()
            self.group.leave()
        }
        // Insurance for a child that cannot be killed (uninterruptible I/O): report the failure
        // anyway instead of hanging the caller forever. `finish` is once-only, so this is harmless
        // when the normal path completes first.
        let insurance = DispatchWorkItem { [weak self] in self?.finish(.failure(reason)) }
        let cancelable = CancelableTimer(insurance)
        let alreadyFinished = state.withLock { s -> Bool in
            if s.finished { return true }
            s.insuranceTimer = cancelable
            return false
        }
        if alreadyFinished { return }
        DispatchQueue.global(qos: .utility).asyncAfter(
            deadline: .now() + max(0, spec.killGrace) + 5, execute: insurance)
    }

    private func killTree() {
        let (pid, leader) = state.withLock { ($0.pid, $0.leader) }
        let snapshot = ProcessTree.descendants(of: pid)

        // Phase 1: polite.
        if leader { kill(-pid, SIGTERM) }
        for id in snapshot { ProcessTree.signal(id, SIGTERM) }

        let deadline = Monotonic.deadline(after: spec.killGrace)
        while Monotonic.now() < deadline {
            let rootGone = state.withLock { $0.exited }
            if rootGone && snapshot.allSatisfy({ !ProcessTree.isLive($0) }) { return }
            usleep(20_000)
        }

        // Phase 2: SIGKILL, twice, to catch anything forked in between.
        var everSeen = Set(snapshot)
        for _ in 0..<2 {
            let rootRunning = !state.withLock { $0.exited }
            if rootRunning && leader { kill(-pid, SIGKILL) }
            let current = ProcessTree.descendants(of: pid)
            everSeen.formUnion(current)
            for id in everSeen { ProcessTree.signal(id, SIGKILL) }
            usleep(20_000)
        }
    }

    // MARK: completion

    /// Runs from `group.notify`, i.e. after the child exited and both readers returned, so nothing is
    /// using the descriptors any more.
    private func complete() {
        process.terminationHandler = nil
        // Release the two read descriptors now instead of whenever this object is deallocated. A
        // descendant still holding the write end gets EPIPE on its next write.
        try? outPipe.fileHandleForReading.close()
        try? errPipe.fileHandleForReading.close()
        let failure = state.withLock { $0.failure }
        if let failure { finish(.failure(failure)); return }
        let reason = process.terminationReason
        finish(.success(ProcessResult(
            stdout: stdout.data, stderr: stderr.data, status: process.terminationStatus,
            terminatedBySignal: reason == .uncaughtSignal,
            duration: Monotonic.seconds(from: startedAt))))
    }

    /// Resumes the continuation exactly once (a double resume traps at runtime).
    private func finish(_ result: Result<ProcessResult, Error>) {
        let cont = state.withLock { s -> CheckedContinuation<ProcessResult, Error>? in
            guard !s.finished else { return nil }
            s.finished = true
            s.timeoutTimer?.cancel(); s.timeoutTimer = nil
            s.insuranceTimer?.cancel(); s.insuranceTimer = nil
            defer { s.continuation = nil }
            return s.continuation
        }
        cont?.resume(with: result)
    }
}
