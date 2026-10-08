import Darwin
import Foundation

/// Memory measurement for the D48 budgets: the app idle ≤60 MiB RSS until the first
/// Control Center open (then ≤80 MiB RSS and ≤25 MiB footprint); Control Center open ≤180 MB RSS for the app plus its
/// WebContent process. The budgets are in RSS (resident set size, what `ps` shows), so every report carries RSS
/// (`ri_resident_size`) next to `phys_footprint` (what Activity Monitor calls "Memory"; it leaves out shared framework
/// pages, so it is much smaller).
///
/// WebKit's helper processes are launchd XPC services, not our children, so they are found by name and
/// start time: those that appeared after `baseline` was taken. On a busy Mac another app could start a
/// WebContent process in the same window; the report lists every pid it counted so that is visible.
public enum MemoryProbe {
    public struct Helper: Codable, Sendable, Equatable {
        public var pid: Int32
        public var kind: String
        public var footprintBytes: UInt64
        public var residentBytes: UInt64

        public init(pid: Int32, kind: String, footprintBytes: UInt64, residentBytes: UInt64) {
            self.pid = pid; self.kind = kind; self.footprintBytes = footprintBytes; self.residentBytes = residentBytes
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            pid = try c.decode(Int32.self, forKey: .pid)
            kind = try c.decode(String.self, forKey: .kind)
            footprintBytes = try c.decode(UInt64.self, forKey: .footprintBytes)
            residentBytes = try c.decodeIfPresent(UInt64.self, forKey: .residentBytes) ?? 0
        }
    }

    /// One process's two numbers.
    public struct Usage: Sendable, Equatable {
        public var footprint: UInt64
        public var resident: UInt64
    }

    public struct Report: Codable, Sendable {
        public var label: String
        public var appFootprintBytes: UInt64
        public var appResidentBytes: UInt64
        public var helpers: [Helper]
        /// App + WebContent footprint.
        public var appPlusWebContentBytes: UInt64 {
            appFootprintBytes + helpers.filter { $0.kind == "WebContent" }.reduce(0) { $0 + $1.footprintBytes }
        }
        /// App + WebContent RSS: the quantity the 180 MB Control Center budget is about.
        public var appPlusWebContentResidentBytes: UInt64 {
            appResidentBytes + helpers.filter { $0.kind == "WebContent" }.reduce(0) { $0 + $1.residentBytes }
        }
        public var appPlusAllHelpersBytes: UInt64 { appFootprintBytes + helpers.reduce(0) { $0 + $1.footprintBytes } }

        enum CodingKeys: String, CodingKey {
            case label, appFootprintBytes, appResidentBytes, helpers, appPlusWebContentBytes, appPlusWebContentResidentBytes,
                 appPlusAllHelpersBytes, appMB, appResidentMiB, appPlusWebContentMB, appPlusWebContentResidentMiB
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(label, forKey: .label)
            try c.encode(appFootprintBytes, forKey: .appFootprintBytes)
            try c.encode(appResidentBytes, forKey: .appResidentBytes)
            try c.encode(helpers, forKey: .helpers)
            try c.encode(appPlusWebContentBytes, forKey: .appPlusWebContentBytes)
            try c.encode(appPlusWebContentResidentBytes, forKey: .appPlusWebContentResidentBytes)
            try c.encode(appPlusAllHelpersBytes, forKey: .appPlusAllHelpersBytes)
            try c.encode(Self.mb(appFootprintBytes), forKey: .appMB)
            try c.encode(Self.mb(appResidentBytes), forKey: .appResidentMiB)
            try c.encode(Self.mb(appPlusWebContentBytes), forKey: .appPlusWebContentMB)
            try c.encode(Self.mb(appPlusWebContentResidentBytes), forKey: .appPlusWebContentResidentMiB)
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            label = try c.decode(String.self, forKey: .label)
            appFootprintBytes = try c.decode(UInt64.self, forKey: .appFootprintBytes)
            appResidentBytes = try c.decodeIfPresent(UInt64.self, forKey: .appResidentBytes) ?? 0
            helpers = try c.decode([Helper].self, forKey: .helpers)
        }

        init(label: String, appFootprintBytes: UInt64, appResidentBytes: UInt64, helpers: [Helper]) {
            self.label = label; self.appFootprintBytes = appFootprintBytes; self.appResidentBytes = appResidentBytes; self.helpers = helpers
        }

        /// MiB (1,048,576 bytes), one decimal.
        static func mb(_ b: UInt64) -> Double { (Double(b) / 1_048_576 * 10).rounded() / 10 }

        /// "app 41.2 MiB RSS (12.3 MiB footprint), app+WebContent 130.4 MiB RSS (64.0 MiB footprint)"
        public var summary: String {
            "app \(Self.mb(appResidentBytes)) MiB RSS (\(Self.mb(appFootprintBytes)) MiB footprint), app+WebContent "
                + "\(Self.mb(appPlusWebContentResidentBytes)) MiB RSS (\(Self.mb(appPlusWebContentBytes)) MiB footprint)"
        }
    }

