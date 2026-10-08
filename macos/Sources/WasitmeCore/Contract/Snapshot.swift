import Foundation

/// `wasitme.snapshot/1` (frozen; docs/CONTRACT.md): the full analysis behind the Control Center and reports,
/// written to `~/.wasitme/snapshot.json`. It is the glance plus detail: the same top-level fields, each agent
/// is a glance agent (`summary`) plus its windows, metrics, timeline, candidates and "Why this verdict" trace,
/// and the document adds `health` and `calibration`. Every list is lossy; missing fields make no claim.
public struct Snapshot: Equatable, Sendable, Codable {
    public var schema: String
    public var engine: String?
    public var generatedAt: Date?
    public var staleAfterSec: Int
    public var scanOk: Bool
    public var scanError: ScanErrorKind?
    public var demo: Bool
    public var lead: Lead
    public var agents: [AgentReport]
    public var health: Health
    public var calibration: Calibration
    public var privacy: PrivacyDeclaration?

    public init(
        schema: String = "wasitme.snapshot/1", engine: String? = nil, generatedAt: Date? = nil,
        staleAfterSec: Int = Glance.defaultStaleAfterSec, scanOk: Bool = true, scanError: ScanErrorKind? = nil,
        demo: Bool = false, lead: Lead = .timeline, agents: [AgentReport] = [], health: Health = Health(),
        calibration: Calibration = Calibration(), privacy: PrivacyDeclaration? = PrivacyDeclaration(containsText: false)
    ) {
        self.schema = schema; self.engine = engine; self.generatedAt = generatedAt; self.staleAfterSec = staleAfterSec
        self.scanOk = scanOk; self.scanError = scanError; self.demo = demo; self.lead = lead; self.agents = agents
        self.health = health; self.calibration = calibration; self.privacy = privacy
    }

    enum CodingKeys: String, CodingKey {
        case schema, engine, generatedAt, staleAfterSec, scanOk, scanError, demo, lead, agents, health, calibration, privacy
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schema = try c.decode(String.self, forKey: .schema)
        engine = c.lossy(String.self, .engine)
        generatedAt = c.lossyDate(.generatedAt)
        staleAfterSec = Glance.sanitizedStaleAfter(c.lossy(Int.self, .staleAfterSec))
        scanOk = c.lossy(Bool.self, .scanOk) ?? false
        scanError = scanOk ? nil : c.lossy(ScanErrorKind.self, .scanError)
        demo = c.lossy(Bool.self, .demo) ?? false
        lead = c.lossy(Lead.self, .lead) ?? .timeline
        agents = c.lossyArray(AgentReport.self, .agents)
        health = c.lossy(Health.self, .health) ?? Health()
        calibration = c.lossy(Calibration.self, .calibration) ?? Calibration()
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
        try c.encode(health, forKey: .health)
        try c.encode(calibration, forKey: .calibration)
        try c.encodeIfPresent(privacy, forKey: .privacy)
    }

    public var compatibility: SchemaCompatibility { .check(schema, expecting: .snapshot) }

    public func report(for agent: AgentID) -> AgentReport? { agents.first { $0.agent == agent } }
}

/// One agent in the snapshot: its glance fields (`summary`) plus the detail behind them.
public struct AgentReport: Equatable, Sendable, Codable, Identifiable {
    public var summary: AgentGlance
    public var tier: Int?
    public var windows: Windows?
    public var metrics: [Metric]
    public var onset: Onset?
    /// Every change event, oldest first.
    public var timeline: [TimelineEvent]
    public var candidates: [Candidate]
    public var confounders: [Confounder]
    public var observation: ObservationSummary
    /// Current setup: counts and allow-listed labels only.
    public var setup: [String: JSONScalar]
    /// "Why this verdict": decision-table rows checked in order, ending at the one that matched.
    public var trace: [TraceStep]
    /// The fixed closing sentence of every none/you/agent body; nil otherwise.
    public var disclaimer: String?

