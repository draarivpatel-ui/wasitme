import Foundation

/// What a glance-reading surface (menu bar, popover, desktop panel, Control Center chrome) shows,
/// decided ONCE by the contract's display rules (docs/CONTRACT.md#display-rules, first match wins).
/// `ok`, `stale`, `empty`, `mismatch` and `refused` are the contract's words; `loading`, `notSetUp` and
/// `unreadable` are the app's own file states (no document, or one the OS would not let us read).
public enum DocumentDisplay: String, Sendable, CaseIterable {
    case loading
    case notSetUp
    case unreadable
    /// Rule 1: not a JSON object, or not the exact schema id. Nothing from the document is shown.
    case mismatch
    /// Rule 2: `privacy.containsText` is not the boolean `false`. Nothing is shown.
    case refused
    /// Rule 3: too old, future-dated or no usable time. Last known states only, dimmed, never as current.
    case stale
    /// Rule 4: no agents.
    case empty
    /// Rule 5: each agent shows its state.
    case ok
}

/// One agent, with every engine string sanitized and bounded (TextSanitizer) and the app's fallback
/// label filled in. Views render these fields as plain text and never touch the raw `AgentGlance`.
public struct AgentDisplay: Equatable, Sendable, Identifiable {
    public let id: String
    public let agent: AgentID
    /// "Claude Code", "Codex", or the sanitized id of an agent this app doesn't know.
    public let name: String
    public let state: VerdictState
    public let reason: VerdictReason?
    public let pending: Bool
    public let calibrated: Bool
    /// False when this is only the last known state (stale or unreadable document): draw it dimmed.
    public let isCurrent: Bool
    /// The engine's label, or the DESIGN.md §3 fallback when it is empty. Never empty.
    public let stateText: String
    public let headline: String
    public let because: String
    public let tryThis: String
    public let confidence: String
    public let n: SampleCounts
    public let progress: Progress?
    public let metrics: [GlanceMetric]
    public let strip: Strip?
    /// Newest first, at most five (labels sanitized).
    public let events: [GlanceEvent]

    /// Verdicts for this agent are off until its own calibration passes ("Timeline only").
    public var timelineOnly: Bool { !calibrated }
    public var hasNewEvent: Bool { events.contains(where: \.isNew) }

    public init(_ a: AgentGlance, isCurrent: Bool) {
        id = a.agent.rawValue
        agent = a.agent
        name = Self.displayName(a.agent)
        state = a.state
        reason = a.reason
        pending = a.pending
        calibrated = a.calibrated
        self.isCurrent = isCurrent
        let label = TextSanitizer.clean(a.label, maxCharacters: 24)
        stateText = label.isEmpty ? AppCopy.stateLabel(a.state, reason: a.reason) : label
        headline = TextSanitizer.clean(a.headline, maxCharacters: 80)
        because = TextSanitizer.clean(a.because, maxCharacters: 200)
        tryThis = TextSanitizer.clean(a.tryThis, maxCharacters: 160)
        confidence = TextSanitizer.clean(a.confidence, maxCharacters: 160)
        n = a.n
        progress = a.progress.map { p in
            var p = p
            p.unlock = p.unlock.prefix(6).map { u in
                var u = u
                u.metric = TextSanitizer.clean(u.metric, maxCharacters: 32)
                return u
            }
            return p
        }
        metrics = a.topMetrics.prefix(3).map { m in
            var m = m
            m.id = TextSanitizer.clean(m.id, maxCharacters: 32)
            m.label = TextSanitizer.clean(m.label, maxCharacters: 40)
            m.unit = TextSanitizer.clean(m.unit, maxCharacters: 24)
            return m
        }
        strip = a.strip.map { s in
            var s = s
            s.metric = TextSanitizer.clean(s.metric, maxCharacters: 32)
            return s
        }
        events = a.events.prefix(5).map { e in
            var e = e
            e.label = TextSanitizer.clean(e.label, maxCharacters: 60)
            e.kind = TextSanitizer.clean(e.kind, maxCharacters: 24)
            e.day = TextSanitizer.clean(e.day, maxCharacters: 10)
            return e
        }
    }

    static func displayName(_ id: AgentID) -> String {
        let clean = TextSanitizer.clean(id.rawValue, maxCharacters: 32)
        switch clean {
        case AgentID.claudeCode.rawValue: return "Claude Code"
        case AgentID.codex.rawValue: return "Codex"
        default: return clean.isEmpty ? "Unknown agent" : clean
        }
    }
}

public extension Snapshot {
    /// The glance part of a snapshot ("the glance plus"): the same top-level fields and agent summaries,
    /// so the Control Center chrome uses the same display rules as the menu bar.
    var glancePart: Glance {
        Glance(schema: schema, engine: engine, generatedAt: generatedAt, staleAfterSec: staleAfterSec, scanOk: scanOk,
               scanError: scanError, demo: demo, lead: lead, agents: agents.map(\.summary), privacy: privacy)
    }
}

/// The full decision for one glance at one moment. Pure: the same inputs always give the same value,
/// so the live app (GlanceStore) and offscreen capture (manifest `now`) render identically.
public struct GlanceDisplay: Equatable, Sendable {
    public let document: DocumentDisplay
    public let freshness: Freshness
    /// `ok`: current states. `stale` / `unreadable`: last known states (isCurrent false). Otherwise empty.
    public let agents: [AgentDisplay]
    /// `scanOk: false` on a document that is shown: a notice beside the state, never instead of it.
    public let scanFailed: Bool
    public let scanError: ScanErrorKind?
    public let demo: Bool
    public let lead: Lead
    /// When the shown document was written (nil when nothing is shown or it has no usable time).
    public let generatedAt: Date?

