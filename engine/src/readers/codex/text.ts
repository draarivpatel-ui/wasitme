/**
 * Classifying Codex user messages: a person typing vs. context the app injected.
 * Text is used in memory only (pushback / near-duplicate checks) and never leaves the reader.
 */
import { obj } from "../../util.js";
import { APP_TAGS, AUTOMATION_TAGS, INJECTED_TAGS } from "./known.js";

/** What a user-role message means for exchange boundaries. */
export type Trigger = "human" | "automation" | "continuation";

export interface Classified {
  trigger: Trigger;
  /** Human-typed text after removing injected wrappers ("" for non-human messages). */
  text: string;
  images: boolean;
}

/** Text and image presence of a UserMessage item / response_item message `content`. */
export function contentParts(content: unknown): { text: string; images: boolean } {
  if (typeof content === "string") return { text: content, images: false };
  if (!Array.isArray(content)) return { text: "", images: false };
  const parts: string[] = [];
  let images = false;
  for (const c of content) {
    const o = obj(c);
    if (!o) continue;
    if ((o.type === "text" || o.type === "input_text") && typeof o.text === "string") parts.push(o.text);
    else if (o.type === "local_image" || o.type === "image" || o.type === "input_image") images = true;
  }
  return { text: parts.join("\n"), images };
}

const OPEN_TAG = /^<([A-Za-z_][\w.:-]{0,63})(?:\s[^>]*)?(\/?)>/;
const PREAMBLE = /^# (Context from my IDE setup|Files mentioned by the user)\b/;
const REQUEST_MARKER = "## My request for Codex:";
const MAX_BLOCKS = 32;

/**
 * Remove wrappers Codex and its clients put around (or instead of) what the person typed:
 * leading `<tag …>…</tag>` blocks whose tag is a known injected wrapper (INJECTED_TAGS: environment_context,
 * INSTRUCTIONS, heartbeat, in-app-browser-context, image wrappers, codex_internal_context, …), whole
 * `# AGENTS.md` instruction messages, and the IDE/file-mention preamble
 * ("# Files mentioned by the user: … ## My request for Codex: <prompt>").
 * Any other leading tag, and a known tag without a matching close tag, is treated as typed text — except the
 * injected app tags (known.ts APP_TAGS: task-notification, command-name/-message, local-command-stdout, heartbeat,
 * scheduled-task, …): the app writes those as whole messages, so from one of them on the message is injected
 * context in full, closed or not, whatever follows it.
 */
export function stripInjected(raw: string): { rest: string; tags: string[] } {
  let s = raw.trim();
  const tags: string[] = [];
  for (let i = 0; i < MAX_BLOCKS; i++) {
    if (s.startsWith("# AGENTS.md")) return { rest: "", tags: [...tags, "agents-md"] };
    const m = OPEN_TAG.exec(s);
    if (!m) break;
    const name = m[1]!;
    if (!INJECTED_TAGS.has(name)) break;
    if (APP_TAGS.has(name)) return { rest: "", tags: [...tags, name] };
    if (m[2] === "/") { s = s.slice(m[0].length).trim(); tags.push(name); continue; }
    const close = s.indexOf(`</${name}>`, m[0].length);
    if (close < 0) break;
    s = s.slice(close + name.length + 3).trim();
    tags.push(name);
  }
  if (PREAMBLE.test(s)) {
    const at = s.indexOf(REQUEST_MARKER);
    s = at >= 0
      ? s.slice(at + REQUEST_MARKER.length).trim()
      : s.split("\n").slice(1).filter((l) => !/^##\s/.test(l)).join("\n").trim();
  }
  return { rest: s, tags };
}

/** Classify one user-role message. Images alone count as a human prompt (a pasted screenshot). */
export function classify(content: unknown): Classified {
  const { text, images } = contentParts(content);
  return classifyParts(text, images);
}

/**
 * Classify already-extracted message text (e.g. a legacy `user_message` event's `message`). A message that reaches
 * an injected app tag is never a prompt, even with images attached (the app wrote the whole message).
 */
export function classifyParts(text: string, images: boolean): Classified {
  const { rest, tags } = stripInjected(text);
  const last = tags[tags.length - 1];
  const app = last !== undefined && APP_TAGS.has(last) ? last : undefined;
  if (!app && (rest || images)) return { trigger: "human", text: rest, images };
  return { trigger: app && AUTOMATION_TAGS.has(app) ? "automation" : "continuation", text: "", images: false };
}
