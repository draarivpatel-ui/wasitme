import Foundation
import ServiceManagement

/// Where launch-at-login stands. Mirrors `SMAppService.Status` without leaking the framework type.
public enum LaunchAtLoginStatus: Equatable, Sendable {
    /// Registered and will start at login.
    case enabled
    /// Not registered.
    case disabled
    /// Registered, but the user must approve it in System Settings > General > Login Items.
    case requiresApproval
    /// The system cannot find the app/service (not running from an installed app bundle).
    case notFound
    /// This implementation cannot answer (stub, or a framework error).
    case unavailable(String)
}

/// The system side of launch at login. An interface, so `LaunchAtLoginSwitch` and its tests never touch the real
/// system: tests use `StubLaunchAtLogin`; the app uses `SMAppServiceLaunchAtLogin`, and only when the user flips the
/// Settings switch (no test calls it).
public protocol LaunchAtLoginControlling: Sendable {
    var status: LaunchAtLoginStatus { get }
    /// Registers the app as a login item. Throws if the system refuses.
    func enable() throws
    func disable() throws
}

public extension LaunchAtLoginControlling {
    var isEnabled: Bool { status == .enabled }
}

/// In-memory implementation: remembers what it was told, touches nothing on the system.
public final class StubLaunchAtLogin: LaunchAtLoginControlling, @unchecked Sendable {
    private let lock = NSLock()
    private var current: LaunchAtLoginStatus
    private let failure: LaunchAtLoginError?
    private let afterEnable: LaunchAtLoginStatus
    private var calls: [String] = []

    /// `afterEnable`: the status a successful `enable()` leaves (`.requiresApproval` simulates a login item the user
    /// still has to allow in System Settings).
    public init(initial: LaunchAtLoginStatus = .disabled, failWith error: LaunchAtLoginError? = nil,
                afterEnable: LaunchAtLoginStatus = .enabled) {
        self.current = initial
        self.failure = error
        self.afterEnable = afterEnable
    }

    public var status: LaunchAtLoginStatus { lock.withLock { current } }
    /// "enable" / "disable", in call order (tests check that nothing is registered behind the user's back).
    public var log: [String] { lock.withLock { calls } }

    public func enable() throws {
        lock.withLock { calls.append("enable") }
        if let failure { throw failure }
        lock.withLock { current = afterEnable }
    }

    public func disable() throws {
        lock.withLock { calls.append("disable") }
        if let failure { throw failure }
        lock.withLock { current = .disabled }
    }
}

public struct LaunchAtLoginError: Error, Equatable, Sendable, CustomStringConvertible {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// `SMAppService.mainApp` wrapper (macOS 13+; this package targets 14+). The app calls it only from the user's own
/// click on the Settings switch (through `LaunchAtLoginSwitch`); no test calls it, because registering a login item
/// has system-wide side effects and needs an installed app bundle to behave.
public struct SMAppServiceLaunchAtLogin: LaunchAtLoginControlling {
    public init() {}

    public var status: LaunchAtLoginStatus {
        switch SMAppService.mainApp.status {
        case .enabled: .enabled
        case .notRegistered: .disabled
        case .requiresApproval: .requiresApproval
        case .notFound: .notFound
        @unknown default: .unavailable("unknown SMAppService status")
        }
    }

    public func enable() throws {
        do { try SMAppService.mainApp.register() }
        catch { throw LaunchAtLoginError(error.localizedDescription) }
    }

    public func disable() throws {
        do { try SMAppService.mainApp.unregister() }
        catch { throw LaunchAtLoginError(error.localizedDescription) }
    }
}

/// What the Settings switch shows. The raw value is the word the canvas reads (`view.launchAtLogin`).
public enum LaunchAtLoginState: String, Equatable, Sendable, CaseIterable {
    /// Registered and allowed: the app starts at login.
    case on
    case off
    /// Registered, but the user still has to allow it in System Settings > General > Login Items.
    case needsApproval
    /// The installer's LaunchAgent already starts the app at login (the "menu bar app" part of the install).
    case viaInstaller
    /// The system can't say (not an installed app bundle, or a framework error).
    case unavailable
}

/// What flipping the switch did. Every case says what is true afterwards; none claims more.
public enum LaunchAtLoginOutcome: Equatable, Sendable {
    case on
    case off
    /// Registered; the user has to allow it in System Settings (the app explains, and opens Login Items only on a click).
    case needsApproval
    /// Nothing changed: the installer's LaunchAgent starts the app at login, and a login item as well would start it twice.
    case viaInstaller
    case unavailable(String)
    case failed(String)

