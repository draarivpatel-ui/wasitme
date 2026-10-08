import Darwin
import Foundation
import Testing
@testable import WasitmeCore

// These tests spawn real child processes. `/bin/sh -c` scripts are used as TEST FIXTURES only: the
// production runner never involves a shell. Suites are serialized to keep CPU use low.

private func sh(_ script: String, timeout: TimeInterval = 20, grace: TimeInterval = 1, maxOutput: Int = 8 * 1024 * 1024,
                env: [String: String] = ["PATH": "/usr/bin:/bin"], cwd: URL? = nil) -> ProcessSpec {
    ProcessSpec(executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", script], environment: env,
                currentDirectory: cwd, timeout: timeout, maxOutputBytes: maxOutput, killGrace: grace)
}

private func isAlive(_ pid: pid_t) -> Bool {
    if kill(pid, 0) == 0 { return true }
    return errno == EPERM
}

private func openDescriptorCount() -> Int {
    let bytes = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, nil, 0)
    return bytes > 0 ? Int(bytes) / MemoryLayout<proc_fdinfo>.size : 0
}

private func readPIDs(_ file: URL) -> [pid_t] {
    guard let text = try? String(contentsOf: file, encoding: .utf8) else { return [] }
    return text.split(whereSeparator: \.isNewline).compactMap { pid_t($0) }
}

@Suite(.serialized) struct ProcessRunnerTests {
    @Test func capturesStdoutStderrAndExitStatus() async throws {
        let r = try await ProcessRunner.run(sh("echo out; echo err 1>&2; exit 3"))
        #expect(String(decoding: r.stdout, as: UTF8.self) == "out\n")
        #expect(String(decoding: r.stderr, as: UTF8.self) == "err\n")
        #expect(r.status == 3)
        #expect(!r.terminatedBySignal)
    }

    @Test func childKilledBySignalIsReportedAsSuch() async throws {
        let r = try await ProcessRunner.run(sh("kill -9 $$"))
        #expect(r.terminatedBySignal)
        #expect(r.status == 9)
    }

    /// Regression for the deadlock the spike reproduced: waiting for exit before draining a pipe the
    /// child fills past ~64 KB hangs forever. Both pipes carry far more than a pipe buffer here.
    @Test(.timeLimit(.minutes(1))) func largeOutputOnBothPipesDoesNotDeadlock() async throws {
        let r = try await ProcessRunner.run(sh("head -c 600000 /dev/zero; head -c 300000 /dev/zero 1>&2"))
        #expect(r.stdout.count == 600_000)
        #expect(r.stderr.count == 300_000)
    }

