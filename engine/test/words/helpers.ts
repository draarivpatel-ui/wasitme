/** Shared checks for the words tests: schema validation, and every copy lint the repo has, run on produced strings. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkGlance, checkSnapshot, validate, type JsonSchema } from "../../src/contract/index.js";
import { agentStrings, lintAgentWords, type AgentWords, type BuiltOutputs } from "../../src/words/index.js";

export const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
export const glanceSchema = readJson(`${ROOT}contract/glance.v1.schema.json`) as JsonSchema;
export const snapshotSchema = readJson(`${ROOT}contract/snapshot.v1.schema.json`) as JsonSchema;
const tokens = readJson(`${ROOT}design/system/tokens.json`);

type LintText = (rel: string, text: string, opts: { scope: string; glance: boolean; lang: string }) => { rule: string; match: string }[];
const repoLint: { lintText: LintText } = await import(pathToFileURL(`${ROOT}scripts/lint-copy.mjs`).href);

/** tokens.json copy.banned (stricter than lintCopy: exhibits, suspects, blame, …), with each rule's exception. */
export function tokensBanned(text: string): string[] {
  const out: string[] = [];
  for (const b of tokens.copy.banned as { pattern: string; flags: string; except?: string }[]) {
    const body = b.except ? text.split(b.except).join(" ") : text;
    if (new RegExp(b.pattern, b.flags).test(body)) out.push(`tokens banned /${b.pattern}/`);
  }
  return out;
}

/** Every lint on every string of one agent's words: the engine lints, the repo's lint-copy (glance rules on the
 *  glance strings) and tokens.json's banned list. */
export function lintEverything(w: AgentWords): string[] {
  const out = [...lintAgentWords(w)];
  for (const [field, text] of agentStrings(w)) {
    const glance = field === "label" || field === "statusLine";
    for (const f of repoLint.lintText("engine/src/words/produced.txt", text, { scope: "copy", glance, lang: "txt" })) out.push(`${field}: lint-copy ${f.rule} "${f.match}"`);
    for (const p of tokensBanned(text)) out.push(`${field}: ${p}`);
  }
  return out;
}

/** The documents validate against the frozen schemas and pass the contract's semantic checks and copy lint. */
export function assertValidOutputs(out: BuiltOutputs, what: string): void {
  assert.deepEqual(out.problems, [], `${what}: buildOutputs problems`);
  assert.deepEqual(validate(glanceSchema, out.glance), [], `${what}: glance schema`);
  assert.deepEqual(validate(snapshotSchema, out.snapshot), [], `${what}: snapshot schema`);
  assert.deepEqual(checkGlance(out.glance, { copy: true }), [], `${what}: checkGlance`);
  assert.deepEqual(checkSnapshot(out.snapshot, { copy: true }), [], `${what}: checkSnapshot`);
  for (const w of out.words) assert.deepEqual(lintEverything(w), [], `${what}: lint ${w.agent}`);
}
