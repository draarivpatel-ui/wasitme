// GENERATED from design/system/tokens.json by design/system/gen/build.mjs. Do not edit by hand.
// Zero dependencies. Import from the engine/CLI and the Claude Code mod; never hand-edit.

export const tokens = {
  "color": {
    "light": {
      "surface": {
        "page": "#F1F0EC",
        "sheet": "#FCFCFA",
        "sidebar": "#EAE9E4",
        "raised": "#FFFFFF",
        "well": "#F4F3EF",
        "selection": "#E3E2DC"
      },
      "rule": {
        "hair": "#DEDDD6",
        "strong": "#B8B7AF",
        "ink": "#1C1D21"
      },
      "ink": {
        "primary": "#1C1D21",
        "secondary": "#46474D",
        "muted": "#5E5F64",
        "onInk": "#FCFCFA"
      },
      "accent": {
        "action": "#1C1D21",
        "actionText": "#FCFCFA",
        "focus": "#1C1D21"
      },
      "party": {
        "you": {
          "fill": "#F5C842",
          "ink": "#1C1D21",
          "keyline": "#1C1D21",
          "tint": "#FAF0D0"
        },
        "agent": {
          "fill": "#8DBCF0",
          "ink": "#1C1D21",
          "keyline": "#1C1D21",
          "tint": "#E7EEFB"
        }
      },
      "chart": {
        "mark": "#1C1D21",
        "axis": "#1C1D21",
        "grid": "#E6E5DF",
        "label": "#5E5F64",
        "range": "#1C1D21",
        "estimate": "#1C1D21",
        "mdeFill": "#EFEEE9",
        "mdeHatch": "#85868A",
        "connector": "#85868A"
      },
      "state": {
        "insufficient": {
          "fg": "#46474D",
          "bg": "#FCFCFA",
          "glyph": "#46474D",
          "edge": "#66676C",
          "edgeStyle": "dashed"
        },
        "none": {
          "fg": "#FCFCFA",
          "bg": "#1C1D21",
          "glyph": "#FCFCFA",
          "edge": "#1C1D21",
          "edgeStyle": "solid"
        },
        "unclear": {
          "fg": "#1C1D21",
          "bg": "#FCFCFA",
          "glyph": "#1C1D21",
          "edge": "#1C1D21",
          "edgeStyle": "solid",
          "swatch": [
            "#F5C842",
            "#8DBCF0"
          ]
        },
        "you": {
          "fg": "#1C1D21",
          "bg": "#F5C842",
          "glyph": "#1C1D21",
          "edge": "#1C1D21",
          "edgeStyle": "solid"
        },
        "agent": {
          "fg": "#1C1D21",
          "bg": "#8DBCF0",
          "glyph": "#1C1D21",
          "edge": "#1C1D21",
          "edgeStyle": "solid"
        },
        "stale": {
          "fg": "#46474D",
          "bg": "#FCFCFA",
          "glyph": "#46474D",
          "edge": "#66676C",
          "edgeStyle": "dotted"
        }
      }
    },
    "dark": {
      "surface": {
        "page": "#131418",
        "sheet": "#1B1C21",
        "sidebar": "#17181C",
        "raised": "#23242A",
        "well": "#202126",
        "selection": "#2D2E34"
      },
      "rule": {
        "hair": "#2E2F36",
        "strong": "#4A4B53",
        "ink": "#ECEBE6"
      },
      "ink": {
        "primary": "#ECEBE6",
        "secondary": "#B9B8B2",
        "muted": "#9C9B95",
        "onInk": "#1B1C21"
      },
      "accent": {
        "action": "#ECEBE6",
        "actionText": "#1B1C21",
        "focus": "#ECEBE6"
      },
      "party": {
        "you": {
          "fill": "#F2C230",
          "ink": "#1B1C21",
          "keyline": "#F2C230",
          "tint": "#332B14"
        },
        "agent": {
          "fill": "#8CC4F2",
          "ink": "#1B1C21",
          "keyline": "#8CC4F2",
          "tint": "#182838"
        }
      },
      "chart": {
        "mark": "#ECEBE6",
        "axis": "#ECEBE6",
        "grid": "#2A2B31",
        "label": "#9C9B95",
        "range": "#ECEBE6",
        "estimate": "#ECEBE6",
        "mdeFill": "#25262C",
        "mdeHatch": "#74757B",
        "connector": "#74757B"
      },
      "state": {
        "insufficient": {
          "fg": "#B9B8B2",
          "bg": "#1B1C21",
          "glyph": "#B9B8B2",
          "edge": "#8F8E89",
          "edgeStyle": "dashed"
        },
        "none": {
          "fg": "#1B1C21",
          "bg": "#ECEBE6",
          "glyph": "#1B1C21",
          "edge": "#ECEBE6",
          "edgeStyle": "solid"
        },
        "unclear": {
          "fg": "#ECEBE6",
          "bg": "#1B1C21",
          "glyph": "#ECEBE6",
          "edge": "#ECEBE6",
          "edgeStyle": "solid",
          "swatch": [
            "#F2C230",
            "#8CC4F2"
          ]
        },
        "you": {
          "fg": "#1B1C21",
          "bg": "#F2C230",
          "glyph": "#1B1C21",
          "edge": "#F2C230",
          "edgeStyle": "solid"
        },
        "agent": {
          "fg": "#1B1C21",
          "bg": "#8CC4F2",
          "glyph": "#1B1C21",
          "edge": "#8CC4F2",
          "edgeStyle": "solid"
        },
        "stale": {
          "fg": "#B9B8B2",
          "bg": "#1B1C21",
          "glyph": "#B9B8B2",
          "edge": "#8F8E89",
          "edgeStyle": "dotted"
        }
      }
    }
  },
  "states": {
    "insufficient": {
      "label": "Too early to tell",
      "headline": "Too early to tell.",
      "legend": "Dashed rule, two specks: too early to tell",
      "textGlyph": "·┄·",
      "ascii": "[..]",
      "voiceOver": "wasitme: too early to tell"
    },
    "none": {
      "label": "No detectable change",
      "headline": "No detectable change.",
      "legend": "Bare rule: no detectable change",
      "textGlyph": "───",
      "ascii": "[none]",
      "voiceOver": "wasitme: no detectable change"
    },
    "unclear": {
      "label": "Can't tell which",
      "headline": "Can't tell which.",
      "legend": "Square and triangle: can't tell which",
      "textGlyph": "■─▲",
      "ascii": "[?]",
      "voiceOver": "wasitme: numbers moved, can't tell which change"
    },
    "you": {
      "label": "Your side",
      "headline": "Your side changed.",
      "legend": "Square above the rule: your side changed",
      "textGlyph": "■──",
      "ascii": "[you]",
      "voiceOver": "wasitme: your side changed"
    },
    "agent": {
      "label": "Agent side",
      "headline": "The agent changed.",
      "legend": "Triangle below the rule: the agent changed",
      "textGlyph": "──▲",
      "ascii": "[agent]",
      "voiceOver": "wasitme: the agent changed"
    },
    "stale": {
      "label": "Out of date",
      "headline": "Out of date.",
      "legend": "Struck-through rule: out of date",
      "textGlyph": "─╱─",
      "ascii": "[stale]",
      "voiceOver": "wasitme: out of date, last checked {when}"
    }
  },
  "stateOrder": [
    "insufficient",
    "none",
    "unclear",
    "you",
    "agent"
  ],
  "appStates": {
    "order": [
      "loading",
      "notSetUp",
      "empty",
      "unreadable",
      "updateNeeded",
      "refused"
    ],
    "chip": {
      "fg": "ink.secondary",
      "bg": "surface.sheet",
      "glyph": "ink.secondary",
      "edge": "rule.strong",
      "edgeStyle": "solid"
    },
    "loading": {
      "label": "Loading",
      "legend": "Three dots: loading"
    },
    "notSetUp": {
      "label": "Not set up yet",
      "legend": "Empty brackets: not set up yet"
    },
    "empty": {
      "label": "No agents yet",
      "legend": "Ticked rule, nothing on it: no agents yet"
    },
    "unreadable": {
      "label": "Can't read status",
      "legend": "Rule and exclamation mark: can't read status"
    },
    "updateNeeded": {
      "label": "Update needed",
      "legend": "Two rules out of step: update needed"
    },
    "refused": {
      "label": "Not shown",
      "legend": "Blacked-out rule: not shown"
    }
  },
  "newEvent": {
    "text": "+{n}"
  },
  "terminal": {
    "sgr": {
      "ansi16": {
        "stickerYou": "7",
        "stickerAgent": "7",
        "chipNone": "7",
        "chipInsufficient": "2",
        "chipStale": "2",
        "chipUnclear": "the text glyph and the words in the default colours (no colour cells)",
        "muted": "2",
        "rule": "2",
        "emphasis": "1",
        "brandUnderline": "4",
        "why": "16-colour mode (TERM without 256color: tmux/screen defaults, the Linux console) cannot know the palette, and common themes remap the bright colours (Solarized: bright yellow and bright cyan are greys; black on them is 2.92:1 and the two stickers look alike). Reverse video swaps the theme's own fg and bg, so a sticker always has the theme's contrast. Your stickers and the agent's look alike here; the numeral vs letter, above vs below the line, and the words carry the party. muted and rule stay SGR 2 (dim) because no grey is safe without knowing the palette; how each terminal draws dim is not checked (DESIGN.md section 12). Rules and glyphs are never bold (Menlo Bold has no box-drawing glyphs)."
      },
      "ansi256": {
        "dark": {
          "stickerYou": "38;5;16;48;5;221",
          "stickerAgent": "38;5;16;48;5;117",
          "muted": "38;5;246",
          "rule": "38;5;243",
          "emphasis": "1"
        },
        "light": {
          "stickerYou": "38;5;16;48;5;221",
          "stickerAgent": "38;5;16;48;5;117",
          "muted": "38;5;242",
          "rule": "38;5;244",
          "emphasis": "1"
        },
        "xterm256Hex": {
          "16": "#000000",
          "117": "#87D7FF",
          "221": "#FFD75F",
          "242": "#6C6C6C",
          "243": "#767676",
          "244": "#808080",
          "246": "#949494"
        }
      },
      "truecolor": {
        "stickerYou": "color.<mode>.party.you.fill behind color.<mode>.party.you.ink",
        "stickerAgent": "color.<mode>.party.agent.fill behind color.<mode>.party.agent.ink",
        "dark": {
          "muted": "#9C9B95",
          "rule": "#74757B"
        },
        "light": {
          "muted": "#66676B",
          "rule": "#85868A"
        },
        "why": "Explicit greys (38;2;r;g;b), not SGR 2 dim: dim is drawn differently by every terminal and a 50% blend falls under 4.5:1. Each grey is gated against every declared background of its mode (report: 'terminal greys'). The mode comes from chooseMode; a light terminal that does not set COLORFGBG lands in the dark greys (the same risk ansi256 has)."
      },
      "noColor": {
        "rule": "NO_COLOR or a pipe: no escape codes at all. Stickers become [1] and [A]; the state is the text glyph plus its words, e.g. '·┄· too early to tell'.",
        "stickerYou": "[{n}]",
        "stickerAgent": "[{letter}]"
      }
    },
    "backgrounds": {
      "darkMock": {
        "bg": "#16171B",
        "fg": "#D9D8D3",
        "muted": "#8E8D88",
        "status": "mock theme (our own)"
      },
      "lightMock": {
        "bg": "#FBFBF8",
        "fg": "#26272B",
        "muted": "#66676B",
        "status": "mock theme (our own)"
      },
      "ansi16Mock": {
        "bg": "#000000",
        "fg": "#E5E5E5",
        "muted": "#7F7F7F",
        "status": "mock theme: xterm palette 0 / 7, muted = palette 8"
      },
      "codeTabLight": {
        "bg": "#FAF9F5",
        "fg": "#3D3D3A",
        "muted": "#6B6A65",
        "status": "assumed - replace with a capture of the Claude Desktop Code tab"
      },
      "codeTabDark": {
        "bg": "#262624",
        "fg": "#E8E6E1",
        "muted": "#A3A19B",
        "status": "assumed - replace with a capture of the Claude Desktop Code tab"
      }
    }
  },
  "modPane": {
    "byClaudeTheme": {
      "dark": {
        "stickerYou": {
          "color": "#1B1C21",
          "backgroundColor": "#F2C230"
        },
        "stickerAgent": {
          "color": "#1B1C21",
          "backgroundColor": "#8CC4F2"
        }
      },
      "light": {
        "stickerYou": {
          "color": "#1C1D21",
          "backgroundColor": "#F5C842"
        },
        "stickerAgent": {
          "color": "#1C1D21",
          "backgroundColor": "#8DBCF0"
        }
      },
      "ansi": {
        "stickerYou": {
          "color": "black",
          "backgroundColor": "yellowBright"
        },
        "stickerAgent": {
          "color": "black",
          "backgroundColor": "cyanBright"
        }
      }
    },
    "themeMatch": "Theme names containing 'light' use 'light'; names containing 'ansi' use 'ansi'; everything else uses 'dark'. Theme names are read from the theme config row; the exact list was not verified for this build.",
    "ansiRisk": "The 'ansi' family names terminal palette colours, so it has the 16-colour palette risk (Solarized greys out yellowBright/cyanBright). If the mod kit's Text supports inverse, use inverse instead, as terminal.sgr.ansi16 does; not verified for this build.",
    "secondary": {
      "dimColor": true
    },
    "rule": {
      "dimColor": true
    },
    "emphasis": {
      "bold": true
    },
    "buttons": "Claude Code draws Buttons itself; the primary action (Report) uses variant=primary, everything else default.",
    "layout": "Buttons first so an 80-column inline pane can't clip them (plugin/README.md, What the mod shows)."
  },
  "copy": {
    "privacyLine": "No network code. Only the installer downloads, and only when you run it.",
    "privacyShort": "local only",
    "disclaimer": "These indicators don't measure answer quality. Evidence, not proof.",
    "tagline": "Measure twice, blame once.",
    "question": "Was it me, or the model?"
  },
  "glanceBanned": "\\b(worse|better|nerf\\w*|degrad\\w*|improv\\w*)\\b",
  "size": {
    "popover": {
      "width": 352,
      "height": 480
    },
    "panelSmall": {
      "width": 170,
      "height": 170
    },
    "panelMedium": {
      "width": 360,
      "height": 170
    },
    "controlCenter": {
      "width": 1280,
      "height": 800
    },
    "controlCenterMinimum": {
      "width": 900,
      "height": 600
    },
    "menuBarGlyphLarge": 18,
    "menuBarGlyphSmall": 16,
    "chipHeight": 26,
    "chipGlyph": 16,
    "chipSwatch": 9,
    "sticker": {
      "width": 20,
      "height": 20
    },
    "tag": {
      "width": 20,
      "height": 22
    },
    "badgeYou": {
      "width": 18,
      "height": 18
    },
    "badgeAgent": {
      "width": 18,
      "height": 20
    },
    "buttonHeight": 30,
    "buttonCompactHeight": 28,
    "panelGlyph": 30,
    "pinGlyph": 22
  },
  "chart": {
    "strip": {
      "tickHeight": 2,
      "tickGap": 1,
      "denseAbove": 25,
      "denseTickHeight": 1,
      "denseTickGap": 1,
      "maxTicks": 60,
      "columnWidth": 14,
      "columnGap": 6,
      "compactColumnWidth": 6,
      "compactColumnGap": 3,
      "lowNThreshold": 100
    },
    "ratio": {
      "domain": [
        0.25,
        8
      ],
      "ticks": [
        0.5,
        1,
        2,
        4
      ],
      "rangeStroke": 2
    },
    "timelineRule": 2
  }
} as const;