    public var agent: AgentID { summary.agent }
    public var state: VerdictState { summary.state }
    public var id: String { summary.id }

    public init(
        summary: AgentGlance, tier: Int? = nil, windows: Windows? = nil, metrics: [Metric] = [], onset: Onset? = nil,
        timeline: [TimelineEvent] = [], candidates: [Candidate] = [], confounders: [Confounder] = [],
        observation: ObservationSummary = ObservationSummary(), setup: [String: JSONScalar] = [:], trace: [TraceStep] = [],
        disclaimer: String? = nil
    ) {
        self.summary = summary; self.tier = tier; self.windows = windows; self.metrics = metrics; self.onset = onset
        self.timeline = timeline; self.candidates = candidates; self.confounders = confounders
        self.observation = observation; self.setup = setup; self.trace = trace; self.disclaimer = disclaimer
    }

    enum CodingKeys: String, CodingKey {
        case tier, windows, metrics, onset, timeline, candidates, confounders, observation, setup, trace, disclaimer
    }

    public init(from decoder: Decoder) throws {
        summary = try AgentGlance(from: decoder)              // the same object carries the glance fields
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tier = c.lossy(Int.self, .tier).flatMap { (1...3).contains($0) ? $0 : nil }
        windows = c.lossy(Windows.self, .windows)
        metrics = c.lossyArray(Metric.self, .metrics)
        onset = c.lossy(Onset.self, .onset)
        timeline = c.lossyArray(TimelineEvent.self, .timeline)
        candidates = c.lossyArray(Candidate.self, .candidates)
        confounders = c.lossyArray(Confounder.self, .confounders)
        observation = c.lossy(ObservationSummary.self, .observation) ?? ObservationSummary()
        setup = c.lossyDictionary(JSONScalar.self, .setup)
        trace = c.lossyArray(TraceStep.self, .trace)
        disclaimer = c.lossy(String.self, .disclaimer)
    }

    public func encode(to encoder: Encoder) throws {
        try summary.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(tier, forKey: .tier)
        try c.encode(windows, forKey: .windows)
        try c.encode(metrics, forKey: .metrics)
        try c.encode(onset, forKey: .onset)
        try c.encode(timeline, forKey: .timeline)
        try c.encode(candidates, forKey: .candidates)
        try c.encode(confounders, forKey: .confounders)
        try c.encode(observation, forKey: .observation)
        try c.encode(setup, forKey: .setup)
        try c.encode(trace, forKey: .trace)
        try c.encode(disclaimer, forKey: .disclaimer)
    }
}

public struct WindowInfo: Equatable, Sendable, Codable {
    public var from: String?
    public var to: String?
    public var days: Int?
    public var exchanges: Int?
    public var sessions: Int?
    public var sessionDays: Int?

    public init(from: String? = nil, to: String? = nil, days: Int? = nil, exchanges: Int? = nil,
                sessions: Int? = nil, sessionDays: Int? = nil) {
        self.from = from; self.to = to; self.days = days; self.exchanges = exchanges
        self.sessions = sessions; self.sessionDays = sessionDays
    }

    enum CodingKeys: String, CodingKey { case from, to, days, exchanges, sessions, sessionDays }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = c.lossy(String.self, .from)
        to = c.lossy(String.self, .to)
        days = c.lossy(Int.self, .days)
        exchanges = c.lossy(Int.self, .exchanges)
        sessions = c.lossy(Int.self, .sessions)
        sessionDays = c.lossy(Int.self, .sessionDays)
    }
}

public struct Windows: Equatable, Sendable, Codable {
    public var recent: WindowInfo
    public var baseline: WindowInfo

    public init(recent: WindowInfo = WindowInfo(), baseline: WindowInfo = WindowInfo()) {
        self.recent = recent; self.baseline = baseline
    }

