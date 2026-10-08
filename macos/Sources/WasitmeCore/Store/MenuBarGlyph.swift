import Foundation

/// Where one contract file stands, as the store reports it.
public enum SourceStatus: Equatable, Sendable {
    case notLoaded
    case ok
    /// The file does not exist (the engine has not produced it yet, or the user deleted it).
    case missing
    /// Display rule 1 ("mismatch"): not a JSON object, or not the exact schema id (`wasitme.glance/1`).
    /// The UI shows `AppCopy.title(.mismatch)` and `AppCopy.detail(.mismatch)`; nothing from the file is shown.
    case updateNeeded(found: String)
    /// Display rule 2 ("refused"): the file does not declare `privacy.containsText: false`. Nothing from
    /// it is shown, and the last good value is dropped too (it would be shown as current).
    case refused(String)
    /// Unreadable or too large (an OS-level read problem). Carries a short reason with no file content.
    /// The store keeps the last good value; surfaces show it only as "last known", dimmed.
    case invalid(String)

    public var isOK: Bool { self == .ok }
}

/// The menu bar icon's state, independent of how it is drawn. The icon is the glance: it shows the
/// verdict STATE, never a number. Each case must be distinguishable by shape/label, not colour alone
/// (the UI layer maps these to symbols; that mapping is the designer's job).
public enum MenuBarGlyph: Equatable, Sendable, CaseIterable {
    /// First read has not finished.
    case loading
    /// The engine has not produced a glance yet (not installed / never scanned).
    case notSetUp
    /// Verdict `insufficient`: too early to tell (a first-class neutral state; also "Timeline only").
    case insufficient
    /// Verdict `none`: no detectable change.
    case noDetectableChange
    /// Verdict `you`: your side.
    case you
    /// Verdict `agent`: agent side.
    case agent
    /// Verdict `unclear`: can't tell which, or a state this app does not know.
    case unclear
    /// Display state `stale`: the glance is older than its `staleAfterSec`, future-dated, or has no timestamp.
    case stale
    /// Display rule 4: a current glance with no agents (no logs found yet). Not `unclear`: nothing was judged.
    case empty
    /// The file exists but could not be read (too large, not a regular file, I/O error).
    case error
    /// Display rule 1: not the exact schema id this app understands ("Update needed").
    case updateNeeded
    /// Display rule 2: the file does not declare itself text-free, so nothing from it is shown.
    case refused

    /// Pure resolution so every combination is unit-testable. Follows the contract's display rules
    /// (first match wins): mismatch, refused, stale, empty, then the first agent's state (engine order;
    /// there is no `primaryAgent`). `scanOk: false` does not change the glyph: it is a notice beside the
    /// state, and the menu bar draws the glyph dimmed (`scanOk` false; DESIGN.md §3).
    public static func resolve(status: SourceStatus, glance: Glance?, freshness: Freshness) -> MenuBarGlyph {
        switch status {
        case .notLoaded: return .loading
        case .missing: return .notSetUp
        case .updateNeeded: return .updateNeeded
        case .refused: return .refused
        case .invalid: return .error
        case .ok: break
        }
        guard let glance else { return .loading }
        if !freshness.isFresh { return .stale }
        switch glance.primary?.state {
        case .insufficient?: return .insufficient
        case .noDetectableChange?: return .noDetectableChange
        case .you?: return .you
        case .agent?: return .agent
        case .unclear?: return .unclear
        case nil: return .empty
        }
    }
}
