/**
 * Is a prompt English? (D47f / D51: `Exchange.promptEnglish`, which gates the pushback metric: pushback is off when
 * fewer than 70% of a window's prompts are English, METHOD.md §3.) A deliberately small, dependency-free heuristic,
 * run at parse time on text that only ever exists in memory; the caller keeps the 0/1 answer, never the text.
 *
 * Rule, in order:
 *  1. Code and noise are removed first: fenced and inline code, URLs, and tokens that look like paths or
 *     identifiers (contain `/ \ _ . = { } < >` or a digit).
 *  2. Fewer than 2 letters left → `undefined` (unknown: an image-only prompt, a pasted number, an emoji).
 *  3. Mostly non-Latin letters (Latin < 50% of all letters: CJK, Cyrillic, Greek, Arabic, …) → 0.
 *  4. Words are counted against two short lists: common English function / instruction words, and the most
 *     frequent function words of Spanish, French, German, Portuguese, Italian and Dutch. Words that are common
 *     in both (a, in, no, so, die, was, an, is, …) are on neither list.
 *     more English hits → 1; more foreign hits → 0.
 *  5. A tie (including no hits at all — "lgtm", "refactor parser"): accented Latin letters (é, ü, ñ, ß …) making
 *     up ≥ 3% of the letters → 0, else 1. Short ASCII instructions are overwhelmingly English for the users this
 *     tool sees; the cost of a wrong guess is only that pushback (a support metric, never a vote, D30) stays on.
 *
 * Measured on nothing real: the unit tests (engine/test/store/language.test.ts) pin the examples it must get right.
 */

const ENGLISH = new Set([
  "the", "and", "you", "your", "it", "it's", "its", "this", "that", "these", "those", "to", "of", "for", "with", "what",
  "why", "how", "can", "could", "would", "should", "please", "i", "i'm", "i've", "i'd", "my", "me", "we", "we're", "our",
  "us", "do", "does", "did", "don't", "doesn't", "didn't", "not", "isn't", "aren't", "wasn't", "can't", "won't", "be",
  "been", "being", "have", "has", "had", "are", "were", "on", "at", "from", "by", "as", "if", "or", "but", "there",
  "here", "they", "them", "their", "which", "when", "where", "who", "all", "any", "some", "more", "just", "also", "now",
  "then", "than", "into", "about", "after", "before", "again", "still", "only", "make", "add", "fix", "run", "check",
  "update", "change", "remove", "delete", "create", "write", "read", "show", "need", "want", "let's", "lets", "let",
  "yes", "yeah", "ok", "okay", "thanks", "thank", "sure", "continue", "proceed", "go", "ahead", "instead", "same",
  "wrong", "right", "should've", "try", "use", "using", "file", "files", "code", "test", "tests", "error", "errors",
  "build", "look", "looks", "see", "work", "works", "working", "broken", "doesn", "think", "know", "because", "same",
  "it'll", "that's", "there's", "what's", "here's", "will", "every", "each", "other", "another", "new", "old", "one",
  "two", "first", "last", "next", "both", "too", "very", "much", "many", "lgtm", "done", "stop", "wait", "keep",
]);

const FOREIGN = new Set([
  // es
  "el", "los", "las", "que", "y", "por", "para", "con", "una", "es", "está", "esta", "como", "pero", "más", "mas",
  "del", "lo", "se", "su", "hay", "este", "eso", "gracias", "favor", "hacer", "puedes", "también", "porque",
  // fr
  "le", "les", "des", "et", "est", "une", "pour", "dans", "qui", "pas", "avec", "sur", "ce", "cette", "je", "tu",
  "vous", "nous", "merci", "fais", "peux", "mais", "aussi", "très", "au", "aux", "du",
  // de
  "der", "das", "und", "ist", "nicht", "ich", "mit", "sie", "ein", "eine", "auf", "für", "zu", "auch", "noch",
  "bitte", "danke", "kannst", "mach", "wie", "warum", "oder", "aber", "sehr", "dem", "den", "des",
  // pt
  "os", "um", "uma", "não", "com", "é", "você", "isso", "obrigado", "obrigada", "fazer", "também",
  // it
  "il", "che", "di", "è", "per", "non", "sono", "gli", "della", "questo", "grazie", "puoi", "anche", "perché",
  // nl
  "het", "een", "niet", "van", "ik", "dat", "je", "maar", "ook", "bedankt", "kun", "wat",
]);

const FENCE = /```[\s\S]*?(```|$)/g;
const INLINE = /`[^`\n]*`/g;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const CODEY = /[/\\_.={}<>\[\]()0-9#$%^*|~@]/;

/** 1 = English, 0 = not English, undefined = cannot tell (too few letters). */
export function promptEnglish(text: string): 0 | 1 | undefined {
  if (typeof text !== "string" || text.length === 0) return undefined;
  const cleaned = text.slice(0, 20_000).replace(FENCE, " ").replace(INLINE, " ").replace(URL, " ");
  const words: string[] = [];
  let letters = 0, latin = 0, accented = 0;
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw || CODEY.test(raw)) continue;
    for (const ch of raw) {
      if (!/\p{L}/u.test(ch)) continue;
      letters++;
      if (/\p{Script=Latin}/u.test(ch)) {
        latin++;
        if (ch > "\u007f") accented++;
      }
    }
    const w = raw.toLowerCase().replace(/[’]/g, "'").replace(/^[^\p{L}']+|[^\p{L}']+$/gu, "");
    if (w) words.push(w);
  }
  if (letters < 2) return undefined;
  if (latin / letters < 0.5) return 0;
  let en = 0, foreign = 0;
  for (const w of words) {
    if (ENGLISH.has(w)) en++;
    else if (FOREIGN.has(w)) foreign++;
  }
  if (en > foreign) return 1;
  if (foreign > en) return 0;
  return accented / letters >= 0.03 ? 0 : 1;
}