    public init(document: DocumentDisplay, freshness: Freshness, agents: [AgentDisplay], scanFailed: Bool,
                scanError: ScanErrorKind?, demo: Bool, lead: Lead, generatedAt: Date? = nil) {
        self.document = document; self.freshness = freshness; self.agents = agents; self.scanFailed = scanFailed
        self.scanError = scanError; self.demo = demo; self.lead = lead; self.generatedAt = generatedAt
    }

    /// The display rules over the store's status and (last good) glance at `now`.
    public static func make(
        status: SourceStatus, glance: Glance?, now: Date,
        futureTolerance: TimeInterval = Freshness.defaultFutureTolerance
    ) -> GlanceDisplay {
        let freshness = Freshness.evaluate(generatedAt: glance?.generatedAt, now: now,
                                           staleAfter: TimeInterval(glance?.staleAfterSec ?? Glance.defaultStaleAfterSec),
                                           futureTolerance: futureTolerance)
        func blank(_ d: DocumentDisplay) -> GlanceDisplay {
            GlanceDisplay(document: d, freshness: .unknown, agents: [], scanFailed: false, scanError: nil,
                          demo: false, lead: .timeline)
        }
        func shown(_ d: DocumentDisplay, _ g: Glance, current: Bool) -> GlanceDisplay {
            GlanceDisplay(document: d, freshness: freshness, agents: g.agents.map { AgentDisplay($0, isCurrent: current) },
                          scanFailed: !g.scanOk, scanError: g.scanOk ? nil : (g.scanError ?? .internal),
                          demo: g.demo, lead: g.lead, generatedAt: g.generatedAt)
        }
        switch status {
        case .notLoaded: return blank(.loading)
        case .missing: return blank(.notSetUp)
        case .updateNeeded: return blank(.mismatch)
        case .refused: return blank(.refused)
        case .invalid:
            guard let glance else { return blank(.unreadable) }
            return shown(.unreadable, glance, current: false)
        case .ok:
            guard let glance else { return blank(.loading) }
            if !freshness.isFresh { return shown(.stale, glance, current: false) }
            if glance.agents.isEmpty { return shown(.empty, glance, current: true) }
            return shown(.ok, glance, current: true)
        }
    }

    // MARK: single-glyph surfaces (menu bar, desktop panel): they speak for agents[0]

    public var primary: AgentDisplay? { agents.first }

    public var glyph: MenuBarGlyph {
        switch document {
        case .loading: .loading
        case .notSetUp: .notSetUp
        case .unreadable: .error
        case .mismatch: .updateNeeded
        case .refused: .refused
        case .stale: .stale
        case .empty: .empty
        case .ok:
            switch primary?.state {
            case .insufficient?: .insufficient
            case .noDetectableChange?: .noDetectableChange
            case .you?: .you
            case .agent?: .agent
            case .unclear?, nil: .unclear
            }
        }
    }

    /// Menu bar: dims when stale (CONTRACT.md "Display rules"), when only a last known state is available, and when
    /// the last scan failed (`scanOk` false).
    public var glyphDimmed: Bool { scanFailed || document == .stale || document == .unreadable }

    /// The "+n" beside the glyph: only on a current document, for the agent the glyph speaks for.
    public var newEventMark: Bool { newEventCount > 0 }

    /// How many of the primary agent's events are new since the previous scan (0 unless the document is current).
    public var newEventCount: Int { document == .ok ? (primary?.events.filter(\.isNew).count ?? 0) : 0 }

    /// Short state words next to the glyph ("Too early to tell", "Out of date", "Update needed").
    public var stateText: String {
        document == .ok ? (primary?.stateText ?? AppCopy.stateLabel(.unclear, reason: nil)) : AppCopy.title(document)
    }

    /// VoiceOver label AND tooltip of the single-glyph surfaces (they are equal, and equal to
    /// the state text). Plain words only: no backticks or symbols a screen reader would spell out.
    public var accessibilityLabel: String {
        var parts = ["\(AppCopy.productName): \(stateText)"]
        switch document {
        case .stale, .unreadable:
            if let p = primary { parts.append("\(AppCopy.lastKnownPrefix): \(p.stateText)") }
        case .mismatch:
            parts.append("Run \(WasitmeIdentity.updateCommand)")
        default: break
        }
        if newEventMark { parts.append(AppCopy.newChanges(newEventCount)) }
        if scanFailed { parts.append(String(AppCopy.scanFailed(scanError).dropLast())) }   // its own ". " joins it
        return parts.joined(separator: ". ")
    }

    /// "Updated 4 min ago, local only" (popover footer, as design/system popover-*); just "local only" with no time.
    public var footer: String {
        switch document {
        case .ok, .stale, .empty, .unreadable: "\(AppCopy.updated(freshness)), \(AppCopy.localOnly)"
        default: AppCopy.localOnly
        }
    }

    /// "Local only · updated 4 min ago" (the Control Center sidebar's footer); just "Local only" with no time to give.
    public var sidebarFooter: String {
        func first(_ s: String, _ f: (String) -> String) -> String { s.isEmpty ? s : f(String(s.prefix(1))) + s.dropFirst() }
        let local = first(AppCopy.localOnly) { $0.uppercased() }
        switch document {
        case .ok, .stale, .empty, .unreadable: return "\(local) · \(first(AppCopy.updated(freshness)) { $0.lowercased() })"
        default: return local
        }
    }
}
