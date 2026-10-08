/**
 * The engine's copies of the design system's shipped files are the design system's, byte for byte (the engine cannot
 * import across its rootDir and ships only dist/src; same pattern as engine/test/words/tokens-sync.test.ts):
 *
 *   design/system/generated/tokens.ts         = engine/src/cli/design-tokens.ts
 *   design/system/generated/tokens.inline.css = engine/src/output/inline-css.ts (and its sha256 is the one csp-check.txt
 *                                              recorded when headless Chrome showed all six faces drawing under the CSP)
 *   design/system/demo-data.v3.json           = engine/src/demo/data.ts
 *
 * After a design change, run `node engine/scripts/sync-design.mjs` and re-run the golden tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { tokens } from "../../src/cli/design-tokens.js";
import { DEMO_JSON } from "../../src/demo/data.js";
import { INLINE_CSS } from "../../src/output/inline-css.js";
import { cspFor, REPORT_CSS, styleHash, styleText } from "../../src/output/report.js";
import { ROOT } from "./cases.js";

const read = (rel: string): string => readFileSync(`${ROOT}${rel}`, "utf8");

test("design-tokens.ts is design/system/generated/tokens.ts, byte for byte", () => {
  const copy = read("engine/src/cli/design-tokens.ts");
  assert.equal(copy, read("design/system/generated/tokens.ts"));
  assert.ok(tokens.states.insufficient.textGlyph.length === 3);
});

test("the inline stylesheet is tokens.inline.css, and its sha256 is the one the Chrome CSP check recorded", () => {
  assert.equal(INLINE_CSS, read("design/system/generated/tokens.inline.css"));
  const recorded = /^sha256 ([0-9a-f]{64})$/m.exec(read("design/system/generated/csp-check.txt"))?.[1];
  assert.ok(recorded !== undefined, "csp-check.txt records a hash");
  assert.equal(createHash("sha256").update(INLINE_CSS).digest("hex"), recorded);
  assert.match(read("design/system/generated/csp-check.txt"), /RESULT: PASS/);
  assert.ok(!/(https?:|url\((?!data:))/.test(INLINE_CSS), "no network or relative URL in the stylesheet");
});

test("the demo data is demo-data.v3.json", () => {
  assert.equal(DEMO_JSON, read("design/system/demo-data.v3.json"));
});

test("engine/scripts/sync-design.mjs --check agrees", () => {
  const r = spawnSync(process.execPath, [`${ROOT}engine/scripts/sync-design.mjs`, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("the report's CSP is the one the design system verified, with the style element's own hash", () => {
  const css = styleText();
  assert.ok(css.startsWith(INLINE_CSS), "the report's style element starts with the inline tokens");
  assert.ok(css.endsWith(REPORT_CSS));
  assert.equal(cspFor(css), `default-src 'none'; style-src ${styleHash(css)}; font-src data:`);
  assert.match(styleHash(css), /^'sha256-[A-Za-z0-9+/]{43}='$/);
  // the report's own rules use the tokens' variables only: no colour literals
  assert.ok(!/#[0-9A-Fa-f]{3,8}\b|rgba?\(/.test(REPORT_CSS), "REPORT_CSS has no colour literal");
});
