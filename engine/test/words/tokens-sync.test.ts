// The engine's copy of the design tokens (engine/src/words/tokens.ts) is the design system's, byte for byte (D57).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DISCLAIMER } from "../../src/contract/check.js";
import {
  CALIBRATION_PENDING_WORDS, GLANCE_BANNED, NEW_EVENT_WORDS, PRODUCT_WORDS, STATE_WORDS,
} from "../../src/words/index.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const tokens = JSON.parse(readFileSync(`${ROOT}design/system/tokens.json`, "utf8")) as Record<string, any>;

test("state words equal tokens.json states (label, headline, legend, text glyph, ASCII, VoiceOver)", () => {
  const states = tokens.states as Record<string, any>;
  const names = [...states.order, ...states.displayOnly] as string[];
  assert.deepEqual(Object.keys(STATE_WORDS).sort(), [...names].sort());
  for (const s of names) {
    const { label, headline, legend, textGlyph, ascii, voiceOver } = states[s];
    assert.deepEqual(STATE_WORDS[s as keyof typeof STATE_WORDS], { label, headline, legend, textGlyph, ascii, voiceOver }, s);
  }
  assert.deepEqual(CALIBRATION_PENDING_WORDS, { label: states.calibrationPending.label, headline: states.calibrationPending.headline });
  assert.deepEqual(NEW_EVENT_WORDS, { text: states.newEvent.text, voiceOver: states.newEvent.voiceOver });
});

test("product words equal tokens.json copy; the disclaimer is byte-identical in tokens, the engine DISCLAIMER and the words", () => {
  const { privacyLine, privacyShort, disclaimer, tagline, question } = tokens.copy;
  assert.deepEqual(PRODUCT_WORDS, { privacyLine, privacyShort, disclaimer, tagline, question });
  assert.equal(PRODUCT_WORDS.disclaimer, DISCLAIMER);
  assert.equal(Buffer.from(DISCLAIMER).equals(Buffer.from(tokens.copy.disclaimer)), true);
});

test("the glance-word regex is tokens.json copy.glanceBanned", () => {
  assert.equal(GLANCE_BANNED.source, tokens.copy.glanceBanned.pattern);
  assert.equal(GLANCE_BANNED.flags, tokens.copy.glanceBanned.flags);
});
