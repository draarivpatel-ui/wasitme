import Foundation

/// `wasitme.glance/1` (frozen; docs/CONTRACT.md): the small file behind the menu bar glyph, popover and
/// desktop panel, written to `~/.wasitme/glance.json`. Decoding is tolerant by construction; see
/// `Tolerant.swift` and `Vocabulary.swift`.
///
/// Missing fields take the "makes no claim" value: `scanOk` -> false, `generatedAt` -> nil (unknown age,
/// shown as stale), `staleAfterSec` -> 7,200, `lead` -> `.timeline`, `demo`/`pending`/`calibrated` -> false,
/// strings -> "", `state` -> `.unclear`, `reason` -> nil.
public struct Glance: Equatable, Sendable, Codable {
    public static let defaultStaleAfterSec = 7200

    public var schema: String
    public var engine: String?
    public var generatedAt: Date?
    /// Show `stale` once now − generatedAt exceeds this many seconds.
    public var staleAfterSec: Int
    public var scanOk: Bool
    public var scanError: ScanErrorKind?
    /// `wasitme demo` output: surfaces show a DEMO ribbon.
    public var demo: Bool
    public var lead: Lead
    /// Engine order: the first agent is the one a single-glyph surface speaks for.
    public var agents: [AgentGlance]
    public var privacy: PrivacyDeclaration?

    public init(
        schema: String = "wasitme.glance/1", engine: String? = nil, generatedAt: Date? = nil,
        staleAfterSec: Int = Glance.defaultStaleAfterSec, scanOk: Bool = true, scanError: ScanErrorKind? = nil,
        demo: Bool = false, lead: Lead = .timeline, agents: [AgentGlance] = [],
        privacy: PrivacyDeclaration? = PrivacyDeclaration(containsText: false)
    ) {
        self.schema = schema; self.engine = engine; self.generatedAt = generatedAt
        self.staleAfterSec = staleAfterSec; self.scanOk = scanOk; self.scanError = scanError
        self.demo = demo; self.lead = lead; self.agents = agents; self.privacy = privacy
    }

    enum CodingKeys: String, CodingKey {
        case schema, engine, generatedAt, staleAfterSec, scanOk, scanError, demo, lead, agents, privacy
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schema = try c.decode(String.self, forKey: .schema)   // the one hard requirement: version must be known
        engine = c.lossy(String.self, .engine)
        generatedAt = c.lossyDate(.generatedAt)
        staleAfterSec = Self.sanitizedStaleAfter(c.lossy(Int.self, .staleAfterSec))
        scanOk = c.lossy(Bool.self, .scanOk) ?? false
        scanError = scanOk ? nil : c.lossy(ScanErrorKind.self, .scanError)
        demo = c.lossy(Bool.self, .demo) ?? false
        lead = c.lossy(Lead.self, .lead) ?? .timeline
        agents = c.lossyArray(AgentGlance.self, .agents)
        privacy = c.lossy(PrivacyDeclaration.self, .privacy)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(schema, forKey: .schema)
        try c.encodeIfPresent(engine, forKey: .engine)
        try c.encodeDate(generatedAt, forKey: .generatedAt)
        try c.encode(staleAfterSec, forKey: .staleAfterSec)
        try c.encode(scanOk, forKey: .scanOk)
        try c.encode(scanError, forKey: .scanError)
        try c.encode(demo, forKey: .demo)
        try c.encode(lead, forKey: .lead)
        try c.encode(agents, forKey: .agents)
        try c.encodeIfPresent(privacy, forKey: .privacy)
    }

    /// The contract allows 60...604,800 s; anything else (or nothing) falls back to the 2-hour default.
    static func sanitizedStaleAfter(_ raw: Int?) -> Int {
        guard let raw, (60...604_800).contains(raw) else { return defaultStaleAfterSec }
        return raw
    }

    public var compatibility: SchemaCompatibility { .check(schema, expecting: .glance) }

    /// The agent a single-glyph surface speaks for: the first one, in the engine's order.
    public var primary: AgentGlance? { agents.first }
}

