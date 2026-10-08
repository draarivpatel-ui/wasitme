// A tiny Chrome DevTools Protocol client for the canvas tests (the same pattern as design/system/gen/csp-check.mjs):
// ONE headless Chrome at a time (CPU guard), a throwaway profile, Node's built-in WebSocket to Chrome's local
// debugging port. ui/dist is served by request interception (Fetch domain) with the CSP as a response header: no
// HTTP server, and every other request (anything not the test origin) is failed in the browser, so nothing can
// reach the network.
import { spawn } from "node:child_process"; // wasitme:allow-child_process -- test-only: launches the local Chrome with a fixed argv
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

export const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const ORIGIN = "http://canvas.wasitme.test";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ dist, csp }) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME=...)`);
  const dir = mkdtempSync(join(tmpdir(), "wasitme-ui-"));
  const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--disable-default-apps", "--metrics-recording-only", "--disable-features=Translate,OptimizationHints,MediaRouter",
    "--remote-debugging-port=0", `--user-data-dir=${dir}`, "about:blank"], { stdio: "ignore" });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    const f = join(dir, "DevToolsActivePort");
    if (existsSync(f)) { const p = readFileSync(f, "utf8").split("\n"); if (p[1]) port = p; } else await sleep(150);
  }
  if (!port) { proc.kill(); throw new Error("Chrome did not start"); }
  const ws = new WebSocket(`ws://127.0.0.1:${port[0]}${port[1]}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pend = new Map(), listeners = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result); }
    else for (const l of listeners) l(m);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id; pend.set(i, { resolve, reject, method });
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  const log = [];
  let served = [];
  listeners.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Fetch.requestPaused") {
      const url = m.params.request.url;
      const path = url.startsWith(ORIGIN + "/") ? url.slice(ORIGIN.length + 1).split(/[?#]/)[0] : null;
      const file = path && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(path) ? join(dist, path) : null;
      if (file && existsSync(file) && MIME[extname(file)]) {
        served.push(path);
        const body = readFileSync(file);
        S("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, body: body.toString("base64"), responseHeaders: [
          { name: "Content-Type", value: MIME[extname(file)] }, { name: "Content-Security-Policy", value: csp },
          { name: "X-Content-Type-Options", value: "nosniff" }, { name: "Cache-Control", value: "no-store" }] }).catch(() => {});
      } else {
        log.push({ level: "blocked", text: `request refused by the test harness: ${url.slice(0, 120)}` });
        S("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "BlockedByClient" }).catch(() => {});
      }
    } else if (m.method === "Runtime.consoleAPICalled") {
      log.push({ level: m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? "").join(" ") });
    } else if (m.method === "Log.entryAdded") {
      log.push({ level: m.params.entry.level, text: m.params.entry.text });
    } else if (m.method === "Runtime.exceptionThrown") {
      log.push({ level: "error", text: m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text });
    }
  });
  for (const d of ["Page", "Runtime", "Log"]) await S(`${d}.enable`);
  await S("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });

  const api = {
    S, log,
    takeServed() { const s = served; served = []; return s; },
    async size(width, height) { await S("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }); },
    async scheme(value) { await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] }); },
    async open(path = "app.html") {
      const loaded = new Promise((r) => { const l = (m) => { if (m.sessionId === sessionId && m.method === "Page.loadEventFired") { listeners.splice(listeners.indexOf(l), 1); r(); } }; listeners.push(l); });
      await S("Page.navigate", { url: `${ORIGIN}/${path}` });
      await loaded;
    },
    /** DevTools evaluation (not subject to the page's CSP). Returns the value. */
    async eval(expression) {
      const r = await S("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async shot() { const r = await S("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); return Buffer.from(r.data, "base64"); },
    async close() { try { ws.close(); } catch {} proc.kill(); await sleep(300); rmSync(dir, { recursive: true, force: true }); },
  };
  return api;
}

/** The real header (CanvasRouter.contentSecurityPolicy in the Mac app), read from the Swift source. */
export function realCsp(root) {
  const swift = readFileSync(join(root, "macos/Sources/WasitmeUI/Canvas/CanvasRouter.swift"), "utf8");
  const m = /contentSecurityPolicy\s*=\s*((?:\s*"[^"]*"\s*\+?)+)/.exec(swift);
  if (!m) throw new Error("CanvasRouter.contentSecurityPolicy not found");
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).join("");
}

/** Chrome can't load a wasitme-app: page, so the scheme source is mapped to the test origin; nothing else changes. */
export function mappedCsp(csp) { return csp.replaceAll("wasitme-app:", ORIGIN); }
