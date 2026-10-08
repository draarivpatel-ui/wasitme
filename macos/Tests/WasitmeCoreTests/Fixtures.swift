import Foundation
@testable import WasitmeCore

/// 100% synthetic fixtures. The shared contract goldens (`contract/fixtures/`, written by
/// `contract/fixtures/generate.mjs`) are the source of truth; the inline glance below is a small frozen-shape
/// document that tests can re-date and re-state. Nothing here comes from real logs.
enum Fixtures {
    /// `<repo>/contract/fixtures`, found from this file's own path (Tests/WasitmeCoreTests/Fixtures.swift).
    static let contractFixtures: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()      // WasitmeCoreTests
        .deletingLastPathComponent()      // Tests
        .deletingLastPathComponent()      // macos
        .deletingLastPathComponent()      // repo root
        .appendingPathComponent("contract/fixtures", isDirectory: true)

    /// Raw bytes of a shared golden, e.g. `golden("glance/you-verdict.json")`.
    static func golden(_ relativePath: String) throws -> Data {
        try Data(contentsOf: contractFixtures.appendingPathComponent(relativePath))
    }

    /// A complete, valid frozen-shape glance with a fractional-second timestamp (what Node's toISOString() emits).
    static func glanceJSON(
        generatedAt: String = "2026-10-04T12:00:00.123Z",
        state: String = "agent",
        schema: String = "wasitme.glance/1",
        extraTopLevel: String = ""
    ) -> String {
        """
        {
          "schema": "\(schema)",
          "engine": "0.1.0-test",
          "generatedAt": "\(generatedAt)",
          "staleAfterSec": 7200,
          "scanOk": true,
          "scanError": null,
          "demo": false,
          "lead": "verdict",
          "agents": [
            {
              "agent": "claude-code",
              "state": "\(state)",
              "reason": null,
              "pending": false,
              "calibrated": true,
              "label": "Agent side",
              "headline": "Synthetic headline.",
              "because": "Synthetic evidence line.",
              "tryThis": "Synthetic suggestion.",
              "confidence": "Based on 312 exchanges over 40 session-days (9 sessions) on this Mac.",
              "band": "Agent side: synthetic band line.",
              "statusLine": "wasitme: agent side",
              "n": { "exchanges": 312, "sessions": 9, "sessionDays": 40, "days": 14 },
              "progress": null,
              "topMetrics": [
                { "id": "toolErrors", "label": "Tool errors", "unit": "per 100 tool calls", "family": "errors",
                  "role": "vote", "recent": { "k": 30, "n": 312 }, "baseline": { "k": 26, "n": 640 },
                  "ratio": 2.39, "range": [1.6, 3.4], "mde": 2.0, "status": "worse" }
              ],
              "strip": {
                "metric": "toolErrors",
                "days": [ { "d": "2026-09-30", "k": 4, "n": 100 }, { "d": "2026-10-01", "k": 0, "n": 0 } ],
                "window": { "ratio": 2.39, "lo": 1.6, "hi": 3.4, "mde": 2.0 }
              },
              "events": [
                { "day": "2026-09-12", "kind": "served-model", "side": "agent", "strength": "strong",
                  "label": "Served model differs from the one you picked", "new": true }
              ]
            },
            {
              "agent": "codex",
              "state": "insufficient",
              "reason": "calibration_pending",
              "pending": false,
              "calibrated": false,
              "label": "Timeline only",
              "headline": "Findings for Codex are off until wasitme's tests pass for Codex logs.",
              "because": "",
              "tryThis": "",
              "confidence": "",
              "band": "",
              "statusLine": "wasitme: timeline only",
              "n": { "exchanges": 18, "sessions": 2, "sessionDays": 3, "days": 3 },
              "progress": { "tier": 1, "etaDate": "2026-10-20", "notAtCurrentPace": false, "unlock": [
                { "metric": "toolErrors", "family": "errors", "have": { "events": 4, "sessions": 2, "sessionDays": 3 },
                  "need": { "events": 10, "sessions": 5, "sessionDays": 10 } } ] },
              "topMetrics": [],
              "strip": null,
              "events": []
            }
          ],
          "privacy": { "containsText": false }\(extraTopLevel)
        }
        """
    }

    /// The shared two-agent snapshot golden (Claude Code `you` + Codex timeline-only), as text.
    static var snapshotJSON: String {
        // Tests run from the repo, so the golden is always there; a missing file fails loudly.
        (try? String(contentsOf: contractFixtures.appendingPathComponent("snapshot/you-and-codex.json"), encoding: .utf8))
            ?? "missing contract/fixtures/snapshot/you-and-codex.json"
    }

    static func data(_ s: String) -> Data { Data(s.utf8) }
}