public struct AgentGlance: Equatable, Sendable, Codable, Identifiable {
    public var agent: AgentID
    public var state: VerdictState
    public var reason: VerdictReason?
    /// A state change is waiting for a second agreeing evaluation; `state` is the held one.
    public var pending: Bool
    /// False: this agent's verdicts are off until its own calibration passes ("Timeline only").
    public var calibrated: Bool
    /// Engine-owned words. Empty when absent.
    public var label: String
    public var headline: String
    public var because: String
    public var tryThis: String
    public var confidence: String
    /// The Claude Code band line; empty unless band-eligible.
    public var band: String
    public var statusLine: String
    public var n: SampleCounts
    public var progress: Progress?
    public var topMetrics: [GlanceMetric]
    public var strip: Strip?
    /// Newest first, at most five.
    public var events: [GlanceEvent]

    public var id: String { agent.rawValue }

    public init(
        agent: AgentID, state: VerdictState, reason: VerdictReason? = nil, pending: Bool = false,
        calibrated: Bool = true, label: String = "", headline: String = "", because: String = "",
        tryThis: String = "", confidence: String = "", band: String = "", statusLine: String = "",
        n: SampleCounts = SampleCounts(), progress: Progress? = nil, topMetrics: [GlanceMetric] = [],
        strip: Strip? = nil, events: [GlanceEvent] = []
    ) {
        self.agent = agent; self.state = state; self.reason = reason; self.pending = pending
        self.calibrated = calibrated; self.label = label; self.headline = headline; self.because = because
        self.tryThis = tryThis; self.confidence = confidence; self.band = band; self.statusLine = statusLine
        self.n = n; self.progress = progress; self.topMetrics = topMetrics; self.strip = strip; self.events = events
    }

    enum CodingKeys: String, CodingKey {
        case agent, state, reason, pending, calibrated, label, headline, because, tryThis, confidence, band
        case statusLine, n, progress, topMetrics, strip, events
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agent = try c.decode(AgentID.self, forKey: .agent)    // without an agent id the entry is dropped
        state = c.lossy(VerdictState.self, .state) ?? .unclear
        reason = c.lossy(VerdictReason.self, .reason)
        pending = c.lossy(Bool.self, .pending) ?? false
        calibrated = c.lossy(Bool.self, .calibrated) ?? false
        label = c.lossy(String.self, .label) ?? ""
        headline = c.lossy(String.self, .headline) ?? ""
        because = c.lossy(String.self, .because) ?? ""
        tryThis = c.lossy(String.self, .tryThis) ?? ""
        confidence = c.lossy(String.self, .confidence) ?? ""
        band = c.lossy(String.self, .band) ?? ""
        statusLine = c.lossy(String.self, .statusLine) ?? ""
        n = c.lossy(SampleCounts.self, .n) ?? SampleCounts()
        progress = c.lossy(Progress.self, .progress)
        topMetrics = c.lossyArray(GlanceMetric.self, .topMetrics)
        strip = c.lossy(Strip.self, .strip)
        events = c.lossyArray(GlanceEvent.self, .events)
    }
}

/// "Based on N exchanges over D session-days (S sessions)": the sample size shown next to every number.
public struct SampleCounts: Equatable, Sendable, Codable {
    public var exchanges: Int?
    public var sessions: Int?
    public var sessionDays: Int?
    public var days: Int?

    public init(exchanges: Int? = nil, sessions: Int? = nil, sessionDays: Int? = nil, days: Int? = nil) {
        self.exchanges = exchanges; self.sessions = sessions; self.sessionDays = sessionDays; self.days = days
    }

    enum CodingKeys: String, CodingKey { case exchanges, sessions, sessionDays, days }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        exchanges = c.lossy(Int.self, .exchanges)
        sessions = c.lossy(Int.self, .sessions)
        sessionDays = c.lossy(Int.self, .sessionDays)
        days = c.lossy(Int.self, .days)
    }
}

/// Gate counts for one shortfall (METHOD.md §13): shown in sessions and session-days.
public struct GateCounts: Equatable, Sendable, Codable {
    public var events: Int?
    public var sessions: Int?
    public var sessionDays: Int?

    public init(events: Int? = nil, sessions: Int? = nil, sessionDays: Int? = nil) {
        self.events = events; self.sessions = sessions; self.sessionDays = sessionDays
    }

    enum CodingKeys: String, CodingKey { case events, sessions, sessionDays }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        events = c.lossy(Int.self, .events)
        sessions = c.lossy(Int.self, .sessions)
        sessionDays = c.lossy(Int.self, .sessionDays)
    }

    /// The count of one unit (nil when the document did not carry it).
    public subscript(unit: GateUnit) -> Int? {
        switch unit {
        case .sessions: return sessions
        case .sessionDays: return sessionDays
        case .events: return events
        }
    }
}

