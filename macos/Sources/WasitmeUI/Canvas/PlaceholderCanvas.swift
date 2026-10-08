import Foundation

/// PLACEHOLDER Control Center canvas, compiled into the binary so the app and `--capture` always have a
/// page to serve (no SwiftPM resource bundle, so no `Bundle.module` crash path inside the .app).
/// WP-41 replaces it with `ui/dist/{app.html, app.js, app.css, fonts/}`, served by the same scheme handler
/// from `Contents/Resources/ui/` (or `--canvas DIR`); see `CanvasAssetSource.resolve`.
///
/// Bridge contract the real canvas must keep (CanvasBridge.swift):
///  - define `window.wasitme.render(snap, view)`; native calls exactly `BridgePolicy.renderBody` with data
///    only in the arguments, each ONE JSON string the page parses (D48) (`snap`: the decoded, sanitized snapshot
///    or `null`; `view`: page, pageTitle, agent, lead, appearance, document, documentText, demo, chrome ("content":
///    the app draws the sidebar natively, the page draws only the page), launchAtLogin (on, off, needsApproval,
///    viaInstaller, unavailable), now, timeZone, agents[{id, name, stateText, headline, current}], and settings
///    (SettingsState.viewObject: codes only, what each Settings control shows));
///  - post `{action: "ready"}` to `webkit.messageHandlers.wasitme` once loaded, then named actions only, each with
///    exactly its keys: `scanNow`, `showPage` + `page`, `selectAgent` + `agent`, `copyReport`, `openMarkdown`,
///    `setLaunchAtLogin` / `setDesktopPanel` + `enabled` or `value` (a boolean), `revealDataFolder`, and the changes to
///    the user's setup `removeIntegration` / `addIntegration` + `integration` or `id` (app, scan, claude-plugin,
///    codex-plugin, statusline; `scan-agent` means scan; the app is never added from here), `clearHistory`,
///    `uninstallAll`, `updateApp`, which only ever reach a native confirmation sheet (GuardedActions.swift);
///  - write text with `textContent` only; no inline script or style (the CSP blocks them);
///  - set `document.documentElement.dataset.wasitmeReady = "1"` when loaded (capture checks it).
enum PlaceholderCanvas {
    static let files: [String: String] = [
        "app.html": html,
        "app.js": js,
        "app.css": css,
    ]

    static let html = #"""
    <!doctype html>
    <html lang="en" data-inline-canary="present">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width">
    <title>wasitme</title>
    <link rel="stylesheet" href="app.css">
    <script src="app.js"></script>
    </head>
    <body>
    <script>document.documentElement.dataset.inlineRan = "1";</script>
    <main id="root">
      <p class="eyebrow">Control Center canvas · placeholder</p>
      <h1 id="page">Loading</h1>
      <p class="note">The real canvas (WP-41) replaces this page and receives the same data through the same bridge.</p>
      <section id="agents" aria-live="polite"></section>
      <div class="actions"><button id="scan" type="button">Scan now</button></div>
      <p id="meta" class="meta"></p>
    </main>
    </body>
    </html>
    """#

    static let js = #"""
    "use strict";
    (function () {
      var root = document.documentElement;
      function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined && text !== null) { e.textContent = String(text); }
        return e;
      }
      function send(message) {
        try { window.webkit.messageHandlers.wasitme.postMessage(message); } catch (e) { /* not in the app */ }
      }
      function count(list) { return Array.isArray(list) ? list.length : 0; }
      function parse(x) {
        if (typeof x !== "string") { return null; }
        try { return JSON.parse(x); } catch (e) { return null; }
      }
      function render(snapText, viewText) {
        var snap = parse(snapText);
        var view = parse(viewText) || {};
        root.dataset.appearance = view.appearance === "dark" ? "dark" : "light";
        document.getElementById("page").textContent = String(view.pageTitle || "Timeline");
        var list = document.getElementById("agents");
        while (list.firstChild) { list.removeChild(list.firstChild); }
        var agents = Array.isArray(view.agents) ? view.agents : [];
        if (agents.length === 0) {
          list.appendChild(el("p", "empty", view.documentText || "Nothing to show yet."));
        }
        var reports = snap && Array.isArray(snap.agents) ? snap.agents : [];
        agents.forEach(function (a, i) {
          var card = el("article", "agent" + (a.id === view.agent ? " selected" : "") + (a.current ? "" : " dimmed"));
          card.appendChild(el("h2", null, a.name));
          card.appendChild(el("p", "state", a.stateText));
          if (a.headline) { card.appendChild(el("p", "headline", a.headline)); }
          var r = reports[i];
          card.appendChild(el("p", "counts", r
            ? count(r.metrics) + " metrics · " + count(r.timeline) + " timeline events · " + count(r.candidates) + " candidates"
            : "No snapshot yet: the canvas has only the glance."));
          list.appendChild(card);
        });
        document.getElementById("meta").textContent =
          "lead: " + String(view.lead || "timeline") + " · display: " + String(view.document || "") + (view.demo ? " · DEMO DATA" : "");
        root.dataset.rendered = String(view.page || "");
        return "rendered";
      }
      window.wasitme = Object.freeze({ render: render, version: "placeholder-1" });
      document.addEventListener("DOMContentLoaded", function () {
        document.getElementById("scan").addEventListener("click", function () { send({ action: "scanNow" }); });
        root.dataset.wasitmeReady = "1";
        send({ action: "ready" });
      });
    })();
    """#

    static let css = #"""
    :root {
      --bg: #FFFFFF; --surface: #F7F7F5; --raised: #EFEFED; --hairline: rgba(0,0,0,.08);
      --ink: #1A1A1A; --ink-2: #5C5C5C; --ink-3: #6E6E6E; --you: #4F5BD5; --focus: #4F5BD5;
      color-scheme: light dark;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-appearance="light"]) {
        --bg: #0B0B0C; --surface: #141416; --raised: #1C1C1F; --hairline: rgba(255,255,255,.09);
        --ink: #EDEDED; --ink-2: #A3A3A3; --ink-3: #8A8A8A; --you: #8F99FF; --focus: #8F99FF;
      }
    }
    :root[data-appearance="dark"] {
      --bg: #0B0B0C; --surface: #141416; --raised: #1C1C1F; --hairline: rgba(255,255,255,.09);
      --ink: #EDEDED; --ink-2: #A3A3A3; --ink-3: #8A8A8A; --you: #8F99FF; --focus: #8F99FF;
    }
    html, body { margin: 0; background: var(--bg); color: var(--ink); font: 13px/1.45 -apple-system, system-ui, sans-serif; }
    main { padding: 32px 40px; max-width: 760px; }
    .eyebrow { color: var(--ink-3); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; margin: 0 0 4px; }
    h1 { font-size: 28px; font-weight: 600; margin: 0 0 8px; }
    .note, .meta { color: var(--ink-2); font-size: 12px; }
    .agent { background: var(--surface); border: 1px solid var(--hairline); border-radius: 14px; padding: 16px 20px; margin: 16px 0; }
    .agent.selected { border-color: var(--you); }
    .agent.dimmed { opacity: .55; }
    .agent h2 { font-size: 15px; margin: 0 0 4px; }
    .state { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
    .headline { margin: 0 0 6px; }
    .counts { color: var(--ink-3); font: 11px ui-monospace, SFMono-Regular, monospace; margin: 0; }
    .empty { color: var(--ink-2); }
    button { font: inherit; color: var(--ink); background: var(--raised); border: 0; border-radius: 6px; padding: 5px 10px; }
    button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    """#
}
