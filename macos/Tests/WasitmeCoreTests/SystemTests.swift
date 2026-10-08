import Foundation
import Testing
@testable import WasitmeCore

@Suite struct LaunchAgentPlistTests {
    private let app = "/Applications/Wasitme.app/Contents/MacOS/WasitmeApp"

    private func parsed(_ plist: LaunchAgentPlist) throws -> [String: Any] {
        let data = try plist.plistData()
        return try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    @Test func keepAliveOnlyAfterANonSuccessfulExit() throws {
        let d = try parsed(LaunchAgentPlist(programArguments: [app]))
        // `KeepAlive = { SuccessfulExit = false }`: crash restarts, a normal Quit stays quit.
        let keepAlive = try #require(d["KeepAlive"] as? [String: Any])
        #expect(keepAlive.count == 1)
        #expect(keepAlive["SuccessfulExit"] as? Bool == false)
        #expect(d["KeepAlive"] as? Bool == nil, "must not be the unconditional KeepAlive = true")
    }

    @Test func containsTheExpectedKeysAndNothingSurprising() throws {
        let d = try parsed(LaunchAgentPlist(programArguments: [app, "--supervised"]))
        #expect(d["Label"] as? String == "dev.wasitme.menubar")
        #expect(d["ProgramArguments"] as? [String] == [app, "--supervised"])
        #expect(d["RunAtLoad"] as? Bool == true)
        #expect(d["ThrottleInterval"] as? Int == 10)
        #expect(d["LimitLoadToSessionType"] as? String == "Aqua")
        #expect(Set(d.keys) == ["Label", "ProgramArguments", "RunAtLoad", "KeepAlive", "ThrottleInterval", "LimitLoadToSessionType"])
    }

    @Test func optionalKeysAppearOnlyWhenSet() throws {
        let d = try parsed(LaunchAgentPlist(
            label: "dev.example.x", programArguments: [app], runAtLoad: false, restartOnCrashOnly: false,
            limitToGUISession: false, standardOutPath: "/tmp/o.log", standardErrorPath: "/tmp/e.log",
            workingDirectory: "/tmp", environmentVariables: ["A": "1"]))
        #expect(d["KeepAlive"] == nil && d["LimitLoadToSessionType"] == nil)
        #expect(d["RunAtLoad"] as? Bool == false)
        #expect(d["StandardOutPath"] as? String == "/tmp/o.log")
        #expect(d["StandardErrorPath"] as? String == "/tmp/e.log")
        #expect(d["WorkingDirectory"] as? String == "/tmp")
        #expect(d["EnvironmentVariables"] as? [String: String] == ["A": "1"])
    }

    @Test func outputIsXmlAndDeterministic() throws {
        let p = LaunchAgentPlist(programArguments: [app], environmentVariables: ["B": "2", "A": "1", "C": "3"])
        let one = try p.plistData(), two = try p.plistData()
        #expect(one == two)
        let head = String(decoding: one.prefix(60), as: UTF8.self)
        #expect(head.hasPrefix("<?xml version=\"1.0\""))
    }

    @Test func specialCharactersSurviveTheRoundTrip() throws {
        let tricky = "/Applications/R&D <beta> \"x\".app/Contents/MacOS/WasitmeApp"
        let d = try parsed(LaunchAgentPlist(programArguments: [tricky, "a&b", "<c>"]))
        #expect(d["ProgramArguments"] as? [String] == [tricky, "a&b", "<c>"])
    }

    @Test(arguments: ["", "has space", "a/b", "a$b", "é", String(repeating: "a", count: 129), "semi;colon"])
    func invalidLabelsAreRejected(_ label: String) {
        #expect(throws: LaunchAgentPlist.ValidationError.invalidLabel) {
            try LaunchAgentPlist(label: label, programArguments: ["/bin/true"]).validate()
        }
    }