/// One unit of an unlock item's gate counts, in the gate's own order (a tie goes to the earlier one).
public enum GateUnit: String, Sendable, CaseIterable {
    case sessions, sessionDays, events
}

/// The one pair an unlock counter shows: its unit, its count and its target ("7 of 10 session-days").
public struct GatePair: Equatable, Sendable {
    public let unit: GateUnit
    public let have: Int
    public let need: Int

    public init(unit: GateUnit, have: Int, need: Int) {
        self.unit = unit; self.have = have; self.need = need
    }

    /// 0...1: how far the count is toward its target.
    public var fraction: Double { min(1, max(0, Double(have) / Double(need))) }
}

public struct Unlock: Equatable, Sendable, Codable {
    public var metric: String
    public var family: MetricFamily?
    public var have: GateCounts
    public var need: GateCounts

    public init(metric: String, family: MetricFamily? = nil, have: GateCounts = GateCounts(), need: GateCounts = GateCounts()) {
        self.metric = metric; self.family = family; self.have = have; self.need = need
    }

    enum CodingKeys: String, CodingKey { case metric, family, have, need }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        metric = try c.decode(String.self, forKey: .metric)
        family = c.lossy(MetricFamily.self, .family)
        have = c.lossy(GateCounts.self, .have) ?? GateCounts()
        need = c.lossy(GateCounts.self, .need) ?? GateCounts()
    }

    /// The unlock counter (docs/CONTRACT.md#display-rules; the engine's contract/display.ts `bindingGate` is the
    /// reference): of the units still short of their target (a known count ≥ 0 below a known target > 0), the one
    /// furthest from it by have ÷ need, a tie going to the earlier of sessions, session-days, events. The count, its noun
    /// and any bar come from this one pair, so a count is never set against another quantity's target ("3,150 of 10").
    /// Nil when no unit is short (only one session dominating): then no count is shown.
    public var binding: GatePair? {
        var best: GatePair?
        for unit in GateUnit.allCases {
            guard let h = have[unit], let n = need[unit], n > 0, h >= 0, h < n else { continue }
            if let b = best, Double(h) / Double(n) >= Double(b.have) / Double(b.need) { continue }
            best = GatePair(unit: unit, have: h, need: n)
        }
        return best
    }

    /// 0...1 toward the binding pair's target; nil when no unit is short.
    public var fraction: Double? { binding?.fraction }
}

/// Tier-based progress toward a verdict (METHOD.md §4, §13).
public struct Progress: Equatable, Sendable, Codable {
    public var tier: Int?
    /// YYYY-MM-DD; nil when there is none (always nil when `notAtCurrentPace`).
    public var etaDate: String?
    /// No tier gets there at the current pace: no day count is ever shown.
    public var notAtCurrentPace: Bool
    /// Never contains interrupts (they never get a progress bar).
    public var unlock: [Unlock]

    public init(tier: Int? = nil, etaDate: String? = nil, notAtCurrentPace: Bool = false, unlock: [Unlock] = []) {
        self.tier = tier; self.etaDate = etaDate; self.notAtCurrentPace = notAtCurrentPace; self.unlock = unlock
    }

    enum CodingKeys: String, CodingKey { case tier, etaDate, notAtCurrentPace, unlock }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tier = c.lossy(Int.self, .tier).flatMap { (1...3).contains($0) ? $0 : nil }
        notAtCurrentPace = c.lossy(Bool.self, .notAtCurrentPace) ?? false
        etaDate = notAtCurrentPace ? nil : c.lossy(String.self, .etaDate)
        unlock = c.lossyArray(Unlock.self, .unlock).filter { $0.metric != "interrupts" }
    }
}

public struct GlanceMetric: Equatable, Sendable, Codable, Identifiable {
    public var id: String
    public var label: String
    public var unit: String
    public var family: MetricFamily?
    public var role: MetricRole
    public var recent: KN
    public var baseline: KN
    public var ratio: Double?
    /// The interval around the ratio `[low, high]`, printed as "range"; nil unless exactly two ordered numbers.
    public var range: [Double]?
    /// Minimum detectable ratio: changes smaller than this would not show.
    public var mde: Double?
    public var status: MetricStatus?