export type FindingState = keyof typeof tokens.states;
export type Party = 'you' | 'agent';
export type ColorMode = 'none' | 'ansi16' | 'ansi256-dark' | 'ansi256-light' | 'truecolor-dark' | 'truecolor-light';

const ESC = '\u001b[';
const wrap = (sgr: string, text: string): string => (sgr ? ESC + sgr + 'm' + text + ESC + '0m' : text);
const rgb = (hex: string): string => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';');

/** Pick the colour mode from the environment (see tokens.json terminal.choose). */
export function chooseMode(env: Record<string, string | undefined>, isTTY: boolean): ColorMode {
  if (!isTTY || env.NO_COLOR !== undefined || env.TERM === 'dumb') return 'none';
  const fgbg = env.COLORFGBG ?? '';
  const light = /;(15|7)$/.test(fgbg);
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return light ? 'truecolor-light' : 'truecolor-dark';
  if ((env.TERM ?? '').includes('256color')) return light ? 'ansi256-light' : 'ansi256-dark';
  return 'ansi16';
}

/** A party sticker: " 1 " on canary or " A " on blue; reverse video in 16 colours; "[1]" / "[A]" without colour. */
export function sticker(party: Party, text: string, mode: ColorMode): string {
  if (mode === 'none') return '[' + text + ']';
  const key = party === 'you' ? 'stickerYou' : 'stickerAgent';
  if (mode === 'ansi16') return wrap(tokens.terminal.sgr.ansi16[key], ' ' + text + ' ');
  if (mode === 'ansi256-dark' || mode === 'ansi256-light') {
    const m = mode === 'ansi256-dark' ? tokens.terminal.sgr.ansi256.dark : tokens.terminal.sgr.ansi256.light;
    return wrap(m[key], ' ' + text + ' ');
  }
  const c = (mode === 'truecolor-dark' ? tokens.color.dark : tokens.color.light).party[party];
  return wrap('38;2;' + rgb(c.ink) + ';48;2;' + rgb(c.fill), ' ' + text + ' ');
}

