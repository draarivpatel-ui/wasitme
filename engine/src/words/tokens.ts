/**
 * The part of design/system/tokens.json the engine speaks with (D57): one label, headline, legend line, text glyph,
 * ASCII form and VoiceOver string per state, the "Timeline only" display for calibration_pending, the "+n" form for
 * new changes, and the fixed product sentences.
 *
 * This is a COPY, because the engine cannot import across its rootDir and ships `dist/src` only. It is held to the
 * source byte for byte by engine/test/words/tokens-sync.test.ts (the same way design/system/gen/test.mjs holds the
 * engine's DISCLAIMER to tokens.json). Edit tokens.json first, then this file; never the other way round.
 */

export const STATE_WORDS = {
  insufficient: {
    label: "Too early to tell",
    headline: "Too early to tell.",
    legend: "Dashed rule, two specks: too early to tell",
    textGlyph: "·┄·",
    ascii: "[..]",
    voiceOver: "wasitme: too early to tell",
  },
  none: {
    label: "No detectable change",
    headline: "No detectable change.",
    legend: "Bare rule: no detectable change",
    textGlyph: "───",
    ascii: "[none]",
    voiceOver: "wasitme: no detectable change",
  },
  unclear: {
    label: "Can't tell which",
    headline: "Can't tell which.",
    legend: "Square and triangle: can't tell which",
    textGlyph: "■─▲",
    ascii: "[?]",
    voiceOver: "wasitme: numbers moved, can't tell which change",
  },
  you: {
    label: "Your side",
    headline: "Your side changed.",
    legend: "Square above the rule: your side changed",
    textGlyph: "■──",
    ascii: "[you]",
    voiceOver: "wasitme: your side changed",
  },
  agent: {
    label: "Agent side",
    headline: "The agent changed.",
    legend: "Triangle below the rule: the agent changed",
    textGlyph: "──▲",
    ascii: "[agent]",
    voiceOver: "wasitme: the agent changed",
  },
  stale: {
    label: "Out of date",
    headline: "Out of date.",
    legend: "Struck-through rule: out of date",
    textGlyph: "─╱─",
    ascii: "[stale]",
    voiceOver: "wasitme: out of date, last checked {when}",
  },
} as const;

/** insufficient + calibration_pending is shown as "Timeline only" (a reason's display, not a state; CONTRACT decision 12). */
export const CALIBRATION_PENDING_WORDS = {
  label: "Timeline only",
  headline: "Timeline only, for now.",
} as const;

/** Glance surfaces may add only this count beside the state (tokens.json states.newEvent). */
export const NEW_EVENT_WORDS = {
  text: "+{n}",
  voiceOver: {
    one: ", {n} new change on the timeline",
    other: ", {n} new changes on the timeline",
  },
} as const;

export const PRODUCT_WORDS = {
  privacyLine: "No network code. Only the installer downloads, and only when you run it.",
  privacyShort: "local only",
  disclaimer: "These indicators don't measure answer quality. Evidence, not proof.",
  tagline: "Measure twice, blame once.",
  question: "Was it me, or the model?",
} as const;
