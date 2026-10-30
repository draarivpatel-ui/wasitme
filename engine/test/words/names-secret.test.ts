/**
 * The output boundary never echoes a token-shaped label (sol-loop S3): a model label stored by a reader from before
 * the Claude token guard can still sit in a warm shard, so prose() and fieldValue() refuse it themselves.
 * Synthetic values only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldValue, prose } from "../../src/words/names.js";

const TOKENS = ["sk-ant-api03-synthetic0000", "ghp_synthetic000000000000000000", "abcdefghijklmnopqrstuvwxyz0123456789"];

test("a token-shaped stored label never reaches prose or a snapshot field", () => {
  for (const t of TOKENS) {
    assert.equal(prose(t), null, t);
    assert.equal(fieldValue(t), "other", t);
  }
});

test("ordinary labels and short hashes are unchanged", () => {
  assert.equal(prose("claude-opus-4-5"), "claude-opus-4-5");
  assert.equal(fieldValue("gpt-5.1-codex"), "gpt-5.1-codex");
  assert.equal(fieldValue("h:0123abcd"), "h:0123abcd");
});