/** Secondary text, rules and emphasis: explicit greys in 256 and truecolor modes, SGR 2 only in 16 colours. Never bold on box-drawing glyphs. */
export function styled(role: 'muted' | 'rule' | 'emphasis' | 'brandUnderline', text: string, mode: ColorMode): string {
  if (mode === 'none') return text;
  if (role === 'brandUnderline') return wrap('4', text);
  if (role === 'emphasis') return wrap('1', text);
  // 16 colours: no grey is safe without knowing the palette, so muted text and rules use SGR 2 (dim) here only.
  if (mode === 'ansi16') return wrap(role === 'muted' ? tokens.terminal.sgr.ansi16.muted : tokens.terminal.sgr.ansi16.rule, text);
  if (mode === 'truecolor-dark' || mode === 'truecolor-light') {
    const g = mode === 'truecolor-dark' ? tokens.terminal.sgr.truecolor.dark : tokens.terminal.sgr.truecolor.light;
    return wrap('38;2;' + rgb(role === 'muted' ? g.muted : g.rule), text);
  }
  const m = mode === 'ansi256-dark' ? tokens.terminal.sgr.ansi256.dark : tokens.terminal.sgr.ansi256.light;
  return wrap(role === 'muted' ? m.muted : m.rule, text);
}

/** The three-cell text glyph, or its ASCII fallback. */
export function stateGlyph(state: FindingState, ascii = false): string {
  return ascii ? tokens.states[state].ascii : tokens.states[state].textGlyph;
}

/** One-row status line: the state and an optional new-change count. Never a cause, never a quality word. */
export function statusLine(state: FindingState, newChanges: number, mode: ColorMode, ascii = false): string {
  const s = tokens.states[state];
  let label: string = s.label.toLowerCase();
  if (state === 'you') label = sticker('you', label, mode);
  else if (state === 'agent') label = sticker('agent', label, mode);
  const extra = newChanges > 0 ? '  ' + styled('muted', tokens.newEvent.text.replace('{n}', String(newChanges)), mode) : '';
  const brand = 'wasit' + styled('brandUnderline', 'me', mode);
  return brand + '  ' + stateGlyph(state, ascii) + ' ' + label + extra;
}

/** Mod-pane sticker props for a Claude Code theme name. */
export function modSticker(party: Party, claudeTheme: string): { color: string; backgroundColor: string } {
  const t = claudeTheme.toLowerCase();
  const fam = t.includes('ansi') ? 'ansi' : t.includes('light') ? 'light' : 'dark';
  const m = tokens.modPane.byClaudeTheme[fam];
  return party === 'you' ? m.stickerYou : m.stickerAgent;
}