    @Test func invalidProgramsAreRejected() {
        #expect(throws: LaunchAgentPlist.ValidationError.noProgram) {
            try LaunchAgentPlist(programArguments: []).validate()
        }
        #expect(throws: LaunchAgentPlist.ValidationError.programNotAbsolute) {
            try LaunchAgentPlist(programArguments: ["WasitmeApp"]).validate()
        }
        #expect(throws: LaunchAgentPlist.ValidationError.programNotAbsolute) {
            try LaunchAgentPlist(programArguments: ["~/Applications/W.app/Contents/MacOS/W"]).validate()
        }
        #expect(throws: LaunchAgentPlist.ValidationError.invalidArgument(index: 1)) {
            try LaunchAgentPlist(programArguments: ["/bin/true", ""]).validate()
        }
        #expect(throws: LaunchAgentPlist.ValidationError.invalidArgument(index: 1)) {
            try LaunchAgentPlist(programArguments: ["/bin/true", "a\nb"]).validate()
        }
    }

    @Test func invalidPathsAndThrottleAreRejected() {
        #expect(throws: LaunchAgentPlist.ValidationError.invalidPath("standardOutPath")) {
            try LaunchAgentPlist(programArguments: ["/bin/true"], standardOutPath: "relative.log").validate()
        }
        #expect(throws: LaunchAgentPlist.ValidationError.invalidPath("workingDirectory")) {
            try LaunchAgentPlist(programArguments: ["/bin/true"], workingDirectory: "~/x").validate()
        }
        #expect(throws: LaunchAgentPlist.ValidationError.invalidThrottleInterval) {
            try LaunchAgentPlist(programArguments: ["/bin/true"], throttleInterval: 0).validate()
        }
        #expect(throws: LaunchAgentPlist.ValidationError.invalidThrottleInterval) {
            try LaunchAgentPlist(programArguments: ["/bin/true"], throttleInterval: 4000).validate()
        }
    }

    @Test func plistDataRefusesInvalidDefinitions() {
        #expect(throws: LaunchAgentPlist.ValidationError.self) { try LaunchAgentPlist(programArguments: []).plistData() }
    }

    @Test func locationsAreComputedFromAnInjectedHome() {
        let home = URL(fileURLWithPath: "/tmp/not-a-real-home", isDirectory: true)
        let dir = LaunchAgentPlist.userAgentsDirectory(home: home)
        #expect(dir.path == "/tmp/not-a-real-home/Library/LaunchAgents")
        let p = LaunchAgentPlist(label: "dev.example.agent", programArguments: ["/bin/true"])
        #expect(p.plistURL(in: dir).path == "/tmp/not-a-real-home/Library/LaunchAgents/dev.example.agent.plist")
    }

    /// Writes only into the directory it is handed (a temp dir here, never ~/Library).
    @Test func writesAtomicallyIntoTheGivenDirectoryOnly() throws {
        let dir = try TempDir("agent")
        let target = dir.file("nested/LaunchAgents")
        let p = LaunchAgentPlist(programArguments: ["/bin/true"])
        let url = try p.write(to: target)
        #expect(url.path == target.appendingPathComponent("dev.wasitme.menubar.plist").path)
        #expect(url.path.hasPrefix(dir.url.path))
        let first = try Data(contentsOf: url)
        #expect(first == (try p.plistData()))

        // Rewriting replaces the file with the new definition.
        var q = p
        q.programArguments = ["/bin/true", "--changed"]
        try q.write(to: target)
        let reread = try PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any]
        #expect(reread?["ProgramArguments"] as? [String] == ["/bin/true", "--changed"])
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: target.path)
        #expect(leftovers == ["dev.wasitme.menubar.plist"], "no temp files left behind")
    }

    @Test func invalidDefinitionWritesNothing() throws {
        let dir = try TempDir("agent-invalid")
        let target = dir.file("LaunchAgents")
        #expect(throws: LaunchAgentPlist.ValidationError.self) {
            try LaunchAgentPlist(programArguments: ["relative"]).write(to: target)
        }
        #expect(!FileManager.default.fileExists(atPath: target.path))
    }

    @Test(.enabled(if: FileManager.default.isExecutableFile(atPath: "/usr/bin/plutil"), "plutil not found"))
    func plutilAcceptsTheGeneratedFile() async throws {
        let dir = try TempDir("agent-plutil")
        let url = try LaunchAgentPlist(programArguments: ["/bin/true", "--x"], standardOutPath: "/tmp/o.log")
            .write(to: dir.url)
        let r = try await ProcessRunner.run(ProcessSpec(executable: URL(fileURLWithPath: "/usr/bin/plutil"),
                                                        arguments: ["-lint", url.path], environment: [:], timeout: 10))
        #expect(r.status == 0, "plutil said: \(String(decoding: r.stdout + r.stderr, as: UTF8.self))")
    }
}

@Suite struct LaunchAtLoginTests {
    @Test func stubStartsDisabledAndTogglesInMemory() throws {
        let s = StubLaunchAtLogin()
        #expect(s.status == .disabled && !s.isEnabled)
        try s.enable()
        #expect(s.status == .enabled && s.isEnabled)
        try s.disable()
        #expect(s.status == .disabled)
    }