    /// When the helpers we should count were not running yet.
    public struct Baseline: Sendable {
        let existing: Set<pid_t>
        let since: Date
    }

    public static func baseline() -> Baseline {
        Baseline(existing: Set(webKitHelpers().map(\.0)), since: Date().addingTimeInterval(-1))
    }

    /// `phys_footprint` and RSS of a process we may inspect (same user), or nil.
    public static func usage(pid: pid_t) -> Usage? {
        var info = rusage_info_v4()
        let rc = withUnsafeMutablePointer(to: &info) { p in
            p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
        }
        return rc == 0 ? Usage(footprint: info.ri_phys_footprint, resident: info.ri_resident_size) : nil
    }

    /// `phys_footprint` of a process we may inspect (same user), or nil.
    public static func footprint(pid: pid_t) -> UInt64? { usage(pid: pid)?.footprint }

    public static func selfFootprint() -> UInt64? { footprint(pid: getpid()) }
    public static func selfResident() -> UInt64? { usage(pid: getpid())?.resident }

    /// (pid, kind) of every WebKit helper process visible to this user.
    static func webKitHelpers() -> [(pid_t, String)] {
        let capacity = Int(proc_listallpids(nil, 0)) + 64
        guard capacity > 64 else { return [] }
        var pids = [pid_t](repeating: 0, count: capacity)
        let n = pids.withUnsafeMutableBufferPointer { proc_listallpids($0.baseAddress, Int32(capacity * MemoryLayout<pid_t>.size)) }
        guard n > 0 else { return [] }
        var out: [(pid_t, String)] = []
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        for pid in pids.prefix(Int(n)) where pid > 0 {
            let len = proc_pidpath(pid, &path, UInt32(path.count))
            guard len > 0 else { continue }
            let p = String(decoding: path.prefix(Int(len)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
            for kind in ["WebContent", "Networking", "GPU"] where p.contains("com.apple.WebKit.\(kind)") {
                out.append((pid, kind))
            }
        }
        return out
    }

    static func startTime(pid: pid_t) -> Date? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(info.pbi_start_tvsec) + TimeInterval(info.pbi_start_tvusec) / 1e6)
    }

    /// Our footprint and RSS plus every WebKit helper that started after `baseline` (nil: helpers not counted).
    public static func report(label: String, since baseline: Baseline?) -> Report {
        var helpers: [Helper] = []
        if let baseline {
            for (pid, kind) in webKitHelpers() where !baseline.existing.contains(pid) {
                guard let start = startTime(pid: pid), start >= baseline.since, let u = usage(pid: pid) else { continue }
                helpers.append(Helper(pid: pid, kind: kind, footprintBytes: u.footprint, residentBytes: u.resident))
            }
        }
        let me = usage(pid: getpid())
        return Report(label: label, appFootprintBytes: me?.footprint ?? 0, appResidentBytes: me?.resident ?? 0,
                      helpers: helpers.sorted { $0.pid < $1.pid })
    }

    public static func write(_ reports: [Report], to url: URL) throws {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        try e.encode(reports).write(to: url, options: .atomic)
    }
}

/// The D48 memory budgets, checked against a `MemoryProbe.Report`. RSS throughout (the unit the budgets use).
public enum MemoryBudget {
    /// D48: the app idle, until the first Control Center open: ≤60 MiB RSS.
    public static let idleResident: UInt64 = 60 * 1_048_576
    /// D48: Control Center open, app + its WebContent process: ≤180 MB RSS (decimal MB, the stricter reading).
    public static let controlCenterResident: UInt64 = 180_000_000

    public struct Check: Codable, Sendable, Equatable {
        public var budget: String
        public var measuredBytes: UInt64
        public var limitBytes: UInt64
        public var within: Bool
        public var line: String { "\(budget): \(MemoryProbe.Report.mb(measuredBytes)) MiB RSS, limit \(MemoryProbe.Report.mb(limitBytes)) MiB: \(within ? "PASS" : "OVER")" }
    }

    public static func idle(_ r: MemoryProbe.Report) -> Check {
        Check(budget: "idle (app RSS)", measuredBytes: r.appResidentBytes, limitBytes: idleResident,
              within: r.appResidentBytes > 0 && r.appResidentBytes <= idleResident)
    }

    public static func controlCenter(_ r: MemoryProbe.Report) -> Check {
        Check(budget: "Control Center open (app + WebContent RSS)", measuredBytes: r.appPlusWebContentResidentBytes,
              limitBytes: controlCenterResident,
              within: r.appResidentBytes > 0 && r.appPlusWebContentResidentBytes <= controlCenterResident)
    }
}
