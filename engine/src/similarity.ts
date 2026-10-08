/**
 * Near-duplicate prompt detection ("the user re-sent almost the same prompt" = implicit pushback).
 * Character 5-gram shingles over normalized text, Jaccard similarity. Text is used in memory only.
 */
const K = 5;

export function shingles(text: string): Set<string> {
  const s = text.toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  if (s.length < K) { if (s) out.add(s); return out; }
  for (let i = 0; i + K <= s.length; i++) out.add(s.slice(i, i + K));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** True when `prompt` is a near-duplicate (Jaccard ≥ 0.6) of `previous`, ignoring very short prompts. */
export function isNearDuplicate(previous: string | undefined, prompt: string): boolean {
  if (!previous || prompt.trim().length < 12 || previous.trim().length < 12) return false;
  return jaccard(shingles(previous), shingles(prompt)) >= 0.6;
}