    public var state: LaunchAtLoginState {
        switch self {
        case .on: .on
        case .off, .failed: .off
        case .needsApproval: .needsApproval
        case .viaInstaller: .viaInstaller
        case .unavailable: .unavailable
        }
    }
}

/// The launch-at-login switch the Settings page calls through the bridge (`setLaunchAtLogin`).
///
/// Two ways the app can start at login, and they must not both be on:
///  - the installer's LaunchAgent (`~/Library/LaunchAgents/dev.wasitme.menubar.plist`, restarted only after a crash),
///    which the "menu bar app" part of the install adds;
///  - a login item (`SMAppService.mainApp`), which this switch adds.
/// While the LaunchAgent is installed the switch says so and never registers a login item (a second copy at login would
/// only hand off to the first and open its popover). Turning the switch off still removes a login item left from before,
/// so it can always undo itself.
public struct LaunchAtLoginSwitch: Sendable {
    public let service: any LaunchAtLoginControlling
    private let launchAgentInstalled: @Sendable () -> Bool

    public init(service: any LaunchAtLoginControlling, launchAgentInstalled: @escaping @Sendable () -> Bool) {
        self.service = service
        self.launchAgentInstalled = launchAgentInstalled
    }

    /// The installer's LaunchAgent plist for the menu bar app, under `home` (injectable: tests use a temp folder).
    public static func installerAgentPlist(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        LaunchAgentPlist.userAgentsDirectory(home: home)
            .appendingPathComponent("\(WasitmeIdentity.launchAgentLabel).plist", isDirectory: false)
    }

    /// A switch that looks for the installer's LaunchAgent under `home`.
    public static func make(service: any LaunchAtLoginControlling,
                            home: URL = FileManager.default.homeDirectoryForCurrentUser) -> LaunchAtLoginSwitch {
        let plist = installerAgentPlist(home: home).path
        return LaunchAtLoginSwitch(service: service, launchAgentInstalled: { FileManager.default.fileExists(atPath: plist) })
    }

    public var state: LaunchAtLoginState {
        if launchAgentInstalled() { return .viaInstaller }
        switch service.status {
        case .enabled: return .on
        case .disabled, .notFound: return .off
        case .requiresApproval: return .needsApproval
        case .unavailable: return .unavailable
        }
    }

    /// Turns launch at login on or off. Registers only when asked to turn it on and no LaunchAgent does that already.
    public func set(_ on: Bool) -> LaunchAtLoginOutcome {
        let before = service.status
        if case .unavailable(let why) = before { return .unavailable(why) }
        if on {
            if launchAgentInstalled() { return .viaInstaller }
            switch before {
            case .enabled: return .on
            case .requiresApproval: return .needsApproval
            case .disabled, .notFound, .unavailable: break
            }
            do { try service.enable() } catch { return .failed(Self.message(error)) }
            switch service.status {
            case .enabled: return .on
            case .requiresApproval: return .needsApproval
            case .unavailable(let why): return .unavailable(why)
            case .disabled, .notFound: return .failed("The system didn't keep wasitme as a login item.")
            }
        }
        if before == .enabled || before == .requiresApproval {
            do { try service.disable() } catch { return .failed(Self.message(error)) }
        }
        return launchAgentInstalled() ? .viaInstaller : .off
    }

    static func message(_ error: Error) -> String {
        let text = (error as? LaunchAtLoginError)?.message ?? String(describing: error)
        return text.isEmpty ? "The system refused." : text
    }
}
