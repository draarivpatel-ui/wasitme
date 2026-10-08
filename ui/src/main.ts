/**
 * The page's entry point and its bridge to the Mac app (DECISIONS D48).
 *
 * Data in: native calls `window.wasitme.render(snap, view)` from a constant script body with the data only in the
 * arguments. D48 says the snapshot travels as ONE JSON string parsed here; the WP-50 bridge currently passes plain
 * objects, so both are accepted: a string is JSON.parse'd, an object is normalized through a JSON round trip (which
 * drops a "__proto__" key that replaced a prototype, and NaN/Infinity). Everything is then read with Object.hasOwn.
 * Returns "rendered" (CaptureRunner checks that exact string) — or, if the page has seen a CSP violation, says so,
 * so `--capture` under the real header fails loudly.
 *
 * Data out: named actions only, via webkit.messageHandlers.wasitme.postMessage, each with exactly the keys the
 * native BridgePolicy accepts for it (macos/Sources/WasitmeUI/Canvas/CanvasBridge.swift; any other key is rejected):
 *   ready, scanNow, copyReport, openMarkdown, clearHistory, uninstallAll, updateApp, revealDataFolder   {action}
 *   showPage {action, page}         selectAgent {action, agent}
 *   addIntegration / removeIntegration {action, integration}   (app, claude-plugin, statusline, codex-plugin, scan)
 *   setLaunchAtLogin / setDesktopPanel {action, enabled}        (a JavaScript boolean)
 * Setup changes are only ever ASKED for: native confirms them in its own sheet and runs them (UX-V2 §9.3).
 * toggleSection (a disclosure) is handled here and never posted.
 *
 * Hidden-window rule (D48): no requestAnimationFrame, no animation; render() paints synchronously.
 */

import { decodeSnapshot, isObj, parseGeneratedAt } from "./decode.js";
import type { Doc } from "./decode.js";
import { actKey, materialize } from "./dom.js";
import { isPage, landingPage, PAGES, renderApp } from "./pages.js";
import type { Page, Ui } from "./pages.js";
import type { Act } from "./vnode.js";
import { isBridgeId } from "./sanitize.js";
import { decodeSettings } from "./view.js";

interface Bridge { postMessage(m: unknown): void }

const root = document.documentElement;
let violations = 0;
let lastDoc: Doc | null = null;
let ui: Ui = { page: "timeline", agent: 0, chrome: "full", nowMs: Date.now(), open: [] };
let userPage: Page | null = null;

/** The integration ids the bridge accepts (IntegrationID raw values). */
const INTEGRATIONS = new Set(["app", "scan", "claude-plugin", "codex-plugin", "statusline"]);
/** Actions that carry no key besides `action`. */
const PLAIN = new Set(["scanNow", "copyReport", "openMarkdown", "clearHistory", "uninstallAll", "updateApp", "revealDataFolder"]);

document.addEventListener("securitypolicyviolation", (e) => {
  violations++;
  root.dataset["cspViolations"] = String(violations);
  root.dataset["cspLast"] = String((e as SecurityPolicyViolationEvent).effectiveDirective || "unknown");
});

function bridge(): Bridge | null {
  try {
    const w = window as unknown as { webkit?: { messageHandlers?: { wasitme?: Bridge } } };
    const b = w.webkit?.messageHandlers?.wasitme;
    return b && typeof b.postMessage === "function" ? b : null;
  } catch { return null; }
}

function post(m: { action: string; page?: string; agent?: string; integration?: string; enabled?: boolean }): void {
  const b = bridge();
  if (!b) return;
  try { b.postMessage(m); } catch { /* not in the app */ }
}

/** A JSON string → parsed; an object → JSON round trip (own enumerable data only); anything else → null. */
function normalize(x: unknown): unknown {
  try {
    if (typeof x === "string") return x === "" ? null : JSON.parse(x);
    if (x === null || x === undefined) return null;
    if (typeof x === "object") return JSON.parse(JSON.stringify(x));
  } catch { return undefined; }
  return null;
}