    @Test func stubCanSimulateApprovalAndFailure() throws {
        #expect(StubLaunchAtLogin(initial: .requiresApproval).status == .requiresApproval)
        let failing = StubLaunchAtLogin(failWith: LaunchAtLoginError("refused"))
        #expect(throws: LaunchAtLoginError("refused")) { try failing.enable() }
        #expect(failing.status == .disabled, "a failed enable must not look enabled")
    }

    @Test func stubRecordsCallsAndCanLeaveApprovalPending() throws {
        let s = StubLaunchAtLogin(afterEnable: .requiresApproval)
        try s.enable()
        #expect(s.status == .requiresApproval && s.log == ["enable"])
    }

    /// No LaunchAgent: on registers (approved or waiting for approval), off unregisters, and a refusal says so.
    @Test func switchRegistersOnlyWhenAskedTo() {
        let stub = StubLaunchAtLogin()
        let sw = LaunchAtLoginSwitch(service: stub, launchAgentInstalled: { false })
        #expect(sw.state == .off && stub.log.isEmpty, "reading the state registers nothing")
        #expect(sw.set(true) == .on && sw.state == .on)
        #expect(sw.set(true) == .on && stub.log == ["enable"], "already on: nothing registered twice")
        #expect(sw.set(false) == .off && sw.state == .off && stub.log == ["enable", "disable"])
        #expect(sw.set(false) == .off && stub.log == ["enable", "disable"], "already off: nothing to undo")

        let pending = StubLaunchAtLogin(afterEnable: .requiresApproval)
        let p = LaunchAtLoginSwitch(service: pending, launchAgentInstalled: { false })
        #expect(p.set(true) == .needsApproval && p.state == .needsApproval)
        #expect(p.set(true) == .needsApproval && pending.log == ["enable"])
        #expect(p.set(false) == .off && pending.log == ["enable", "disable"], "a pending login item can be withdrawn")

        let refused = LaunchAtLoginSwitch(service: StubLaunchAtLogin(failWith: LaunchAtLoginError("refused")), launchAgentInstalled: { false })
        #expect(refused.set(true) == .failed("refused") && refused.state == .off)
        let unavailable = StubLaunchAtLogin(initial: .unavailable("no bundle"))
        let u = LaunchAtLoginSwitch(service: unavailable, launchAgentInstalled: { false })
        #expect(u.set(true) == .unavailable("no bundle") && u.state == .unavailable && unavailable.log.isEmpty)
        #expect(LaunchAtLoginOutcome.failed("x").state == .off && LaunchAtLoginOutcome.needsApproval.state == .needsApproval)
    }

    /// The installer's LaunchAgent already starts the app at login: the switch never adds a login item beside it (two
    /// copies at login), but it still removes one left from before.
    @Test func switchNeverDoublesTheInstallersLaunchAgent() {
        let stub = StubLaunchAtLogin()
        let sw = LaunchAtLoginSwitch(service: stub, launchAgentInstalled: { true })
        #expect(sw.state == .viaInstaller)
        #expect(sw.set(true) == .viaInstaller && stub.log.isEmpty && stub.status == .disabled)
        let leftover = StubLaunchAtLogin(initial: .enabled)
        let l = LaunchAtLoginSwitch(service: leftover, launchAgentInstalled: { true })
        #expect(l.set(false) == .viaInstaller && leftover.log == ["disable"] && leftover.status == .disabled)
    }

    /// The LaunchAgent is looked for under the given home only (tests: a temp folder, never the real ~/Library).
    @Test func looksForTheInstallersPlistUnderHome() throws {
        let tmp = try TempDir("login")
        let plist = LaunchAtLoginSwitch.installerAgentPlist(home: tmp.url)
        #expect(plist.path.hasSuffix("Library/LaunchAgents/\(WasitmeIdentity.launchAgentLabel).plist"))
        #expect(plist.path.hasPrefix(tmp.url.path))
        let sw = LaunchAtLoginSwitch.make(service: StubLaunchAtLogin(), home: tmp.url)
        #expect(sw.state == .off)
        try FileManager.default.createDirectory(at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("<plist/>".utf8).write(to: plist)
        #expect(sw.state == .viaInstaller)
    }

    @Test func realImplementationConformsButIsNeverCalledHere() {
        // Compile-time check that the SMAppService wrapper matches the interface. Calling it would
        // register a login item for the test runner, so it is deliberately not exercised.
        let type: any LaunchAtLoginControlling.Type = SMAppServiceLaunchAtLogin.self
        #expect(String(describing: type) == "SMAppServiceLaunchAtLogin")
    }
}
