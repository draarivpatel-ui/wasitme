import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, stripInjected } from "../../src/readers/codex/text.js";
import { samePath } from "../../src/readers/codex/tools.js";
import { label } from "../../src/readers/codex/rollout.js";

const text = (t: string) => [{ type: "text", text: t }];

test("plain typed prompt is human, text kept for heuristics", () => {
  assert.deepEqual(classify(text("  fix the flaky test  ")), { trigger: "human", text: "fix the flaky test", images: false });
});

test("injected-only messages never count as prompts", () => {
  const injected = [
    "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nbe nice\n</INSTRUCTIONS>",
    "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
    "<INSTRUCTIONS>x</INSTRUCTIONS>",
    "<user_instructions>x</user_instructions>",
    "<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>",
    "<subagent_notification>\n{\"id\":1}\n</subagent_notification>",
    "<task-notification>\n<task-id>1</task-id>\n</task-notification>",
    "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>",
    "<local-command-stdout>Set model</local-command-stdout>",
    "<codex_internal_context kind=\"memory\">secret</codex_internal_context>",
    "<recommended_plugins>[]</recommended_plugins>",
  ];
  for (const t of injected) assert.equal(classify(text(t)).trigger, "continuation", t.slice(0, 30));
});

test("heartbeat and scheduled-task wake-ups are automation triggers", () => {
  assert.equal(classify(text("<heartbeat>\n<id>1</id>\n</heartbeat>")).trigger, "automation");
  assert.equal(classify(text("<scheduled-task name=\"x\">run</scheduled-task>")).trigger, "automation");
});

test("wrappers around a real prompt are stripped, the prompt survives", () => {
  const c = classify(text("<in-app-browser-context>\n<url>https://example.test</url>\n</in-app-browser-context>\nwhy is this button blue?"));
  assert.equal(c.trigger, "human");
  assert.equal(c.text, "why is this button blue?");
  const ide = classify(text("# Context from my IDE setup:\n\n## Active file: a.ts\n\n## My request for Codex:\nrename foo to bar"));
  assert.equal(ide.text, "rename foo to bar");
  const files = classify(text("# Files mentioned by the user:\n\n## a.ts: /repo/a.ts\n\nexplain this file"));
  assert.equal(files.text, "explain this file");
});

test("image wrappers: image-only prompts are human with no text", () => {
  const legacy = [{ type: "input_text", text: "<image name=[Image #1]>" }, { type: "input_image", image_url: "data:x" }, { type: "input_text", text: "</image>" }, { type: "input_text", text: "what is this?" }];
  assert.deepEqual(classify(legacy), { trigger: "human", text: "what is this?", images: true });
  assert.deepEqual(classify([{ type: "local_image", path: "/x.png" }]), { trigger: "human", text: "", images: true });
});

test("a leading tag without a closing tag is typed text, not a wrapper", () => {
  assert.equal(stripInjected("<div> is not centered").rest, "<div> is not centered");
  assert.equal(classify(text("<div> is not centered")).trigger, "human");
});

test("markup a person typed is a prompt: only known injected wrappers are stripped", () => {
  for (const t of ['<svg width="10"></svg>', "<template>\n  <div>hi</div>\n</template>", "<b>why is this bold</b>", "<details>see</details>"]) {
    assert.deepEqual(classify(text(t)), { trigger: "human", text: t, images: false }, t);
  }
  const c = classify(text("<environment_context>\n<cwd>/repo</cwd>\n</environment_context>\n<b>why is this bold</b>"));
  assert.equal(c.trigger, "human");
  assert.equal(c.text, "<b>why is this bold</b>", "wrapper removed, typed markup kept in promptChars");
  assert.equal(stripInjected("<p>a</p><environment_context>x</environment_context>").rest, "<p>a</p><environment_context>x</environment_context>", "stripping stops at typed markup");
});

test("empty and non-array content is not a prompt", () => {
  assert.equal(classify(text("   ")).trigger, "continuation");
  assert.equal(classify(undefined).trigger, "continuation");
  assert.equal(classify("typed as string").trigger, "human");
});

test("read/edit path matching: absolute equality or relative suffix", () => {
  assert.ok(samePath("src/a.ts", "/repo/src/a.ts"));
  assert.ok(samePath("/repo/src/a.ts", "/repo/src/a.ts"));
  assert.ok(!samePath("/other/src/a.ts", "/repo/src/a.ts"));
  assert.ok(!samePath("a.ts", "/repo/src/ba.ts"));
  assert.ok(!samePath("", "/repo/a.ts"));
});

test("labels: allow-listed, 'other' when unsafe, object policies use their kind", () => {
  assert.equal(label("gpt-6-luna"), "gpt-6-luna");
  assert.equal(label("/Users/x/model"), "other");
  assert.equal(label({ granular: { sandbox: true } }), "granular");
  assert.equal(label(undefined), undefined);
  assert.equal(label(""), undefined);
});
