/**
 * A cell grid for the CLI's fixed-width layouts (the same idea as design/system/gen/screens/term.mjs `Grid`, which draws
 * the text-*.png screens through the same tokens module). Text is placed at (row, column) with a ROLE; `render` turns
 * runs of the same role into the design system's escape codes (`design-tokens.ts`), so colour exists only where the
 * design puts it: party stickers use background colour (reverse video in 16 colours, `[1]` / `[A]` without colour),
 * muted text and rules use explicit greys, and everything else is the terminal's own foreground.
 *
 * Differences from the mock-up's grid, on purpose: text that does not fit is CUT at the right edge (never throws, so a
 * long label can't crash the report), rows grow on demand, and trailing blanks are dropped (output is pipe-friendly and
 * the goldens carry no trailing whitespace).
 */
import { sticker, styled, type ColorMode, type Party } from "../cli/design-tokens.js";
import { charWidth, clean, cols } from "./text.js";

export type Role = "plain" | "muted" | "rule" | "bold" | "ul" | "you" | "agent";

interface Cell { ch: string; role: Role; g: number }

/** Box-drawing and block characters → ASCII, for TERM=linux consoles and WASITME_ASCII=1. */
const ASCII_MAP: Readonly<Record<string, string>> = {
  "═": "=", "─": "-", "┄": ".", "┬": "+", "┴": "+", "┼": "+", "├": "|", "┤": "|", "│": "|", "└": "+", "┘": "+",
  "░": "#", "●": "*", "○": "o", "×": "x", "–": "-", "—": "-", "→": ">", "·": ".", "’": "'", "■": "#", "▲": "^", "…": "~", "╱": "/",
};

export class Grid {
  readonly rows: Cell[][] = [];
  private gid = 1;

  constructor(readonly width: number) {}

  private row(r: number): Cell[] {
    while (this.rows.length <= r) this.rows.push(Array.from({ length: this.width }, () => ({ ch: " ", role: "plain" as Role, g: 0 })));
    return this.rows[r]!;
  }

  /** Number of rows touched so far. */
  get height(): number {
    return this.rows.length;
  }

  /**
   * Put `text` (cleaned here) at (r, c); returns the column after it. A wide character takes two cells (the second is
   * empty), a combining mark joins the cell before it, and cells past the right edge are dropped.
   */
  at(r: number, c: number, text: string, role: Role = "plain"): number {
    const g = this.gid++;
    const cells = this.row(r);
    let x = c;
    for (const ch of clean(text)) {
      const w = charWidth(ch.codePointAt(0)!);
      if (w === 0) {
        const prev = cells[x - 1];
        if (prev !== undefined && x - 1 >= c && prev.ch !== "") prev.ch += ch;
        continue;
      }
      if (x >= 0 && x < this.width && !(w === 2 && x + 1 >= this.width)) {
        cells[x] = { ch, role, g };
        if (w === 2) cells[x + 1] = { ch: "", role, g };
      }
      x += w;
    }
    return x;
  }

  /** Put `text` so it ends at column `width - pad`. */
  right(r: number, text: string, role: Role = "plain", pad = 0): number {
    const t = clean(text);
    return this.at(r, this.width - pad - cols(t), t, role);
  }

  /** The grid as terminal lines (no trailing newline). */
  render(mode: ColorMode, ascii = false): string[] {
    return this.rows.map((cells) => {
      let end = cells.length;
      while (end > 0 && cells[end - 1]!.ch === " " && cells[end - 1]!.role !== "you" && cells[end - 1]!.role !== "agent") end--;
      let out = "";
      let i = 0;
      while (i < end) {
        const { role, g } = cells[i]!;
        let j = i;
        let txt = "";
        while (j < end && cells[j]!.role === role && (role === "plain" || role === "muted" || role === "rule" || role === "bold" || role === "ul" || cells[j]!.g === g)) {
          txt += cells[j]!.ch;
          j++;
        }
        if (ascii) txt = [...txt].map((ch) => ASCII_MAP[ch] ?? (ch.charCodeAt(0) > 126 ? "?" : ch)).join("");
        out += role === "plain" ? txt
          : role === "you" || role === "agent" ? sticker(role as Party, txt.trim(), mode)
          : role === "ul" ? styled("brandUnderline", txt, mode)
          : role === "bold" ? styled("emphasis", txt, mode)
          : styled(role, txt, mode);
        i = j;
      }
      return out;
    });
  }
}