    enum CodingKeys: String, CodingKey { case recent, baseline }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        recent = c.lossy(WindowInfo.self, .recent) ?? WindowInfo()
        baseline = c.lossy(WindowInfo.self, .baseline) ?? WindowInfo()
    }
}

public struct Onset: Equatable, Sendable, Codable {
    public var from: String
    public var to: String

    public init(from: String, to: String) { self.from = from; self.to = to }
}

/// A snapshot metric: the glance metric plus its gates and daily series.
public struct Metric: Equatable, Sendable, Codable, Identifiable {
    public var base: GlanceMetric
    public var eligible: Bool
    /// Why the gates failed, as the contract's kind (e.g. `too_few_events`); nil when eligible or unknown.
    public var ineligibleReason: String?
    /// Eligible with MDE ≤ 2×.
    public var sensitive: Bool
    /// Material per D23.
    public var shifted: Bool
    public var standardized: Standardized?
    public var series: [StripDay]

    public var id: String { base.id }

    public struct Standardized: Equatable, Sendable, Codable {
        public var ratio: Double?
        public var range: [Double]?

        public init(ratio: Double? = nil, range: [Double]? = nil) { self.ratio = ratio; self.range = range }

        enum CodingKeys: String, CodingKey { case ratio, range }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            ratio = c.lossy(Double.self, .ratio)
            range = GlanceMetric.orderedPair(c.lossy([Double].self, .range))
        }
    }

    public init(base: GlanceMetric, eligible: Bool = false, ineligibleReason: String? = nil, sensitive: Bool = false,
                shifted: Bool = false, standardized: Standardized? = nil, series: [StripDay] = []) {
        self.base = base; self.eligible = eligible; self.ineligibleReason = ineligibleReason
        self.sensitive = sensitive; self.shifted = shifted; self.standardized = standardized; self.series = series
    }

    enum CodingKeys: String, CodingKey { case eligible, ineligibleReason, sensitive, shifted, standardized, series }

    public init(from decoder: Decoder) throws {
        base = try GlanceMetric(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        eligible = c.lossy(Bool.self, .eligible) ?? false
        ineligibleReason = c.lossy(String.self, .ineligibleReason)
        sensitive = c.lossy(Bool.self, .sensitive) ?? false
        shifted = c.lossy(Bool.self, .shifted) ?? false
        standardized = c.lossy(Standardized.self, .standardized)
        series = c.lossyArray(StripDay.self, .series)
    }

    public func encode(to encoder: Encoder) throws {
        try base.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(eligible, forKey: .eligible)
        try c.encode(ineligibleReason, forKey: .ineligibleReason)
        try c.encode(sensitive, forKey: .sensitive)
        try c.encode(shifted, forKey: .shifted)
        try c.encode(standardized, forKey: .standardized)
        try c.encode(series, forKey: .series)
    }
}

/// One entry on the change timeline (version bump, model switch, effort change, config change, ...).
public struct TimelineEvent: Equatable, Sendable, Codable, Identifiable {
    public var id: String
    public var t: String
    public var day: String
    public var kind: String
    public var side: ChangeSide
    public var strength: ChangeStrength?
    public var provenance: ChangeProvenance?
    public var label: String
    public var from: String
    public var to: String
    public var isNew: Bool

    public init(id: String, t: String = "", day: String, kind: String, side: ChangeSide, strength: ChangeStrength? = nil,
                provenance: ChangeProvenance? = nil, label: String = "", from: String = "", to: String = "", isNew: Bool = false) {
        self.id = id; self.t = t; self.day = day; self.kind = kind; self.side = side; self.strength = strength
        self.provenance = provenance; self.label = label; self.from = from; self.to = to; self.isNew = isNew
    }