    @Test func outputExactlyAtTheLimitIsAllowedOneByteOverFails() async throws {
        let ok = try await ProcessRunner.run(sh("head -c 1000 /dev/zero", maxOutput: 1000))
        #expect(ok.stdout.count == 1000)
        await #expect(throws: ProcessFailure.outputTooLarge(limitBytes: 1000)) {
            try await ProcessRunner.run(sh("head -c 1001 /dev/zero", maxOutput: 1000))
        }
    }

    /// Regression: when the child exits before its output has been read (a loaded machine, or the
    /// overflow sitting in the final pipe buffer), the overflow must still be an error. It used to be
    /// dropped because the child had already "exited", and the caller got a silently truncated success.
    @Test func overflowFoundAfterTheChildExitedIsStillAnError() async {
        var spec = sh("head -c 5000 /dev/zero", maxOutput: 1000)
        spec.readerStartDelay = 0.5          // the child is long gone when the reader first looks
        await #expect(throws: ProcessFailure.outputTooLarge(limitBytes: 1000)) {
            try await ProcessRunner.run(spec)
        }
    }

    @Test func slowReaderStillDeliversOutputThatFitsTheLimit() async throws {
        var spec = sh("head -c 500 /dev/zero; head -c 400 /dev/zero 1>&2", maxOutput: 1000)
        spec.readerStartDelay = 0.5
        let r = try await ProcessRunner.run(spec)
        #expect(r.stdout.count == 500 && r.stderr.count == 400)
        #expect(r.status == 0)
    }

    /// Regression for the flaky `EngineRunnerTests.outputIsBounded` (~1 in 9 under heavy.sh's background QoS): when a
    /// reader is first scheduled AFTER the whole post-exit window (default 1 s), it used to return without reading, so
    /// a 5,000-byte overflow came back as a success with nothing in it. Reproduced deterministically with a reader that
    /// starts 1.5 s late.
    @Test func overflowIsFoundWhenTheReaderStartsAfterTheDrainWindow() async {
        var spec = sh("head -c 5000 /dev/zero", maxOutput: 1000)
        spec.readerStartDelay = 1.5
        await #expect(throws: ProcessFailure.outputTooLarge(limitBytes: 1000)) {
            try await ProcessRunner.run(spec)
        }
    }

    @Test func outputIsCollectedWhenTheReaderStartsAfterTheDrainWindow() async throws {
        var spec = sh("head -c 500 /dev/zero; head -c 400 /dev/zero 1>&2", maxOutput: 1000)
        spec.readerStartDelay = 1.5
        let r = try await ProcessRunner.run(spec)
        #expect(r.stdout.count == 500 && r.stderr.count == 400)
    }

    @Test func limitIsSharedBetweenStdoutAndStderr() async {
        await #expect(throws: ProcessFailure.outputTooLarge(limitBytes: 1000)) {
            try await ProcessRunner.run(sh("head -c 600 /dev/zero; head -c 600 /dev/zero 1>&2", maxOutput: 1000))
        }
    }

    @Test(.timeLimit(.minutes(1))) func endlessProducerIsStoppedAtTheLimit() async {
        let start = Monotonic.now()
        await #expect(throws: ProcessFailure.outputTooLarge(limitBytes: 100_000)) {
            try await ProcessRunner.run(sh("exec yes", maxOutput: 100_000))
        }
        #expect(Monotonic.seconds(from: start) < 10)
    }

    @Test func timeoutKillsTheChildAndEveryDescendant() async throws {
        let dir = try TempDir("proc-timeout")
        let pids = dir.file("pids")
        let script = "sleep 60 & echo $! >> '\(pids.path)'; (sleep 60 & echo $! >> '\(pids.path)'; wait) & wait"
        let start = Monotonic.now()
        await #expect(throws: ProcessFailure.timedOut(after: 0.6)) {
            try await ProcessRunner.run(sh(script, timeout: 0.6, grace: 1))
        }
        #expect(Monotonic.seconds(from: start) < 8)
        let children = readPIDs(pids)
        #expect(children.count == 2, "script should have recorded two grandchildren, got \(children)")
        for pid in children {
            #expect(await waitUntil(timeout: 3) { !isAlive(pid) }, "descendant \(pid) survived the timeout")
        }
    }

    @Test func termIgnoringTreeIsEscalatedToSigkill() async throws {
        let dir = try TempDir("proc-term")
        let pids = dir.file("pids")
        // `trap '' TERM` is inherited by children: nothing in this tree dies politely.
        let script = "trap '' TERM; sleep 60 & echo $! >> '\(pids.path)'; while :; do sleep 1; done"
        let start = Monotonic.now()
        await #expect(throws: ProcessFailure.timedOut(after: 0.4)) {
            try await ProcessRunner.run(sh(script, timeout: 0.4, grace: 0.5))
        }
        let elapsed = Monotonic.seconds(from: start)
        #expect(elapsed >= 0.4 + 0.5, "must wait out the grace period before SIGKILL, took \(elapsed)")
        #expect(elapsed < 8)
        for pid in readPIDs(pids) {
            #expect(await waitUntil(timeout: 3) { !isAlive(pid) }, "descendant \(pid) survived SIGKILL escalation")
        }
    }

    @Test(.enabled(if: FileManager.default.isExecutableFile(atPath: "/usr/bin/perl"), "perl is needed to call setsid"))
    func descendantThatLeftTheProcessGroupIsStillKilled() async throws {
        let dir = try TempDir("proc-escapee")
        let pids = dir.file("pids")
        // perl starts a new session (leaves the process group), then becomes `sleep`.
        let script = "/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec \"sleep\", \"60\"' & echo $! >> '\(pids.path)'; wait"
        await #expect(throws: ProcessFailure.timedOut(after: 0.6)) {
            try await ProcessRunner.run(sh(script, timeout: 0.6, grace: 0.5))
        }
        let escapee = try #require(readPIDs(pids).first)
        #expect(await waitUntil(timeout: 3) { !isAlive(escapee) }, "setsid escapee survived")
    }

    /// A SILENT grandchild that inherited the pipes and outlives the child must not hold the run open.
    /// (The pipe is idle, so the reader's idle check ends the run. A grandchild that keeps writing is
    /// the next test.)
    @Test(.timeLimit(.minutes(1))) func lingeringSilentGrandchildHoldingThePipeDoesNotHangTheRun() async throws {
        let start = Monotonic.now()
        let r = try await ProcessRunner.run(sh("(sleep 4 &); echo done"))
        #expect(String(decoding: r.stdout, as: UTF8.self) == "done\n")
        #expect(Monotonic.seconds(from: start) < 3, "returned after \(Monotonic.seconds(from: start)) s")
    }

    /// Regression: a grandchild that inherited the pipes and keeps WRITING (every 30 ms, for ~14 s)
    /// after the child exited. The pipe is never idle, so only a deadline checked on every read can end
    /// the run; it used to last as long as the writer did (14.3 s here, forever for an endless one).
    /// The run must come back inside timeout + grace with the child's own result, and the writer must
    /// be gone afterwards (its next write hits the closed pipe).
    @Test(.timeLimit(.minutes(1))) func chattyGrandchildHoldingThePipeCannotOutliveTheTimeout() async throws {
        let dir = try TempDir("proc-chatty")
        let pids = dir.file("pids")
        // The writer is its own `sh`, so its pid ($$) can be recorded and checked later.
        let writer = "echo $$ >> '\(pids.path)'; i=0; while [ $i -lt 400 ]; do echo x; sleep 0.03; i=$((i+1)); done"
        let script = "/bin/sh -c '\(writer)' & echo done"
        let timeout: TimeInterval = 1, grace: TimeInterval = 0.5
        let start = Monotonic.now()
        let r = try await ProcessRunner.run(sh(script, timeout: timeout, grace: grace))
        let elapsed = Monotonic.seconds(from: start)
        #expect(elapsed < timeout + grace + 1, "returned after \(elapsed) s; the writer would have run for ~14 s")
        #expect(r.status == 0 && !r.terminatedBySignal, "the child's own result stands")
        #expect(String(decoding: r.stdout, as: UTF8.self).hasPrefix("done\n"))
        let writerPID = try #require(readPIDs(pids).first)
        #expect(await waitUntil(timeout: 3) { !isAlive(writerPID) }, "the writer kept running after its pipe was closed")
    }

    /// The post-exit drain window is also capped by the timeout: a generous window must not let the run
    /// outlast `timeout`.
    @Test(.timeLimit(.minutes(1))) func postExitDrainIsCappedByTheTimeout() async throws {
        let script = "(i=0; while [ $i -lt 400 ]; do echo x; sleep 0.03; i=$((i+1)); done) & echo done"
        var spec = sh(script, timeout: 1, grace: 0.5)
        spec.postExitDrain = 30
        let start = Monotonic.now()
        let r = try await ProcessRunner.run(spec)
        let elapsed = Monotonic.seconds(from: start)
        #expect(elapsed < 2, "returned after \(elapsed) s with a 30 s drain window and a 1 s timeout")
        #expect(r.status == 0)
    }

    /// A finished run must not keep its Process and Pipes (two file descriptors) alive until its
    /// timeout would have fired. With the default 60 s timeout, 50 runs used to leave ~100 descriptors
    /// open; a menu-bar app's soft limit can be as low as 256. The threshold is loose because other
    /// suites run in parallel and open descriptors of their own.
    @Test(.timeLimit(.minutes(1))) func finishedRunsReleaseTheirDescriptors() async throws {
        _ = try await ProcessRunner.run(sh("echo warm-up", timeout: 60))
        let before = openDescriptorCount()
        for _ in 0..<50 { _ = try await ProcessRunner.run(sh("echo x", timeout: 60)) }
        let after = openDescriptorCount()
        #expect(after - before < 10, "descriptors went from \(before) to \(after) over 50 finished runs")
    }

    @Test func durationIsMeasuredOnAMonotonicClock() async throws {
        let r = try await ProcessRunner.run(sh("sleep 0.3"))
        #expect(r.duration >= 0.25 && r.duration < 10, "duration \(r.duration)")
    }

    @Test func cancellationKillsTheTreeAndReportsCancelled() async throws {
        let dir = try TempDir("proc-cancel")
        let pids = dir.file("pids")
        let script = "sleep 60 & echo $! >> '\(pids.path)'; wait"
        let task = Task { try await ProcessRunner.run(sh(script, timeout: 60, grace: 0.5)) }
        #expect(await waitUntil { readPIDs(pids).count == 1 })
        task.cancel()
        await #expect(throws: ProcessFailure.cancelled) { try await task.value }
        for pid in readPIDs(pids) {
            #expect(await waitUntil(timeout: 3) { !isAlive(pid) })
        }
    }

    @Test func cancellingBeforeTheRunStartsNeverLaunchesAnything() async throws {
        let dir = try TempDir("proc-precancel")
        let marker = dir.file("ran")
        let task = Task {
            // Already cancelled by the time we get here.
            while !Task.isCancelled { await Task.yield() }
            return try await ProcessRunner.run(sh("touch '\(marker.path)'"))
        }
        task.cancel()
        _ = try? await task.value
        try await Task.sleep(for: .milliseconds(300))
        #expect(!FileManager.default.fileExists(atPath: marker.path))
    }

    @Test func missingExecutableIsALaunchFailureNotACrash() async {
        let spec = ProcessSpec(executable: URL(fileURLWithPath: "/nonexistent/definitely-not-here"))
        do {
            _ = try await ProcessRunner.run(spec)
            Issue.record("expected a launch failure")
        } catch let failure as ProcessFailure {
            guard case .launchFailed = failure else { Issue.record("got \(failure)"); return }
        } catch {
            Issue.record("unexpected error \(error)")
        }
    }

    @Test func childGetsExactlyTheEnvironmentItWasGiven() async throws {
        let spec = ProcessSpec(executable: URL(fileURLWithPath: "/usr/bin/env"), environment: ["ONLY_THIS": "1"])
        let r = try await ProcessRunner.run(spec)
        #expect(String(decoding: r.stdout, as: UTF8.self) == "ONLY_THIS=1\n")
    }

    @Test func stdinIsClosedSoReadersDoNotBlock() async throws {
        let r = try await ProcessRunner.run(sh("cat; echo after"))
        #expect(String(decoding: r.stdout, as: UTF8.self) == "after\n")
    }

    @Test func workingDirectoryIsHonoured() async throws {
        let dir = try TempDir("proc-cwd")
        let r = try await ProcessRunner.run(sh("pwd -P", cwd: dir.url))
        let printed = String(decoding: r.stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        #expect(URL(fileURLWithPath: printed).resolvingSymlinksInPath() == dir.url.resolvingSymlinksInPath())
    }

    @Test func manyQuickRunsInARowAreStable() async throws {
        for i in 0..<25 {
            let r = try await ProcessRunner.run(sh("echo \(i)"))
            #expect(String(decoding: r.stdout, as: UTF8.self) == "\(i)\n")
        }
    }
}

