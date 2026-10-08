import AppKit
import WasitmeCore

/// The two design grids a glyph is drawn on (DESIGN.md §6: "each size is drawn on its own pixel grid, not scaled").
public enum GlyphGrid: Int, Sendable, CaseIterable {
    case g16 = 16, g18 = 18

    /// The grid for a menu bar size: the 18 px drawing from 18 pt up, the 16 px one below.
    public static func forPointSize(_ pt: CGFloat) -> GlyphGrid { pt >= 18 ? .g18 : .g16 }
}

/// Draws the state glyphs. Behind a protocol so a view never draws a glyph itself.
public protocol GlyphRendering: Sendable {
    /// Template image (black and alpha only; the system tints it) of a glyph drawn on `grid`, at `pointSize`.
    func templateImage(_ glyph: MenuBarGlyph, grid: GlyphGrid, pointSize: CGFloat) -> NSImage
    /// The mono mark (the two sides with no rule; never a state, never in the menu bar), as a template image.
    func markImage(grid: GlyphGrid, pointSize: CGFloat) -> NSImage
}

public extension GlyphRendering {
    /// The menu bar image: the glyph on the grid that matches the point size, as a template.
    func menuBarImage(_ glyph: MenuBarGlyph, pointSize: CGFloat) -> NSImage {
        templateImage(glyph, grid: .forPointSize(pointSize), pointSize: pointSize)
    }
}

/// Case File glyphs (DESIGN.md §6, D57): one rule; your side a square above it, the agent's a triangle below it; none
/// is the bare rule, unclear both shapes, insufficient a dashed rule with specks, stale the struck rule.
///
/// The app's own document states (tokens.json appStates) change the rule itself and never put a square above or a
/// triangle below it: loading three dots, not set up empty brackets, no agents the ticked rule, can't read the rule and
/// an exclamation mark, update needed two rules out of step, not shown the rule blacked out.
///
/// Every glyph (states, app states, mark) is drawn from `Tokens.Glyphs`, generated from design/system/glyphs/*.svg, so
/// the pixels are the design's (measured by design/system/gen/glyph-check.mjs).
public struct CaseFileGlyphRenderer: GlyphRendering {
    public init() {}

    public func templateImage(_ glyph: MenuBarGlyph, grid: GlyphGrid, pointSize: CGFloat) -> NSImage {
        let primitives = Self.primitives(glyph, grid: grid)
        return Self.image(primitives, grid: CGFloat(grid.rawValue), pointSize: pointSize)
    }

    public func markImage(grid: GlyphGrid, pointSize: CGFloat) -> NSImage {
        let g = Tokens.Glyphs.all["mark-\(grid.rawValue)"]
        return Self.image(g?.primitives ?? [], grid: CGFloat(grid.rawValue), pointSize: pointSize)
    }

    /// The design file's name for a glyph ("state-none-16", "app-not-set-up-18"): every MenuBarGlyph has one.
    static func designName(_ glyph: MenuBarGlyph, grid: GlyphGrid) -> String {
        if let s = glyph.findingState { return grid == .g18 ? s.menuBarImage18 : s.menuBarImage16 }
        let a = glyph.appState ?? .unreadable    // every non-finding glyph is an app state (MenuBarGlyph.appState)
        return grid == .g18 ? a.menuBarImage18 : a.menuBarImage16
    }

    /// The glyph's primitives. A missing design file draws nothing (DesignSyncTests and GlyphRendererTests catch it).
    static func primitives(_ glyph: MenuBarGlyph, grid: GlyphGrid) -> [Tokens.Glyphs.Primitive] {
        Tokens.Glyphs.all[designName(glyph, grid: grid)]?.primitives ?? []
    }

    /// A template image drawn at the display's backing scale (the drawing handler runs per scale, so a 1 px design rect
    /// stays one device pixel at 1× and two at 2×).
    static func image(_ primitives: [Tokens.Glyphs.Primitive], grid: CGFloat, pointSize: CGFloat) -> NSImage {
        let image = NSImage(size: NSSize(width: pointSize, height: pointSize), flipped: true) { rect in
            draw(primitives, grid: grid, in: rect, color: .black)
            return true
        }
        image.isTemplate = true
        return image
    }

    /// Fills/strokes the primitives (SVG coordinates, y down; the image is flipped to match) scaled from the grid.
    static func draw(_ primitives: [Tokens.Glyphs.Primitive], grid: CGFloat, in rect: NSRect, color: NSColor) {
        let s = min(rect.width, rect.height) / grid
        let ox = rect.minX + (rect.width - grid * s) / 2, oy = rect.minY + (rect.height - grid * s) / 2
        func p(_ q: CGPoint) -> NSPoint { NSPoint(x: ox + q.x * s, y: oy + q.y * s) }
        color.setFill()
        color.setStroke()
        for prim in primitives {
            switch prim {
            case .rect(let r):
                NSBezierPath(rect: NSRect(x: ox + r.minX * s, y: oy + r.minY * s, width: r.width * s, height: r.height * s)).fill()
            case .fill(let pts):
                guard let first = pts.first else { continue }
                let path = NSBezierPath()
                path.move(to: p(first))
                for q in pts.dropFirst() { path.line(to: p(q)) }
                path.close()
                path.fill()
            case .stroke(let pts, let width):
                guard let first = pts.first else { continue }
                let path = NSBezierPath()
                path.move(to: p(first))
                for q in pts.dropFirst() { path.line(to: p(q)) }
                path.lineWidth = width * s
                path.lineCapStyle = .butt
                path.stroke()
            }
        }
    }
}
