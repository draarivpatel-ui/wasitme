/**
 * Per-field label shapes (PRIVACY.md "What is stored"). A label leaves the reader only if it passes its field's shape;
 * anything else becomes "other" (same convention as the Codex reader's entrypoint enum), so exchange labels and
 * event from/to agree. An earlier `label-<hmac8>` proposal was dropped: D52(b) keeps "other" (the acceptance suite
 * pins "unknown"/"other" for rejected labels). Change it in `rejected()` only.
 *
 * The enums are the values a counts-only check of real logs found (field names and enums only) plus the documented
 * Claude Code values; a value outside them is "other" (a new legitimate value shows up as "other" until it is added
 * here, never as raw text).
 */
import { cleanLabel } from "../../util.js";

/** The label a value outside its field's shape becomes. */
export const OTHER = "other";

const VERSION = /^\d+\.\d+\.\d+([-+.][0-9A-Za-z.]+)?$/;
/**
 * Lowercase ids only, plus one Vertex-style version suffix (D52: Vertex users must still see model changes). Vertex
 * Claude ids carry a date (`claude-opus-4@20250514`); `@latest` / `@default` are allowed too. Any other suffix is
 * refused, so an e-mail-shaped value (`name.x@example.com`) cannot pass as a model (WP-12 review; D52(b)). "/", "~",
 * spaces and brackets can't match (ARNs, paths, prose).
 */
export const MODEL = /^[a-z0-9][a-z0-9._:-]{0,63}(@(?:\d{8}|latest|default))?$/;

export const EFFORTS: ReadonlySet<string> = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
export const MODES: ReadonlySet<string> = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "auto", "dontAsk", "delegate"]);

/**
 * Launch surfaces a human drives. A counts-only check of real logs found claude-desktop, cli and claude-vscode.
 */
export const INTERACTIVE_ENTRYPOINTS: ReadonlySet<string> = new Set(["cli", "claude-desktop", "claude-vscode"]);
/**
 * Programmatic launches: `claude -p` (sdk-cli), the Agent SDKs (sdk-ts, sdk-py), `claude mcp serve` (mcp), the
 * GitHub Action. [inferred from Claude Code's documented entrypoints; WP-24a checks the mix on real logs]
 */
export const SCRIPTED_ENTRYPOINTS: ReadonlySet<string> = new Set(["sdk-cli", "sdk-ts", "sdk-py", "mcp", "claude-code-github-action"]);

export type EntrypointClass = "interactive" | "scripted" | "unrecognised";

/** Which kind of launch surface a raw entrypoint names (any `sdk-` prefix is programmatic). */
export function entrypointClass(raw: string): EntrypointClass {
  if (INTERACTIVE_ENTRYPOINTS.has(raw)) return "interactive";
  if (SCRIPTED_ENTRYPOINTS.has(raw) || /^sdk-[a-z0-9]{1,16}$/.test(raw)) return "scripted";
  return "unrecognised";
}

/** A present value that fails its shape. */
function rejected(): string {
  return OTHER;
}

function present(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

/** CLI version: semver-like, else "other"; undefined when absent. */
export function versionLabel(v: unknown): string | undefined {
  const s = present(v);
  if (s === undefined) return undefined;
  return VERSION.test(s) && cleanLabel(s) === s ? s : rejected();
}

/**
 * Requested model. Identity ids may carry a context-size suffix ("…[1m]"), which is dropped first so the
 * identity attachment and the assistant records compare equal.
 */
export function modelLabel(v: unknown): string | undefined {
  const s = present(v)?.replace(/\[[^\]]*\]$/, "");
  if (s === undefined) return undefined;
  if (!s) return rejected();
  return MODEL.test(s) ? s : rejected();
}

export function effortLabel(v: unknown): string | undefined {
  return enumLabel(v, EFFORTS);
}

export function modeLabel(v: unknown): string | undefined {
  return enumLabel(v, MODES);
}

export function entrypointLabel(v: unknown): string | undefined {
  const s = present(v);
  if (s === undefined) return undefined;
  return entrypointClass(s) === "unrecognised" ? rejected() : s;
}

function enumLabel(v: unknown, allowed: ReadonlySet<string>): string | undefined {
  const s = present(v);
  if (s === undefined) return undefined;
  return allowed.has(s) ? s : rejected();
}

/** True for a label that names a value (not "other"): only these move setup state and become event from/to. */
export function isKnownLabel(label: string | undefined): label is string {
  return label !== undefined && label !== OTHER;
}
