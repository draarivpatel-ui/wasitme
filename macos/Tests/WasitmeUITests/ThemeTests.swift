import AppKit
import Foundation
import Testing
@testable import WasitmeCore
@testable import WasitmeUI

/// `Theme.swift` builds the brand from the generated design tokens; the glyph renderer is the one place glyphs are
/// drawn. These tests keep it that way.
@Suite struct ThemeTests {
    /// Files allowed to hold colour / font literals and vector drawing: the theme, the glyph renderer, and the file
    /// generated from design/system (DesignSyncTests checks it is exactly what the design generator writes).
    static let themeFiles: Set<String> = ["Theme.swift", "GlyphRendering.swift", "Tokens.swift"]

    /// Colour, font and symbol literals appear only in the theme files (the placeholder canvas's CSS is web content).
    @Test func noVisualLiteralsOutsideTheTheme() throws {
        let banned = try Regex(#"Color\((red|white|hue|\.sRGB|\.displayP3):|NSColor\((srgbRed|red|calibratedRed|deviceRed|white|calibratedWhite|deviceWhite|hue):|\b0x[0-9A-Fa-f]{6}\b|\.font\(\.system|Font\.system\(|Font\.custom\(|\.custom\("|NSFont\.(systemFont|monospacedSystemFont|boldSystemFont|userFont)|systemSymbolName|Image\(systemName|Color\.(red|blue|green|orange|yellow|purple|pink|gray|grey|black|white|primary|secondary|accentColor)\b|NSColor\.(system[A-Z]|labelColor|controlAccentColor|black|white|red|blue)|NSBezierPath"#)
        let files = Repo.swiftFiles(under: Repo.uiSources)
        #expect(files.count > 10, "UI sources not found at \(Repo.uiSources.path)")
        for file in files where !Self.themeFiles.contains(file.lastPathComponent) && file.lastPathComponent != "PlaceholderCanvas.swift" {
            let text = try String(contentsOf: file, encoding: .utf8)
            for (i, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                let code = line.split(separator: "//", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
                #expect(code.firstMatch(of: banned) == nil, "\(file.lastPathComponent):\(i + 1): visual literal outside Theme: \(line)")
            }
        }
    }

    /// The palette IS the design tokens: spot values from tokens.json, both appearances.
    @Test func paletteComesFromTheDesignTokens() {
        let p = Theme.current.palette
        func hex(_ c: ColorToken.RGBA) -> String {
            String(format: "#%02X%02X%02X", Int((c.r * 255).rounded()), Int((c.g * 255).rounded()), Int((c.b * 255).rounded()))
        }
        #expect(hex(p.sheet.light) == "#FCFCFA" && hex(p.sheet.dark) == "#1B1C21")
        #expect(hex(p.ink.light) == "#1C1D21" && hex(p.ink.dark) == "#ECEBE6")
        #expect(hex(p.youFill.light) == "#F5C842" && hex(p.youFill.dark) == "#F2C230")
        #expect(hex(p.agentFill.light) == "#8DBCF0" && hex(p.agentFill.dark) == "#8CC4F2")
        #expect(hex(p.raised.light) == "#FFFFFF" && hex(p.ruleStrong.light) == "#B8B7AF")
    }

    /// DESIGN.md §5: no red and no green anywhere; `none` is a solid ink chip; the parties are distinct.
    @Test func stateColoursAreDistinctAndNeverRedOrGreen() {
        let t = Theme.current
        #expect(t.palette.youFill != t.palette.agentFill)
        for s in Tokens.FindingState.allCases {
            let st = t.stateStyle(s)
            for c in [st.bg.light, st.bg.dark, st.fg.light, st.fg.dark] {
                #expect(!(c.g > c.r + 0.15 && c.g > c.b + 0.15), "\(s): green")
                #expect(!(c.r > c.g + 0.3 && c.r > c.b + 0.3), "\(s): red")
            }
        }
        #expect(t.stateStyle(.noDetectableChange).bg == t.palette.ink, "none is a solid ink chip")
        #expect(t.stateStyle(.insufficient).edgeStyle == .dashed && t.stateStyle(.stale).edgeStyle == .dotted)
        #expect(t.stateStyle(.unclear).swatches == [t.palette.youFill, t.palette.agentFill])
    }

    /// Every text pair the native surfaces draw is at least 4.5:1, in both appearances (the design's contrast report
    /// covers the canvas; this covers the popover and panel pairs).
    @Test func nativeTextContrast() {
        let p = Theme.current.palette
        func lum(_ c: ColorToken.RGBA) -> Double {
            func ch(_ v: Double) -> Double { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
            return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
        }
        func ratio(_ a: ColorToken.RGBA, _ b: ColorToken.RGBA) -> Double {
            let (x, y) = (lum(a), lum(b)); return (max(x, y) + 0.05) / (min(x, y) + 0.05)
        }
        let pairs: [(ColorToken, ColorToken)] = [(p.ink, p.raised), (p.inkSecondary, p.raised), (p.inkMuted, p.raised),
                                                 (p.chartLabel, p.raised), (p.actionText, p.action), (p.youInk, p.youFill),
                                                 (p.agentInk, p.agentFill), (p.inkSecondary, p.sheet)]
        for (ink, bg) in pairs {
            #expect(ratio(ink.light, bg.light) >= 4.5, "light \(ink.light) on \(bg.light)")
            #expect(ratio(ink.dark, bg.dark) >= 4.5, "dark \(ink.dark) on \(bg.dark)")
        }
        for s in Tokens.FindingState.allCases {
            let st = Theme.current.stateStyle(s)
            #expect(ratio(st.fg.light, st.bg.light) >= 4.5 && ratio(st.fg.dark, st.bg.dark) >= 4.5, "\(s) chip text")
        }
    }

    @Test func dynamicColoursFollowTheAppearance() throws {
        let c = Theme.current.palette.ink.nsColor
        var light = NSColor.clear, dark = NSColor.clear
        NSAppearance(named: .aqua)?.performAsCurrentDrawingAppearance { light = c.usingColorSpace(.sRGB) ?? .clear }
        NSAppearance(named: .darkAqua)?.performAsCurrentDrawingAppearance { dark = c.usingColorSpace(.sRGB) ?? .clear }
        #expect(abs(light.redComponent - Theme.current.palette.ink.light.r) < 0.01)
        #expect(abs(dark.redComponent - Theme.current.palette.ink.dark.r) < 0.01)
        #expect(light.redComponent != dark.redComponent)
    }

    /// D57: the type is the bundled IBM Plex (registered for this process), on the design's scale.
    @Test @MainActor func theBundledFacesAreRegisteredAndUsed() {
        _ = Headless.ready
        #expect(FontRegistry.isRegistered, "IBM Plex faces did not register: \(FontRegistry.registerBundledFonts())")
        let t = Theme.current.type
        #expect(t.ui.nsFont.fontName == "IBMPlexSerif-Regular" && t.ui.size == 14 && t.ui.lineHeight == 21)
        #expect(t.typedSm.nsFont.fontName == "IBMPlexMono-Regular" && t.typedSm.bold.nsFont.fontName == "IBMPlexMono-Bold")
        #expect(t.note.nsFont.fontName == "IBMPlexSerif-Italic" && t.note.upright.nsFont.fontName == "IBMPlexSerif-Regular")
        #expect(t.popTitle.size == 26 && t.heading.nsFont.fontName == "IBMPlexSerif-Bold")
        #expect(abs(t.ui.naturalLineHeight - 14 * 1.3) < 0.05, "Plex's own line is 1.3 em (DESIGN.md §4)")
    }

    /// The app states' words are the app's own titles (AppCopy, Core), and every non-finding glyph is an app state.
    @Test func appStateLabelsMatchTheAppTitles() {
        let pairs: [(Tokens.AppState, DocumentDisplay)] = [(.loading, .loading), (.notSetUp, .notSetUp), (.empty, .empty),
                                                           (.unreadable, .unreadable), (.updateNeeded, .mismatch), (.refused, .refused)]
        #expect(pairs.count == Tokens.AppState.allCases.count)
        for (a, d) in pairs { #expect(a.label == AppCopy.title(d), "\(a)") }
        for g in MenuBarGlyph.allCases { #expect((g.findingState == nil) != (g.appState == nil), "\(g) is exactly one of finding / app state") }
        #expect(Theme.current.chipStyle(.notSetUp).fg == ColorToken(Tokens.AppState.chipFg))
    }

    /// The new-change words the app owns (AppCopy, Core) are the design's (tokens.json states.newEvent).
    @Test func newChangeWordsMatchTheTokens() {
        for n in [1, 2, 7] {
            #expect(", " + AppCopy.newChanges(n) == Tokens.FindingState.newChangesVoiceOver(n))
        }
        #expect(Tokens.FindingState.newChangesText(3) == "+3")
    }
}

/// The generated file is exactly what `macos/scripts/sync-design.mjs` copies from design/system today, and it says what
/// tokens.json and the glyph files say (read independently here, so a generator bug can't vouch for itself).
@Suite struct DesignSyncTests {
    static let generated = Repo.uiSources.appendingPathComponent("Theme/Generated", isDirectory: true)
    static let design = Repo.root.appendingPathComponent("design/system", isDirectory: true)

    static func tokens() throws -> [String: Any] {
        let data = try Data(contentsOf: design.appendingPathComponent("tokens.json"))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func tokensSwiftIsAByteCopyOfTheDesignFile() throws {
        let copy = try Data(contentsOf: Self.generated.appendingPathComponent("Tokens.swift"))
        let source = try Data(contentsOf: Self.design.appendingPathComponent("generated/Tokens.swift"))
        #expect(copy == source, "run: node macos/scripts/sync-design.mjs")
        let others = try FileManager.default.contentsOfDirectory(atPath: Self.generated.path).filter { $0 != "Tokens.swift" && !$0.hasPrefix(".") }
        #expect(others.isEmpty, "Theme/Generated holds files design/system doesn't generate: \(others)")
    }

    /// The values WP-50 used to generate locally (copy, chart constants, sizes, PostScript names, edge styles) now
    /// come from the design generator; spot-check each group against tokens.json.
    @Test func generatedTokensMatchTokensJSON() throws {
        let t = try Self.tokens()
        let copy = try #require(t["copy"] as? [String: Any])
        #expect(copy["disclaimer"] as? String == Tokens.Copy.disclaimer)
        #expect(copy["privacyShort"] as? String == Tokens.Copy.privacyShort)
        #expect(copy["tagline"] as? String == Tokens.Copy.tagline)
        let strip = try #require((t["chart"] as? [String: Any])?["strip"] as? [String: Any])
        #expect(strip["columnWidth"] as? Double == Double(Tokens.Chart.Strip.columnWidth))
        #expect(strip["lowNThreshold"] as? Int == Tokens.Chart.Strip.lowNThreshold)
        let timeline = try #require((t["chart"] as? [String: Any])?["timeline"] as? [String: Any])
        #expect(timeline["rule"] as? Double == Double(Tokens.Chart.Timeline.rule))
        let scale = try #require((t["type"] as? [String: Any])?["scale"] as? [String: Any])
        let ui = try #require(scale["ui"] as? [String: Any])
        #expect(ui["size"] as? Double == Double(Tokens.TypeScale.ui.size) && ui["line"] as? Double == Double(Tokens.TypeScale.ui.lineHeight))
        #expect(Tokens.TypeScale.ui.lineHeight == Tokens.Typeface.uiLineHeight)
        #expect(Tokens.TypeScale.popTitle.tracking == Tokens.Typeface.popTitleTracking)
        #expect(Tokens.TypeScale.note.postScriptName == "IBMPlexSerif-Italic" && Tokens.TypeScale.typedSm.postScriptName == "IBMPlexMono-Regular")
        let size = try #require(t["size"] as? [String: Any])
        let popover = try #require(size["popover"] as? [String: Any])
        #expect(Tokens.Size.popover == CGSize(width: popover["width"] as? Double ?? 0, height: popover["height"] as? Double ?? 0))
        #expect((size["chip"] as? [String: Any])?["height"] as? Double == Double(Tokens.Size.chipHeight))
        #expect(Theme.current.metrics.popover == Tokens.Size.popover && Theme.current.metrics.chipHeight == Tokens.Size.chipHeight)
        let light = try #require(((t["color"] as? [String: Any])?["light"] as? [String: Any])?["state"] as? [String: Any])
        for s in Tokens.FindingState.allCases {
            #expect((light[s.rawValue] as? [String: Any])?["edgeStyle"] as? String == s.edgeStyle.rawValue, "\(s) edge style")
        }
    }

    /// Every 16/18 px glyph file tokens.json names (states, app states, the mono mark), as names without ".svg".
    static func glyphNames() throws -> [String] {
        let t = try tokens()
        func files(_ group: [String: Any]?, _ keys: [String]) -> [String] {
            keys.flatMap { k -> [String] in
                let f = (group?[k] as? [String: Any])?["files"] as? [String: String] ?? [:]
                return ["16", "18"].compactMap { f[$0] }
            }
        }
        let states = t["states"] as? [String: Any], app = t["appStates"] as? [String: Any]
        let order = (states?["order"] as? [String] ?? []) + (states?["displayOnly"] as? [String] ?? [])
        let mark = ((t["mark"] as? [String: Any])?["files"] as? [String: String]) ?? [:]
        let paths = files(states, order) + files(app, app?["order"] as? [String] ?? []) + [mark["mono16"], mark["mono18"]].compactMap { $0 }
        #expect(paths.count == (order.count + (app?["order"] as? [String] ?? []).count) * 2 + 2, "a glyph file is missing from tokens.json")
        return paths.map { ($0 as NSString).lastPathComponent.replacingOccurrences(of: ".svg", with: "") }
    }

    /// Each glyph's primitives equal its SVG file, parsed independently here (rect, filled M/L/Z path, stroked path).
    @Test func glyphPrimitivesMatchTheSVGFiles() throws {
        let names = try Self.glyphNames()
        #expect(Tokens.Glyphs.all.count == names.count)
        for name in names {
            let svg = try String(contentsOf: Self.design.appendingPathComponent("glyphs/\(name).svg"), encoding: .utf8)
            let g = try #require(Tokens.Glyphs.all[name], "\(name) missing")
            #expect(svg.contains("viewBox=\"0 0 \(Int(g.grid)) \(Int(g.grid))\""), "\(name) grid")
            var expected: [Tokens.Glyphs.Primitive] = []
            for m in svg.matches(of: /<(rect|path)\b([^>]*)\/>/) {
                let attrs = Dictionary(String(m.2).matches(of: /([a-zA-Z-]+)="([^"]*)"/).map { (String($0.1), String($0.2)) }, uniquingKeysWith: { a, _ in a })
                func n(_ k: String) -> CGFloat { CGFloat(Double(attrs[k] ?? "0") ?? .nan) }
                if m.1 == "rect" {
                    expected.append(.rect(CGRect(x: n("x"), y: n("y"), width: n("width"), height: n("height"))))
                } else {
                    let nums = (attrs["d"] ?? "").replacingOccurrences(of: "M", with: " ").replacingOccurrences(of: "L", with: " ")
                        .replacingOccurrences(of: "Z", with: " ").split(separator: " ").compactMap { Double($0) }
                    let pts = stride(from: 0, to: nums.count - 1, by: 2).map { CGPoint(x: nums[$0], y: nums[$0 + 1]) }
                    expected.append(attrs["fill"] == "none" ? .stroke(pts, width: n("stroke-width")) : .fill(pts))
                }
            }
            #expect(g.primitives == expected, "\(name): run node macos/scripts/sync-design.mjs")
        }
    }
}

@Suite @MainActor struct GlyphRendererTests {
    /// Alpha mask of a template glyph at `px` pixels (template images carry the shape in alpha only).
    static func mask(_ image: NSImage, px: Int = 36) -> [UInt8] {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
        NSGraphicsContext.restoreGraphicsState()
        var out: [UInt8] = []
        for y in 0..<px { for x in 0..<px { out.append(UInt8(((rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) * 255).rounded())) } }
        return out
    }

    static func differ(_ a: [UInt8], _ b: [UInt8]) -> Int { zip(a, b).filter { abs(Int($0) - Int($1)) > 64 }.count }

    /// Every state (the six finding states and the six app states) has its own silhouette at 16 and 18 pt, without colour
    /// (the glyph shape rule, DESIGN.md §6), and none is the mark.
    @Test(arguments: [CGFloat(16), 18])
    func everyGlyphHasItsOwnShape(_ pt: CGFloat) {
        let r = Theme.current.glyphs
        let masks = MenuBarGlyph.allCases.map { ($0, Self.mask(r.menuBarImage($0, pointSize: pt))) }
        let mark = Self.mask(r.markImage(grid: .forPointSize(pt), pointSize: pt))
        for (i, a) in masks.enumerated() {
            #expect(a.1.contains { $0 > 128 }, "\(a.0) draws nothing")
            #expect(Self.differ(a.1, mark) > 20, "\(a.0) looks like the mark at \(pt) pt")
            for b in masks[(i + 1)...] {
                #expect(Self.differ(a.1, b.1) > 20, "\(a.0) and \(b.0) look the same at \(pt) pt")
            }
        }
    }

    @Test func youAndAgentAreNotMirrorImages() {
        let r = Theme.current.glyphs
        let px = 36
        let you = Self.mask(r.menuBarImage(.you, pointSize: 18), px: px)
        let agent = Self.mask(r.menuBarImage(.agent, pointSize: 18), px: px)
        let flippedV = (0..<px).flatMap { y in you[((px - 1 - y) * px)..<((px - y) * px)] }
        let flippedH = (0..<px).flatMap { y in you[(y * px)..<((y + 1) * px)].reversed() }
        #expect(Self.differ(flippedV, agent) > 40 && Self.differ(flippedH, agent) > 40)
    }

    /// The design glyphs are drawn on their own pixel grid: at true 1× 16 pt, `none` is exactly the SVG's
    /// `rect(1, 7, 14, 2)`, crisp (no anti-aliased rows).
    @Test func designGlyphsArePixelExactAtOneX() {
        let image = Theme.current.glyphs.menuBarImage(.noDetectableChange, pointSize: 16)
        let m = Self.mask(image, px: 16)
        for y in 0..<16 {
            for x in 0..<16 {
                let inRule = (1..<15).contains(x) && (7..<9).contains(y)    // rows 7 and 8 either way up
                #expect(m[y * 16 + x] == (inRule ? 255 : 0), "pixel \(x),\(y)")
            }
        }
    }

    /// Every glyph made only of rects (all the app states, most finding states) is pixel-exact at true 1× on both grids:
    /// the mask is exactly the union of its design rects, with no anti-aliased edge.
    @Test(arguments: [GlyphGrid.g16, .g18])
    func rectGlyphsArePixelExactAtOneX(_ grid: GlyphGrid) {
        let px = grid.rawValue
        for g in MenuBarGlyph.allCases {
            let prims = CaseFileGlyphRenderer.primitives(g, grid: grid)
            var rects: [CGRect] = []
            for p in prims { if case .rect(let r) = p { rects.append(r) } }
            guard rects.count == prims.count, !rects.isEmpty else { continue }   // stale (stroke), you/agent/unclear (triangles)
            let m = Self.mask(Theme.current.glyphs.templateImage(g, grid: grid, pointSize: CGFloat(px)), px: px)
            for y in 0..<px {
                for x in 0..<px {
                    // the image is flipped (y down) like the SVG; the bitmap's row 0 is its top
                    let inside = rects.contains { $0.contains(CGPoint(x: CGFloat(x) + 0.5, y: CGFloat(y) + 0.5)) }
                    #expect(m[y * px + x] == (inside ? 255 : 0), "\(g) \(px) px: pixel \(x),\(y)")
                }
            }
        }
    }

    @Test func menuBarImagesAreTemplates() {
        let r = Theme.current.glyphs
        for g in MenuBarGlyph.allCases {
            #expect(r.menuBarImage(g, pointSize: 18).isTemplate, "\(g) must be a template image so the menu bar can tint it")
            #expect(r.menuBarImage(g, pointSize: 16).size == NSSize(width: 16, height: 16))
        }
        #expect(r.markImage(grid: .g18, pointSize: 18).isTemplate)
    }
}