function onAct(a: Act): void {
  switch (a.action) {
    case "toggleSection": {
      // a disclosure: local only (UX-V2 §5); the toggle is kept across re-renders and agent switches
      if (typeof a.section !== "string" || !/^[a-z]+\.[A-Za-z]+$/.test(a.section)) return;
      const open = ui.open ?? [];
      ui = { ...ui, open: open.includes(a.section) ? open.filter((k) => k !== a.section) : [...open, a.section] };
      paint(true);
      return;
    }
    case "showPage":
      if (isPage(a.page)) { ui = { ...ui, page: a.page }; userPage = a.page; paint(true); post({ action: "showPage", page: a.page }); }
      return;
    case "selectAgent":
      if (typeof a.index === "number") { ui = { ...ui, agent: a.index }; paint(true); }
      if (isBridgeId(a.agent)) post({ action: "selectAgent", agent: a.agent });
      return;
    case "addIntegration":
    case "removeIntegration":
      if (typeof a.integration === "string" && INTEGRATIONS.has(a.integration)) post({ action: a.action, integration: a.integration });
      return;
    case "setLaunchAtLogin":
    case "setDesktopPanel":
      if (typeof a.enabled === "boolean") post({ action: a.action, enabled: a.enabled });
      return;
    default:
      if (PLAIN.has(a.action)) post({ action: a.action });
  }
}

function paint(keepFocus = false): void {
  const app = document.getElementById("app");
  if (!app || !lastDoc) return;
  const focused = keepFocus && document.activeElement instanceof Element ? document.activeElement.getAttribute("data-act") : null;
  const tree = renderApp(lastDoc, ui);
  app.replaceChildren(materialize(tree, document, onAct));
  const title = PAGES.find((p) => p.id === ui.page)?.title ?? "Finding";
  document.title = `wasitme · ${title}`;
  root.dataset["page"] = ui.page;
  root.dataset["display"] = lastDoc.display;
  root.dataset["demo"] = lastDoc.demo && lastDoc.display !== "mismatch" && lastDoc.display !== "refused" ? "1" : "0";
  if (focused) {
    const target = Array.from(app.querySelectorAll("[data-act]")).find((e) => e.getAttribute("data-act") === focused)
      ?? Array.from(app.querySelectorAll("[data-act]")).find((e) => e.getAttribute("data-act") === actKey({ action: "showPage", page: ui.page }));
    if (target instanceof HTMLElement) target.focus();
  }
}

function own(o: unknown, k: string): unknown { return isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined; }

export function render(snap: unknown, view: unknown): string {
  try {
    const raw = normalize(snap);
    const v = normalize(view);
    const nowRaw = own(v, "now");
    const nowMs = (typeof nowRaw === "string" ? parseGeneratedAt(nowRaw) : null) ?? Date.now();
    const doc = decodeSnapshot(raw === undefined ? { schema: null } : raw, { nowMs, viewDocument: own(v, "document") });
    const chromeRaw = own(v, "chrome");
    const chrome: Ui["chrome"] = chromeRaw === "full" || chromeRaw === "content" ? chromeRaw : bridge() ? "content" : "full";
    const appearance = own(v, "appearance");
    if (appearance === "dark" || appearance === "light") root.dataset["theme"] = appearance; else delete root.dataset["theme"];
    const tz = own(v, "timeZone");
    const vp = own(v, "page");
    const page: Page = isPage(vp) ? vp : userPage ?? landingPage(doc);
    const va = own(v, "agent");
    let agent = ui.agent;
    if (typeof va === "string" && va !== "") {
      const i = doc.agents.findIndex((a) => a.bridgeId === va || a.id === va);
      if (i >= 0) agent = i;
    }
    if (agent >= doc.agents.length) agent = 0;
    ui = { page, agent, chrome, nowMs, open: ui.open ?? [], settings: decodeSettings(v), ...(typeof tz === "string" && tz ? { timeZone: tz } : {}) };
    lastDoc = doc;
    // keep keyboard focus on the same control when native re-renders (after a Settings action, a scan, a new hour)
    paint(true);
    root.dataset["rendered"] = page;
    return violations === 0 ? "rendered" : `rendered with ${violations} CSP violation(s)`;
  } catch (e) {
    root.dataset["renderError"] = e instanceof Error ? e.message.slice(0, 120) : "render failed";
    return "error: render failed";
  }
}

const api = Object.freeze({ render, version: "wp41-1" });
Object.defineProperty(window, "wasitme", { value: api, writable: false, configurable: false, enumerable: false });

function boot(): void {
  lastDoc = decodeSnapshot(null, { nowMs: Date.now(), viewDocument: "loading" });
  ui = { ...ui, chrome: bridge() ? "content" : "full" };
  paint();
  root.dataset["wasitmeReady"] = "1";
  post({ action: "ready" });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