    enum CodingKeys: String, CodingKey { case id, t, day, kind, side, strength, provenance, label, from, to, isNew = "new" }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        t = c.lossy(String.self, .t) ?? ""
        day = c.lossy(String.self, .day) ?? ""
        kind = c.lossy(String.self, .kind) ?? ""
        side = c.lossy(ChangeSide.self, .side) ?? .unknown
        strength = c.lossy(ChangeStrength.self, .strength)
        provenance = c.lossy(ChangeProvenance.self, .provenance)
        label = c.lossy(String.self, .label) ?? ""
        from = c.lossy(String.self, .from) ?? ""
        to = c.lossy(String.self, .to) ?? ""
        isNew = c.lossy(Bool.self, .isNew) ?? false
    }
}

public struct Candidate: Equatable, Sendable, Codable {
    public enum Status: String, Sendable, Codable { case open, ruledOut = "ruled_out", background }
    public enum Test: String, Sendable, Codable { case strata, versionBoundary = "version_boundary", routine }

    /// A timeline event id.
    public var event: String
    public var status: Status?
    public var test: Test?

    public init(event: String, status: Status? = nil, test: Test? = nil) {
        self.event = event; self.status = status; self.test = test
    }

    enum CodingKeys: String, CodingKey { case event, status, test }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        event = try c.decode(String.self, forKey: .event)
        status = c.lossy(Status.self, .status)
        test = c.lossy(Test.self, .test)
    }
}

/// A factor that could explain a change besides the setup/agent (e.g. workload mix) and whether it moved.
public struct Confounder: Equatable, Sendable, Codable, Identifiable {
    public var id: String
    public var moved: Bool?
    public var value: Double?

    public init(id: String, moved: Bool? = nil, value: Double? = nil) {
        self.id = id; self.moved = moved; self.value = value
    }

    enum CodingKeys: String, CodingKey { case id, moved, value }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        moved = c.lossy(Bool.self, .moved)
        value = c.lossy(Double.self, .value)
    }
}

public struct ObservationSummary: Equatable, Sendable, Codable {
    public var fullyObservedDays: Int?
    public var partiallyObservedDays: Int?
    /// Engine words, e.g. "Sessions on other machines aren't visible."
    public var note: String

    public init(fullyObservedDays: Int? = nil, partiallyObservedDays: Int? = nil, note: String = "") {
        self.fullyObservedDays = fullyObservedDays; self.partiallyObservedDays = partiallyObservedDays; self.note = note
    }

    enum CodingKeys: String, CodingKey { case fullyObservedDays, partiallyObservedDays, note }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fullyObservedDays = c.lossy(Int.self, .fullyObservedDays)
        partiallyObservedDays = c.lossy(Int.self, .partiallyObservedDays)
        note = c.lossy(String.self, .note) ?? ""
    }
}

public struct TraceStep: Equatable, Sendable, Codable {
    /// Decision-table row (METHOD.md §11), 1...14.
    public var row: Int
    public var matched: Bool
    public var text: String

    public init(row: Int, matched: Bool, text: String) { self.row = row; self.matched = matched; self.text = text }

    enum CodingKeys: String, CodingKey { case row, matched, text }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        row = try c.decode(Int.self, forKey: .row)
        matched = c.lossy(Bool.self, .matched) ?? false
        text = c.lossy(String.self, .text) ?? ""
    }
}

/// Per-agent log reader status: what was found and how clean the parse was (format drift is visible).
public struct SourceInfo: Equatable, Sendable, Codable, Identifiable {
    public var agent: AgentID
    public var found: Bool
    public var files: Int
    public var badLines: Int?
    public var truncatedTail: Int?
    public var duplicates: Int?
    public var unknownTypes: [String: Int]
    public var firstDay: String?
    public var lastDay: String?
    /// Why the source could not be read, as the contract's kind (e.g. `not_found`).
    public var error: String?

    public var id: String { agent.rawValue }