@Suite(.serialized) struct ProcessTreeTests {
    @Test func descendantsIncludeRootChildrenAndGrandchildren() async throws {
        let dir = try TempDir("tree")
        let pids = dir.file("pids")
        // First line: the root shell's own pid. Then a child `sleep` and a grandchild `sleep`
        // (started inside a subshell, which is itself a child of the root).
        let script = "echo $$ > '\(pids.path)'; sleep 30 & echo $! >> '\(pids.path)'; (sleep 30 & echo $! >> '\(pids.path)'; wait) & wait"
        let task = Task { try? await ProcessRunner.run(sh(script, timeout: 30, grace: 0.3)) }
        #expect(await waitUntil { readPIDs(pids).count == 3 })
        let recorded = readPIDs(pids)
        let root = try #require(recorded.first)
        let found = ProcessTree.descendants(of: root).map(\.pid)
        #expect(found.first == root, "the root comes first (breadth first)")
        for pid in recorded { #expect(found.contains(pid), "descendants missed \(pid)") }
        #expect(ProcessTree.parent(of: recorded[1]) == root)
        task.cancel()
        _ = await task.value
    }

    @Test func aRecycledPidIsNeverSignalled() async throws {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        try child.run()
        defer { child.terminate(); child.waitUntilExit() }
        let real = try #require(ProcessTree.identity(of: child.processIdentifier))
        let forged = ProcessIdentity(pid: real.pid, startSeconds: real.startSeconds &- 1, startMicroseconds: real.startMicroseconds)
        #expect(ProcessTree.isLive(real))
        #expect(!ProcessTree.isLive(forged))
        #expect(!ProcessTree.signal(forged, SIGKILL))
        try await Task.sleep(for: .milliseconds(100))
        #expect(child.isRunning, "a mismatched identity must not signal the live process")
        #expect(ProcessTree.signal(real, SIGKILL))
    }

    @Test func zombiesAndMissingProcessesAreNotLive() async throws {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try child.run()
        let id = ProcessTree.identity(of: child.processIdentifier)
        child.waitUntilExit()
        if let id { #expect(await waitUntil(timeout: 2) { !ProcessTree.isLive(id) }) }
        #expect(ProcessTree.identity(of: 0) == nil)
        #expect(ProcessTree.children(of: 999_999).isEmpty)
    }
}

@Suite struct MonotonicClockTests {
    @Test func neverGoesBackwardsAndNeverYieldsANegativeDuration() {
        let a = Monotonic.now()
        let b = Monotonic.now()
        #expect(b >= a)
        #expect(Monotonic.seconds(from: a, to: b) >= 0)
        // Out-of-order arguments (what a backwards clock would produce) clamp to zero, never trap.
        #expect(Monotonic.seconds(from: b &+ 5_000_000_000, to: a) == 0)
        #expect(Monotonic.seconds(from: 10, to: 3) == 0)
    }

    @Test func secondsConvertToNanosecondsWithoutOverflow() {
        #expect(Monotonic.nanoseconds(1.5) == 1_500_000_000)
        #expect(Monotonic.nanoseconds(0) == 0)
        #expect(Monotonic.nanoseconds(-3) == 0)
        #expect(Monotonic.nanoseconds(.nan) == 0)
        #expect(Monotonic.nanoseconds(.infinity) > 0)                 // clamped, not a trap
        #expect(Monotonic.deadline(after: .infinity) > Monotonic.now())
        #expect(Monotonic.deadline(after: -1) <= Monotonic.now())
    }

    @Test func postExitDrainWindowIsBoundedByTheDrainSettingTheTimeoutAndAFloor() {
        let floor = PostExitDrain.floor
        #expect(PostExitDrain.window(drain: 1, timeout: 60, elapsed: 0.2) == 1)          // plenty of time left
        #expect(PostExitDrain.window(drain: 1, timeout: 1, elapsed: 0.4) == 0.6)         // capped by the timeout
        #expect(PostExitDrain.window(drain: 1, timeout: 1, elapsed: 0.99) == floor)      // edge: floor, not ~0
        #expect(PostExitDrain.window(drain: 1, timeout: 1, elapsed: 5) == floor)         // already past it
        #expect(PostExitDrain.window(drain: 0.05, timeout: 60, elapsed: 0) == 0.05)      // the setting wins below the floor
        #expect(PostExitDrain.window(drain: -1, timeout: 60, elapsed: 0) == 0)
    }
}
