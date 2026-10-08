/**
 * Heuristic: does a prompt read like pushback on the agent's previous answer?
 * English only, start-of-message patterns, deliberately conservative. Reported as an
 * indicator ("pushback-like prompts"), never as a measure of correctness.
 */
const PATTERNS: RegExp[] = [
  /^(no|nope|nah)\b[\s,.!]/i,
  /^(wrong|incorrect)\b/i,
  /^that('?s| is)( still)? (not|wrong|incorrect|broken)\b/i,
  /^(it|this)('?s| is) (still )?(not working|broken|wrong|failing)\b/i,
  /^(it|this) (still )?(doesn'?t|does not|didn'?t|did not) work\b/i,
  /^still (not|broken|failing|wrong|the same)\b/i,
  /^not what i\b/i,
  /^you (didn'?t|did not|forgot|missed|broke|ignored|deleted|removed|changed)\b/i,
  /^why (did|would) you\b/i,
  /^i (said|told you|asked|meant)\b/i,
  /^(stop|undo|revert|roll ?back)\b/i,
  /^(ugh|wtf|seriously)\b/i,
  /^(try again|again[,.!]?$)/i,
  /^(actually|wait)[,!.]\s/i,
];

export function isPushback(text: string): boolean {
  const s = text.trim();
  if (!s || s.startsWith("<") || s.startsWith("[")) return false;
  return PATTERNS.some((re) => re.test(s));
}