    public init(
        agent: AgentID, found: Bool = false, files: Int = 0, badLines: Int? = nil, truncatedTail: Int? = nil,
        duplicates: Int? = nil, unknownTypes: [String: Int] = [:], firstDay: String? = nil,
        lastDay: String? = nil, error: String? = nil
    ) {
        self.agent = agent; self.found = found; self.files = files; self.badLines = badLines
        self.truncatedTail = truncatedTail; self.duplicates = duplicates; self.unknownTypes = unknownTypes
        self.firstDay = firstDay; self.lastDay = lastDay; self.error = error
    }

    enum CodingKeys: String, CodingKey {
        case agent, found, files, badLines, truncatedTail, duplicates, unknownTypes, firstDay, lastDay, error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agent = try c.decode(AgentID.self, forKey: .agent)
        found = c.lossy(Bool.self, .found) ?? false
        files = c.lossy(Int.self, .files) ?? 0
        badLines = c.lossy(Int.self, .badLines)
        truncatedTail = c.lossy(Int.self, .truncatedTail)
        duplicates = c.lossy(Int.self, .duplicates)
        unknownTypes = c.lossyDictionary(Int.self, .unknownTypes)
        firstDay = c.lossy(String.self, .firstDay)
        lastDay = c.lossy(String.self, .lastDay)
        error = c.lossy(String.self, .error)
    }
}

public struct PausedMetric: Equatable, Sendable, Codable {
    public var agent: AgentID
    public var metric: String
    public var why: String

    public init(agent: AgentID, metric: String, why: String) { self.agent = agent; self.metric = metric; self.why = why }
}

public struct Health: Equatable, Sendable, Codable {
    public var sources: [SourceInfo]
    public var parserVersions: [String: Int]
    /// The scan ran under `node --permission`.
    public var sandbox: Bool?
    public var paused: [PausedMetric]

    public init(sources: [SourceInfo] = [], parserVersions: [String: Int] = [:], sandbox: Bool? = nil, paused: [PausedMetric] = []) {
        self.sources = sources; self.parserVersions = parserVersions; self.sandbox = sandbox; self.paused = paused
    }

    enum CodingKeys: String, CodingKey { case sources, parserVersions, sandbox, paused }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sources = c.lossyArray(SourceInfo.self, .sources)
        parserVersions = c.lossyDictionary(Int.self, .parserVersions)
        sandbox = c.lossy(Bool.self, .sandbox)
        paused = c.lossyArray(PausedMetric.self, .paused)
    }
}

public struct CalibrationAgent: Equatable, Sendable, Codable {
    public var agent: AgentID
    public var calibrated: Bool
    public var sequences: Int?
    public var falseChanged: Double?
    public var falseAgent: Double?

    public init(agent: AgentID, calibrated: Bool = false, sequences: Int? = nil, falseChanged: Double? = nil, falseAgent: Double? = nil) {
        self.agent = agent; self.calibrated = calibrated; self.sequences = sequences
        self.falseChanged = falseChanged; self.falseAgent = falseAgent
    }

    enum CodingKeys: String, CodingKey { case agent, calibrated, sequences, falseChanged, falseAgent }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agent = try c.decode(AgentID.self, forKey: .agent)
        calibrated = c.lossy(Bool.self, .calibrated) ?? false
        sequences = c.lossy(Int.self, .sequences)
        falseChanged = c.lossy(Double.self, .falseChanged)
        falseAgent = c.lossy(Double.self, .falseAgent)
    }
}

public struct Calibration: Equatable, Sendable, Codable {
    public var artifactDate: String?
    public var methodId: String?
    public var agents: [CalibrationAgent]

    public init(artifactDate: String? = nil, methodId: String? = nil, agents: [CalibrationAgent] = []) {
        self.artifactDate = artifactDate; self.methodId = methodId; self.agents = agents
    }

    enum CodingKeys: String, CodingKey { case artifactDate, methodId, agents }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        artifactDate = c.lossy(String.self, .artifactDate)
        methodId = c.lossy(String.self, .methodId)
        agents = c.lossyArray(CalibrationAgent.self, .agents)
    }
}
