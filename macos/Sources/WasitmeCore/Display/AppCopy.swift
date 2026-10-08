import Foundation

/// The few words the APP owns. The engine owns every verdict word (CONTRACT.md "Display rules"): these cover only what
/// no document can say for itself (no file, a file the app won't show, an out-of-date file) and the
/// fallbacks used when an engine string is absent. The fallbacks are the engine's own state labels (DESIGN.md §3).
///
/// Kept in one place so the brand pass (WP-40) and the copy lint can review them together. No word here
/// may make a causal or quality claim (copy lint, DESIGN.md §3).
public enum AppCopy {
    public static let productName = "wasitme"

    /// The state labels (DESIGN.md §3), used only when the engine's `label` is empty.
    public static func stateLabel(_ state: VerdictState, reason: VerdictReason?) -> String {
        switch state {
        case .insufficient: reason == .calibrationPending ? "Timeline only" : "Too early to tell"
        case .noDetectableChange: "No detectable change"
        case .unclear: "Can't tell which"
        case .you: "Your side"
        case .agent: "Agent side"
        }
    }

    /// Title and one-line detail for every document-level display state.
    public static func title(_ d: DocumentDisplay) -> String {
        switch d {
        case .loading: "Loading"
        case .notSetUp: "Not set up yet"
        case .unreadable: "Can't read status"
        case .mismatch: "Update needed"
        case .refused: "Not shown"
        case .stale: "Out of date"
        case .empty: "No agents yet"
        case .ok: productName
        }
    }

    /// The line under `title`. A command is marked with backticks: the surfaces draw it as code and never show the
    /// backticks (WasitmeUI `commandText`); spoken and plain-text forms drop them (`spokenDetail`). It never repeats the title.
    public static func detail(_ d: DocumentDisplay) -> String {
        switch d {
        case .loading: "Reading wasitme's status file."
        case .notSetUp: "wasitme hasn't checked this Mac yet. Run `wasitme doctor` in Terminal."
        case .unreadable: "wasitme's status file couldn't be read. Run `wasitme doctor` in Terminal."
        case .mismatch: "This version can't read the status file's format. Run `\(WasitmeIdentity.updateCommand)` in Terminal."
        case .refused: "The status file doesn't say it is free of text, so it isn't shown. Run `wasitme doctor` in Terminal."
        case .stale: "This is the last known state, not a current one."
        case .empty: "No Claude Code or Codex logs found yet. Different place? Run `wasitme doctor` in Terminal."
        case .ok: ""
        }
    }

    /// Spoken form of `detail` for the states where the visual text has a command in backticks.
    public static func spokenDetail(_ d: DocumentDisplay) -> String {
        detail(d).replacingOccurrences(of: "`", with: "")
    }

    /// Why the document is stale, from its freshness.
    public static func staleReason(_ f: Freshness) -> String {
        switch f {
        case .futureDated: "The status file is dated in the future. Check your Mac's clock."
        case .unknown: "The status file has no usable time."
        case .stale(let age): "Last updated \(duration(age)) ago."
        case .fresh: ""
        }
    }

    /// "Updated 4 min ago" (footer), from the document's age at render time.
    public static func updated(_ f: Freshness) -> String {
        switch f {
        case .fresh(let age), .stale(let age):
            age < 60 ? "Updated just now" : "Updated \(preciseDuration(age)) ago"     // "2 h 40 min" (design popover-stale)
        case .futureDated: "Update time is in the future"
        case .unknown: "Update time unknown"
        }
    }

    public static let localOnly = "local only"

    /// tokens.json states.newEvent.voiceOver without its leading ", " (one/other forms). WasitmeUITests checks it
    /// against the generated `Tokens.FindingState.newChangesVoiceOver`.
    public static func newChanges(_ n: Int) -> String {
        n == 1 ? "1 new change on the timeline" : "\(n) new changes on the timeline"
    }

    /// "+1 new change" / "+3 new changes" (desktop panel; a glance count, never the event's name).
    public static func newChangesShort(_ n: Int) -> String {
        n == 1 ? "+1 new change" : "+\(n) new changes"
    }

    /// Precise durations for sentences: "40 min", "2 h 40 min", "3 days".
    public static func preciseDuration(_ seconds: TimeInterval) -> String {
        let s = max(0, seconds.isFinite ? seconds : 0)
        if s < 3600 { return "\(max(1, Int(s / 60))) min" }
        if s < 48 * 3600 {
            let h = Int(s / 3600), m = Int(s.truncatingRemainder(dividingBy: 3600) / 60)
            return m == 0 ? "\(h) h" : "\(h) h \(m) min"
        }
        return "\(Int(s / 86_400)) days"
    }
    public static let demoRibbon = "DEMO DATA"
    public static let pendingNote = "Holding this state until the next check agrees."
    public static let lastKnownPrefix = "Last known"

    /// "Scan failed" (DESIGN.md §3): the last good state plus this notice. Where it is shown with a way to act, that is a
    /// separate control (`seeSources`), never a sentence pointing at a place with no way to get there.
    public static func scanFailed(_ kind: ScanErrorKind?) -> String {
        let why: String
        switch kind {
        case .permissionDenied?: why = " (permission denied)"
        case .writeFailed?: why = " (couldn't save results)"
        case .timeout?: why = " (timed out)"
        case .internal?, nil: why = ""
        }
        return "Last scan failed\(why)."
    }

    /// The control next to the scan-failed notice (the canvas's "See Sources" button).
    public static let seeSources = "See Sources"

    /// Compact durations: "4 min", "3 h", "2 days".
    public static func duration(_ seconds: TimeInterval) -> String {
        let s = max(0, seconds.isFinite ? seconds : 0)
        if s < 3600 { return "\(max(1, Int(s / 60))) min" }
        if s < 48 * 3600 { return "\(Int(s / 3600)) h" }
        return "\(Int(s / 86_400)) days"
    }

    /// Plain words for an event side (the chip next to an event).
    public static func side(_ side: ChangeSide) -> String {
        switch side {
        case .you: "you"
        case .agent: "agent"
        case .unknown: "unknown"
        case .meta: "wasitme"
        }
    }
}