    public init(
        id: String, label: String, unit: String = "", family: MetricFamily? = nil, role: MetricRole = .context,
        recent: KN, baseline: KN, ratio: Double? = nil, range: [Double]? = nil, mde: Double? = nil,
        status: MetricStatus? = nil
    ) {
        self.id = id; self.label = label; self.unit = unit; self.family = family; self.role = role
        self.recent = recent; self.baseline = baseline; self.ratio = ratio; self.range = range; self.mde = mde
        self.status = status
    }

    enum CodingKeys: String, CodingKey { case id, label, unit, family, role, recent, baseline, ratio, range, mde, status }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = c.lossy(String.self, .label) ?? MetricNames.name(id)   // never the raw id on a surface
        unit = c.lossy(String.self, .unit) ?? ""
        family = c.lossy(MetricFamily.self, .family)
        role = c.lossy(MetricRole.self, .role) ?? .context
        recent = try c.decode(KN.self, forKey: .recent)        // a metric without its counts is dropped
        baseline = try c.decode(KN.self, forKey: .baseline)
        ratio = c.lossy(Double.self, .ratio)
        range = Self.orderedPair(c.lossy([Double].self, .range))
        mde = c.lossy(Double.self, .mde)
        status = c.lossy(MetricStatus.self, .status)
    }

    static func orderedPair(_ raw: [Double]?) -> [Double]? {
        guard let raw, raw.count == 2, raw[0] <= raw[1] else { return nil }
        return raw
    }
}

/// One day on the chart: integer k/n (no per-day bands; days are too small).
public struct StripDay: Equatable, Sendable, Codable {
    public var d: String
    public var k: Int
    public var n: Int

    public init(d: String, k: Int, n: Int) { self.d = d; self.k = k; self.n = n }

    public var rate: Double? { n > 0 ? Double(k) / Double(n) : nil }
}

/// One metric's daily integers plus one window-level ratio, range and MDE.
public struct Strip: Equatable, Sendable, Codable {
    public struct Window: Equatable, Sendable, Codable {
        public var ratio: Double?
        public var lo: Double?
        public var hi: Double?
        public var mde: Double?

        public init(ratio: Double? = nil, lo: Double? = nil, hi: Double? = nil, mde: Double? = nil) {
            self.ratio = ratio; self.lo = lo; self.hi = hi; self.mde = mde
        }

        enum CodingKeys: String, CodingKey { case ratio, lo, hi, mde }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            ratio = c.lossy(Double.self, .ratio)
            lo = c.lossy(Double.self, .lo)
            hi = c.lossy(Double.self, .hi)
            mde = c.lossy(Double.self, .mde)
        }
    }

    public var metric: String
    /// Oldest first, at most 42.
    public var days: [StripDay]
    public var window: Window

    public init(metric: String, days: [StripDay] = [], window: Window = Window()) {
        self.metric = metric; self.days = days; self.window = window
    }

    enum CodingKeys: String, CodingKey { case metric, days, window }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        metric = c.lossy(String.self, .metric) ?? ""
        days = Array(c.lossyArray(StripDay.self, .days).prefix(42))
        window = c.lossy(Window.self, .window) ?? Window()
    }
}

public struct GlanceEvent: Equatable, Sendable, Codable {
    public var day: String
    public var kind: String
    public var side: ChangeSide
    public var strength: ChangeStrength?
    public var label: String
    /// Appeared since the previous scan (the menu bar's "new" mark).
    public var isNew: Bool

    public init(day: String, kind: String, side: ChangeSide, strength: ChangeStrength? = nil, label: String, isNew: Bool = false) {
        self.day = day; self.kind = kind; self.side = side; self.strength = strength; self.label = label; self.isNew = isNew
    }

    enum CodingKeys: String, CodingKey { case day, kind, side, strength, label, isNew = "new" }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        day = try c.decode(String.self, forKey: .day)
        kind = c.lossy(String.self, .kind) ?? ""
        label = try c.decode(String.self, forKey: .label)
        side = c.lossy(ChangeSide.self, .side) ?? .unknown
        strength = c.lossy(ChangeStrength.self, .strength)
        isNew = c.lossy(Bool.self, .isNew) ?? false
    }
}
