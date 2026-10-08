import Foundation

/// A launchd LaunchAgent definition for running the menu bar app under supervision (the dogfooding
/// path, D18): launchd restarts it after a crash but leaves it stopped after a normal Quit.
///
/// This type is PURE: it builds plist data and computes paths, and writes nothing unless you call
/// `write(to:)` with an explicit directory. Nothing in this package registers or loads an agent
/// (`launchctl`) and no test writes under `~/Library`.
///
/// Do not combine this with the launch-at-login helper (`LaunchAtLoginControlling`): choose one
/// mechanism, or the app would be started twice at login.
public struct LaunchAgentPlist: Equatable, Sendable {
    public var label: String
    /// Absolute path to the executable first, then its arguments. launchd does NOT use a shell, so
    /// there is no quoting, expansion or `~`.
    public var programArguments: [String]
    public var runAtLoad: Bool
    /// `KeepAlive = { SuccessfulExit = false }`: restart only after a non-zero exit or a crash. A
    /// normal Quit (exit 0) stays quit.
    public var restartOnCrashOnly: Bool
    /// Minimum seconds between launches, so a crash loop cannot spin the CPU.
    public var throttleInterval: Int
    /// Only start in a graphical login session. Without this, a KeepAlive agent that needs the window
    /// server would crash-loop in non-GUI sessions (SSH, background).
    public var limitToGUISession: Bool
    public var standardOutPath: String?
    public var standardErrorPath: String?
    public var workingDirectory: String?
    public var environmentVariables: [String: String]

    public init(
        label: String = WasitmeIdentity.launchAgentLabel,
        programArguments: [String],
        runAtLoad: Bool = true,
        restartOnCrashOnly: Bool = true,
        throttleInterval: Int = 10,
        limitToGUISession: Bool = true,
        standardOutPath: String? = nil,
        standardErrorPath: String? = nil,
        workingDirectory: String? = nil,
        environmentVariables: [String: String] = [:]
    ) {
        self.label = label; self.programArguments = programArguments; self.runAtLoad = runAtLoad
        self.restartOnCrashOnly = restartOnCrashOnly; self.throttleInterval = throttleInterval
        self.limitToGUISession = limitToGUISession; self.standardOutPath = standardOutPath
        self.standardErrorPath = standardErrorPath; self.workingDirectory = workingDirectory
        self.environmentVariables = environmentVariables
    }

    public enum ValidationError: Error, Equatable, Sendable, CustomStringConvertible {
        case invalidLabel
        case noProgram
        case programNotAbsolute
        case invalidArgument(index: Int)
        case invalidPath(String)
        case invalidThrottleInterval

        public var description: String {
            switch self {
            case .invalidLabel: "label must be 1-128 characters of letters, digits, '.', '_' or '-'"
            case .noProgram: "programArguments must not be empty"
            case .programNotAbsolute: "the program must be an absolute path (launchd does not expand ~ or search PATH)"
            case .invalidArgument(let i): "program argument \(i) is empty or contains a control character"
            case .invalidPath(let key): "\(key) must be an absolute path without control characters"
            case .invalidThrottleInterval: "throttleInterval must be between 1 and 3600 seconds"
            }
        }
    }

    public func validate() throws {
        guard (1...128).contains(label.count),
              label.unicodeScalars.allSatisfy({ ($0.isASCII && ($0.properties.isAlphabetic || ("0"..."9").contains($0))) || $0 == "." || $0 == "_" || $0 == "-" })
        else { throw ValidationError.invalidLabel }
        guard let program = programArguments.first else { throw ValidationError.noProgram }
        guard program.hasPrefix("/") else { throw ValidationError.programNotAbsolute }
        for (i, argument) in programArguments.enumerated() {
            guard !argument.isEmpty, !Self.hasControlCharacter(argument) else { throw ValidationError.invalidArgument(index: i) }
        }
        for (key, path) in [("standardOutPath", standardOutPath), ("standardErrorPath", standardErrorPath),
                            ("workingDirectory", workingDirectory)] {
            if let path, !(path.hasPrefix("/") && !Self.hasControlCharacter(path)) { throw ValidationError.invalidPath(key) }
        }
        guard (1...3600).contains(throttleInterval) else { throw ValidationError.invalidThrottleInterval }
    }

    /// The plist as a Foundation dictionary (what `plistData()` serialises).
    public func dictionary() -> [String: Any] {
        var d: [String: Any] = [
            "Label": label,
            "ProgramArguments": programArguments,
            "RunAtLoad": runAtLoad,
            "ThrottleInterval": throttleInterval,
        ]
        if restartOnCrashOnly { d["KeepAlive"] = ["SuccessfulExit": false] }
        if limitToGUISession { d["LimitLoadToSessionType"] = "Aqua" }
        if let standardOutPath { d["StandardOutPath"] = standardOutPath }
        if let standardErrorPath { d["StandardErrorPath"] = standardErrorPath }
        if let workingDirectory { d["WorkingDirectory"] = workingDirectory }
        if !environmentVariables.isEmpty { d["EnvironmentVariables"] = environmentVariables }
        return d
    }

    /// XML property list bytes (validated first).
    public func plistData() throws -> Data {
        try validate()
        return try PropertyListSerialization.data(fromPropertyList: dictionary(), format: .xml, options: 0)
    }

    // MARK: locations and writing (explicit directories only)

    /// `<home>/Library/LaunchAgents` (the per-user agents directory).
    public static func userAgentsDirectory(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        home.appendingPathComponent("Library", isDirectory: true).appendingPathComponent("LaunchAgents", isDirectory: true)
    }

    /// Where launchd expects this agent's file inside `directory`: `<label>.plist`.
    public func plistURL(in directory: URL) -> URL {
        directory.appendingPathComponent("\(label).plist", isDirectory: false)
    }

    /// Writes `<label>.plist` atomically into `directory` (created if needed) and returns its URL.
    /// Does not call launchctl; loading the agent is a separate, deliberate step.
    @discardableResult
    public func write(to directory: URL) throws -> URL {
        let data = try plistData()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = plistURL(in: directory)
        try data.write(to: url, options: .atomic)
        return url
    }

    private static func hasControlCharacter(_ s: String) -> Bool {
        s.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7F }
    }
}
