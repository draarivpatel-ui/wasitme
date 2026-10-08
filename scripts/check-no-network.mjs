#!/usr/bin/env node
// check-no-network.mjs - static tripwire for wasitme's "no network, zero runtime dependencies" promise.
//
// Usage:
//   node scripts/check-no-network.mjs [--host-module NAME]... [dir ...]   scan the given directories (default: engine/src)
//   node scripts/check-no-network.mjs --self-test                         run this script's own tests
//
//   --host-module NAME   NAME and NAME/... are modules the host provides at runtime (e.g. "claude-code", the Claude
//                        Code mod API the plugin's mod imports): allowed like a built-in. Never a network module.
//
// scripts/ci-local.sh and ci.yml scan engine/src, plugin/mod and plugin/scripts (with --host-module claude-code) and
// macos/Sources. Not scanned: scripts/ (the installer downloads releases with curl by design) and tests.
//
// Exit codes: 0 clean, 1 violations found, 2 usage error or nothing to scan.
//
// What it rejects in every .ts/.js/.mjs/.cjs (and friends) file under the scanned directories:
//   * imports / requires / dynamic imports of node:http, https, http2, net, dns (and dns/promises), tls, dgram,
//     cluster, inspector, quic and child_process (child_process only passes with an allow marker, below)
//   * imports of anything that is not a Node built-in or a relative path (the engine has zero runtime
//     dependencies), including URL and data: imports
//   * dynamic import()/require() whose specifier is not a plain string literal (cannot be checked statically)
//   * the globals fetch, WebSocket, XMLHttpRequest, EventSource, WebTransport, RTCPeerConnection, sendBeacon,
//     createRequire, eval and the Function constructor, process.binding / process.dlopen, and computed access
//     such as globalThis["fetch"]
//   * native/binary code (.node, .wasm, ...) and symlinks inside a scanned tree
//   * "<scanned dir>/../package.json" declaring runtime dependencies or install-time scripts
//
// Swift files (.swift): a URL literal with a network scheme (`URL(string: "https://…")`, ws/wss/ftp) anywhere; and in code
// (comments and strings masked), `import Network` / CFNetwork / FoundationNetworking /
// NetworkExtension / MultipeerConnectivity / CloudKit, and the APIs URLSession, URLRequest (allowed only on a line marked
// `wasitme:allow-local-scheme -- <reason>`, for loads of the app's own wasitme-app:// scheme), NSURLConnection,
// NWConnection/NWListener/NWBrowser/NWPathMonitor, CFSocket, CFStream socket pairs, CFHost, SCNetworkReachability,
// Stream.getStreamsToHost, getaddrinfo/gethostbyname and BSD socket(AF_INET...). The macOS app has none.
// Shell scripts (.sh/.bash/.zsh, or a #!/bin/sh shebang): the commands curl, wget, nc/ncat/netcat, socat, telnet,
// ssh, scp, sftp, ftp, rsync outside quotes and comments, and /dev/tcp or /dev/udp anywhere.
//
// Allow-listing child_process (never any network module): put this comment on the same line as the import, or on
// the line directly above it, with a real reason:
//     // wasitme:allow-child_process -- <why this spawn is safe, e.g. fixed argv, no log-derived input>
//
// Honest limits: this is a tripwire for accidents and lazy shortcuts, not a sandbox. A contributor determined to
// hide a network call can defeat any static check (for example by smuggling a function through a data structure).
// The real defences are zero dependencies, code review, and the hostile-input tests; this just makes the easy
// mistakes loud. It uses a small purpose-built lexer so that words inside comments, strings and regexes do not
// trigger it. A `/` right after `)` or `}` is read as division, so a regex literal in that position may be
// mis-lexed; the damage is limited to the rest of that line.

import { builtinModules } from "node:module";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { scanSwift, shellLines } from "./lib/source-scan.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(SELF));

// ---------------------------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------------------------

/** Built-in modules that open sockets or run other programs. Matched on the first path segment (dns/promises -> dns). */
const NETWORK_MODULES = new Set(["http", "https", "http2", "net", "dns", "tls", "dgram", "cluster", "inspector", "quic"]);
const PROCESS_MODULE = "child_process";
const INTERNAL_NETWORK_MODULE = /^_(http|tls)_/; // _http_client, _tls_wrap, ...

const NETWORK_GLOBALS = new Set(["fetch", "WebSocket", "XMLHttpRequest", "EventSource", "WebTransport", "RTCPeerConnection", "sendBeacon"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "self", "window", "navigator"]);
const BINARY_EXTENSIONS = new Set([".node", ".wasm", ".so", ".dylib", ".dll", ".exe"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"];
const ALLOW_MARKER = /wasitme:allow-child_process\b(?:\s*--\s*(\S.*))?/;

const NODE_BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));

// ---------------------------------------------------------------------------------------------------------------
// Lexer: just enough JavaScript/TypeScript to separate code from comments, strings, templates and regexes.
// Tokens: {type: "id"|"str"|"tplx"|"num"|"regex"|"punct", value, line}. "str" values are unescaped. "tplx" is a
// template literal with substitutions (its code is lexed as ordinary tokens just before it).
// ---------------------------------------------------------------------------------------------------------------

const REGEX_AFTER_KEYWORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const ID_START = /[\p{L}\p{Nl}$_]/u;
const ID_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$\u200c\u200d]/u;
const SIMPLE_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

function unescapeJs(raw) {
  return raw.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|u\{[0-9a-fA-F]+\}|\r\n|[\s\S])/g, (_m, e) => {
    if (e[0] === "x" && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === "u" && e.length > 1) {
      const cp = parseInt(e[1] === "{" ? e.slice(2, -1) : e.slice(1), 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    if (e === "\n" || e === "\r\n") return ""; // line continuation
    return SIMPLE_ESCAPES[e] ?? e;
  });
}

export function lex(src) {
  const tokens = [];
  const comments = [];
  const n = src.length;
  let i = 0;
  let line = 1;

  const regexAllowed = () => {
    const t = tokens[tokens.length - 1];
    if (!t) return true;
    if (t.type === "id") return REGEX_AFTER_KEYWORD.has(t.value);
    if (t.type === "punct") return !(t.value === ")" || t.value === "]" || t.value === "}");
    return false;
  };

  const readIdentifier = () => {
    let name = "";
    while (i < n) {
      const ch = String.fromCodePoint(src.codePointAt(i));
      if ((name ? ID_PART : ID_START).test(ch)) { name += ch; i += ch.length; continue; }
      if (ch === "\\" && src[i + 1] === "u") {
        const m = /^\\u(?:([0-9a-fA-F]{4})|\{([0-9a-fA-F]+)\})/.exec(src.slice(i, i + 12));
        if (m) { name += String.fromCodePoint(parseInt(m[1] ?? m[2], 16)); i += m[0].length; continue; }
      }
      break;
    }
    return name;
  };

  const readString = (quote) => {
    const startLine = line;
    i++;
    let raw = "";
    while (i < n) {
      const ch = src[i];
      if (ch === "\\") { raw += src.slice(i, i + 2); if (src[i + 1] === "\n") line++; i += 2; continue; }
      if (ch === quote) { i++; break; }
      if (ch === "\n") break; // unterminated: stop at end of line
      raw += ch;
      i++;
    }
    tokens.push({ type: "str", value: unescapeJs(raw), line: startLine });
  };

  const readTemplate = () => {
    const startLine = line;
    i++;
    let raw = "";
    let dynamic = false;
    while (i < n) {
      const ch = src[i];
      if (ch === "\\") { raw += src.slice(i, i + 2); if (src[i + 1] === "\n") line++; i += 2; continue; }
      if (ch === "`") { i++; break; }
      if (ch === "$" && src[i + 1] === "{") { dynamic = true; i += 2; lexCode(true); continue; }
      if (ch === "\n") line++;
      raw += ch;
      i++;
    }
    tokens.push(dynamic ? { type: "tplx", value: "", line: startLine } : { type: "str", value: unescapeJs(raw), line: startLine });
  };

  const readRegex = () => {
    let j = i + 1;
    let inClass = false;
    while (j < n && src[j] !== "\n") {
      const ch = src[j];
      if (ch === "\\") { j += 2; continue; }
      if (inClass) { if (ch === "]") inClass = false; }
      else if (ch === "[") inClass = true;
      else if (ch === "/") break;
      j++;
    }
    if (src[j] !== "/") return false;
    j++;
    while (j < n && /[A-Za-z]/.test(src[j])) j++;
    tokens.push({ type: "regex", value: "", line });
    i = j;
    return true;
  };

  function lexCode(untilCloseBrace) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "\n") { line++; i++; continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (c === "#" && i === 0 && src[1] === "!") { while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "/") {
        let j = i;
        while (j < n && src[j] !== "\n") j++;
        comments.push({ line, text: src.slice(i, j) });
        i = j;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        const stop = end === -1 ? n : end + 2;
        const text = src.slice(i, stop);
        line += (text.match(/\n/g) ?? []).length;
        comments.push({ line, text }); // line of the comment's last row
        i = stop;
        continue;
      }
      if (c === '"' || c === "'") { readString(c); continue; }
      if (c === "`") { readTemplate(); continue; }
      if (c === "/" && regexAllowed() && readRegex()) continue;
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
        let j = i + 1;
        while (j < n && /[0-9A-Za-z_.]/.test(src[j])) j++;
        tokens.push({ type: "num", value: src.slice(i, j), line });
        i = j;
        continue;
      }
      if (ID_START.test(String.fromCodePoint(src.codePointAt(i))) || (c === "\\" && src[i + 1] === "u")) {
        const startLine = line;
        const name = readIdentifier();
        if (name) { tokens.push({ type: "id", value: name, line: startLine }); continue; }
      }
      if (c === "{") depth++;
      if (c === "}") {
        if (untilCloseBrace && depth === 0) { i++; return; }
        depth--;
      }
      if (src.startsWith("...", i)) { tokens.push({ type: "punct", value: "...", line }); i += 3; continue; }
      if (c === "?" && src[i + 1] === "." && !/[0-9]/.test(src[i + 2] ?? "")) { tokens.push({ type: "punct", value: "?.", line }); i += 2; continue; }
      tokens.push({ type: "punct", value: c, line });
      i++;
    }
  }

  lexCode(false);
  return { tokens, comments };
}

// ---------------------------------------------------------------------------------------------------------------
// Scanning one source file
// ---------------------------------------------------------------------------------------------------------------

/** Classify a module specifier. Returns {ok:true} | {ok:false, rule, message} | {allow:true} for child_process. */
export function classifySpecifier(spec, hostModules = []) {
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") return { ok: true };
  if (hostModules.some((h) => spec === h || spec.startsWith(h + "/"))) {
    const root = spec.split("/")[0];
    if (!NETWORK_MODULES.has(root) && root !== PROCESS_MODULE) return { ok: true };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec) && !spec.startsWith("node:")) {
    return { ok: false, rule: "url-import", message: `import of "${spec}" (URL or data: specifier)` };
  }
  if (spec.startsWith("/")) return { ok: false, rule: "absolute-import", message: `import of absolute path "${spec}"` };
  const bare = spec.replace(/^node:/, "");
  const root = bare.split("/")[0];
  if (root === PROCESS_MODULE) return { ok: false, allow: true, rule: "child-process", message: `import of "${spec}" (runs other programs)` };
  if (NETWORK_MODULES.has(root) || INTERNAL_NETWORK_MODULE.test(root)) {
    return { ok: false, rule: "network-module", message: `import of "${spec}" (network module)` };
  }
  if (spec.startsWith("node:") || NODE_BUILTINS.has(bare) || NODE_BUILTINS.has(root)) return { ok: true };
  return { ok: false, rule: "third-party-package", message: `import of "${spec}" (not a Node built-in: the engine has zero runtime dependencies)` };
}

export function scanSource(src, file = "<input>", { hostModules = [] } = {}) {
  const { tokens, comments } = lex(src);
  const violations = [];
  const allowed = [];
  const fail = (line, rule, message) => violations.push({ file, line, rule, message });
  const isDot = (t) => t?.type === "punct" && (t.value === "." || t.value === "?.");
  const is = (t, v) => t?.type === "punct" && t.value === v;

  const checkSpecifier = (tok) => {
    const r = classifySpecifier(tok.value, hostModules);
    if (r.ok) return;
    if (!r.allow) return fail(tok.line, r.rule, r.message);
    const marker = comments.find((c) => (c.line === tok.line || c.line === tok.line - 1) && ALLOW_MARKER.test(c.text));
    if (!marker) return fail(tok.line, r.rule, `${r.message}; allow it with "// wasitme:allow-child_process -- <reason>" on the same or previous line`);
    if (!ALLOW_MARKER.exec(marker.text)[1]) return fail(tok.line, r.rule, `${r.message}; the allow marker needs a reason after "--"`);
    allowed.push({ file, line: tok.line, module: tok.value });
  };

  const globalAccess = (k) => {
    const prev = tokens[k - 1];
    if (isDot(prev)) {
      const receiver = tokens[k - 2];
      return receiver?.type === "id" && GLOBAL_OBJECTS.has(receiver.value);
    }
    const isObjectKey = is(tokens[k + 1], ":") && (is(prev, "{") || is(prev, ","));
    return !isObjectKey;
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const prev = tokens[k - 1];
    const next = tokens[k + 1];

    if (t.type === "str" && prev?.type === "id" && prev.value === "from") checkSpecifier(t);

    if (t.type === "id" && !isDot(prev)) {
      if (t.value === "import") {
        if (next?.type === "str") checkSpecifier(next);
        else if (is(next, "(")) {
          const arg = tokens[k + 2];
          const after = tokens[k + 3];
          if (arg?.type === "str" && (is(after, ")") || is(after, ","))) checkSpecifier(arg);
          else fail(t.line, "dynamic-module-load", "import() with a specifier that is not a plain string literal cannot be checked");
        }
      } else if (t.value === "require") {
        if (is(next, "(")) {
          const arg = tokens[k + 2];
          if (arg?.type === "str" && (is(tokens[k + 3], ")") || is(tokens[k + 3], ","))) checkSpecifier(arg);
          else fail(t.line, "dynamic-module-load", "require() with a specifier that is not a plain string literal cannot be checked");
        } else if (!isDot(next)) {
          fail(t.line, "dynamic-module-load", "require used as a value; call it with a literal specifier or use import");
        }
      } else if (t.value === "createRequire") {
        fail(t.line, "dynamic-module-load", "createRequire can load any module; use static imports");
      } else if (t.value === "eval" && is(next, "(")) {
        fail(t.line, "dynamic-code", "eval() runs arbitrary code");
      } else if (t.value === "Function" && (is(next, "(") || (prev?.type === "id" && prev.value === "new"))) {
        fail(t.line, "dynamic-code", "the Function constructor runs arbitrary code");
      } else if (t.value === "process" && isDot(next) && tokens[k + 2]?.type === "id" && ["binding", "dlopen"].includes(tokens[k + 2].value)) {
        fail(t.line, "native-escape", `process.${tokens[k + 2].value} reaches native internals`);
      } else if (GLOBAL_OBJECTS.has(t.value) && is(next, "[")) {
        const arg = tokens[k + 2];
        const literal = arg?.type === "str" && is(tokens[k + 3], "]");
        if (!literal || NETWORK_GLOBALS.has(arg.value)) fail(t.line, "computed-global", `computed access on ${t.value} can reach network globals`);
      }
    }

    if (t.type === "id" && NETWORK_GLOBALS.has(t.value) && globalAccess(k)) {
      fail(t.line, "network-global", `use of the ${t.value} global (network API)`);
    }
  }
  return { violations, allowed };
}

// ---------------------------------------------------------------------------------------------------------------
// Swift and shell sources
// ---------------------------------------------------------------------------------------------------------------

const SWIFT_NETWORK_IMPORTS = new Set(["Network", "CFNetwork", "FoundationNetworking", "NetworkExtension", "MultipeerConnectivity", "CloudKit"]);
const SWIFT_NETWORK_API = /\b(?:URLSession\w*|NSURLSession\w*|URLRequest|NSURLRequest|NSMutableURLRequest|NSURLConnection|NWConnection|NWListener|NWBrowser|NWPathMonitor|NWEndpoint|NWParameters|CFSocket\w*|CFStreamCreatePairWithSocket\w*|CFHost\w*|SCNetworkReachability\w*|getStreamsToHost|getaddrinfo|gethostbyname2?|socket\s*\(\s*(?:AF|PF)_INET6?)\b/g;

/** Network use in Swift code (comments and string literals are masked first, so prose and URLs in strings pass). */
export function scanSwiftSource(src, file = "<input>") {
  const { code, lineOf } = scanSwift(src);
  const violations = [];
  for (const m of code.matchAll(/^[ \t]*(?:@[\w.]+(?:\([^)\n]*\))?[ \t]+)*import[ \t]+(?:(?:typealias|struct|class|enum|protocol|let|var|func)[ \t]+)?([A-Za-z_]\w*)/gm)) {
    if (SWIFT_NETWORK_IMPORTS.has(m[1])) violations.push({ file, line: lineOf(m.index), rule: "swift-network-import", message: `import ${m[1]} (networking framework)` });
  }
  // URLRequest is only a value, but it is how a web view or session reaches the network. The app's one legitimate use
  // (loading its own wasitme-app:// scheme) carries a marker with a reason on that line; nothing else is ever allowed.
  const rawLines = src.split("\n");
  const localSchemeLine = (line) => /wasitme:allow-local-scheme\s+--\s+\S/.test(rawLines[line - 1] ?? "");
  const allowed = [];
  for (const m of code.matchAll(SWIFT_NETWORK_API)) {
    const line = lineOf(m.index);
    const name = m[0].replace(/\s+/g, "");
    if (/^(?:URLRequest|NSURLRequest|NSMutableURLRequest)$/.test(name) && localSchemeLine(line)) {
      allowed.push({ file, line, rule: "swift-network-api", message: `${name} (local scheme, marked)` });
      continue;
    }
    violations.push({ file, line, rule: "swift-network-api", message: `${name} is a networking API` });
  }
  // String literals are masked in `code`, so network-scheme URL literals are found in the raw source.
  for (const m of src.matchAll(/\bURL\s*\(\s*string\s*:\s*"(?:https?|wss?|ftps?):/gi)) {
    violations.push({ file, line: src.slice(0, m.index).split("\n").length, rule: "swift-network-url", message: "URL literal with a network scheme" });
  }
  return { violations, allowed };
}

const SHELL_NETWORK_COMMAND = /(?:^|[\s;&|(`]|\$\()(curl|wget|nc|ncat|netcat|socat|telnet|ssh|scp|sftp|ftp|rsync)(?=$|[\s;&|)`])/g;

/** Network commands in a shell script (outside comments and quotes), and /dev/tcp|udp redirections anywhere. */
export function scanShellSource(src, file = "<input>") {
  const violations = [];
  for (const { text, line } of shellLines(src)) {
    const unquoted = text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
    for (const m of unquoted.matchAll(SHELL_NETWORK_COMMAND)) violations.push({ file, line, rule: "shell-network-command", message: `runs ${m[1]} (a network client)` });
    if (/\/dev\/(?:tcp|udp)\//.test(text)) violations.push({ file, line, rule: "shell-network-command", message: "uses a /dev/tcp or /dev/udp socket" });
  }
  return { violations, allowed: [] };
}

const SHELL_EXTENSIONS = new Set([".sh", ".bash", ".zsh"]);
const isShellScript = (path, ext) => {
  if (SHELL_EXTENSIONS.has(ext)) return true;
  if (ext !== "") return false;
  try {
    const head = readFileSync(path, { encoding: "latin1" }).slice(0, 200);
    return /^#![^\n]*\b(?:ba|z|da|k)?sh\b/.test(head);
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Scanning a tree
// ---------------------------------------------------------------------------------------------------------------

function walk(dir, report, opts = {}) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    report.violations.push({ file: dir, line: 0, rule: "unreadable", message: `cannot read directory: ${err.code ?? err.message}` });
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) {
      report.violations.push({ file: p, line: 0, rule: "symlink", message: "symlink inside a scanned tree (could point outside it)" });
    } else if (e.isDirectory()) {
      walk(p, report, opts);
    } else if (e.isFile()) {
      const ext = extname(e.name).toLowerCase();
      let result = null;
      if (BINARY_EXTENSIONS.has(ext)) {
        report.violations.push({ file: p, line: 0, rule: "binary-code", message: `native/binary code (${ext}) cannot be inspected` });
      } else if (SOURCE_EXTENSIONS.has(ext)) {
        result = scanSource(readFileSync(p, "utf8"), p, opts);
      } else if (ext === ".swift") {
        result = scanSwiftSource(readFileSync(p, "utf8"), p);
      } else if (isShellScript(p, ext)) {
        result = scanShellSource(readFileSync(p, "utf8"), p);
      }
      if (result) {
        report.filesScanned++;
        report.violations.push(...result.violations);
        report.allowed.push(...result.allowed);
      }
    }
  }
}

/** Check a package.json for runtime dependencies and install-time scripts. */
export function checkPackageJson(path) {
  const violations = [];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return [{ file: path, line: 0, rule: "package-json", message: `cannot read package.json: ${err.message}` }];
  }
  for (const field of DEPENDENCY_FIELDS) {
    const v = pkg[field];
    const count = Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0;
    if (count > 0) violations.push({ file: path, line: 0, rule: "runtime-dependency", message: `"${field}" is not empty (the engine has zero runtime dependencies)` });
  }
  for (const name of INSTALL_SCRIPTS) {
    if (pkg.scripts && typeof pkg.scripts === "object" && name in pkg.scripts) {
      violations.push({ file: path, line: 0, rule: "install-script", message: `scripts.${name} runs code on the user's machine at install time` });
    }
  }
  return violations;
}

/** Scan directories. Each directory's sibling `../package.json` is checked too when it exists. */
export function scanDirectories(dirs, opts = {}) {
  const report = { filesScanned: 0, violations: [], allowed: [], packagesChecked: 0 };
  for (const dir of dirs) {
    let st;
    try { st = lstatSync(dir); } catch { st = undefined; }
    if (!st || !st.isDirectory()) {
      report.violations.push({ file: dir, line: 0, rule: "missing-directory", message: "directory does not exist" });
      continue;
    }
    walk(dir, report, opts);
    const pkgPath = join(dir, "..", "package.json");
    if (existsSync(pkgPath)) {
      report.packagesChecked++;
      report.violations.push(...checkPackageJson(pkgPath));
    }
  }
  return report;
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------

function main(argv, out = console) {
  if (argv.includes("--self-test")) return selfTest();
  if (argv.includes("-h") || argv.includes("--help")) {
    out.log("usage: check-no-network.mjs [--host-module NAME]... [dir ...]   (default: engine/src)\n       check-no-network.mjs --self-test");
    return 0;
  }
  const hostModules = [];
  const dirArgs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host-module") {
      const v = argv[++i];
      if (!v || v.startsWith("-") || NETWORK_MODULES.has(v) || v === PROCESS_MODULE) { out.error("check-no-network: --host-module needs a module name (never a network module)"); return 2; }
      hostModules.push(v);
    } else if (a.startsWith("-")) { out.error(`check-no-network: unknown option ${a}`); return 2; }
    else dirArgs.push(a);
  }
  const dirs = dirArgs.length ? dirArgs.map((d) => resolve(d)) : [join(REPO_ROOT, "engine", "src")];
  const report = scanDirectories(dirs, { hostModules });
  const show = (p) => relative(process.cwd(), p) || p;
  // A JS/TS hit names its module and the child_process marker; a Swift hit (a marked local-scheme load) names its API.
  for (const a of report.allowed) {
    const marker = a.rule === "swift-network-api" ? "wasitme:allow-local-scheme" : "wasitme:allow-child_process";
    out.log(`allowed: ${show(a.file)}:${a.line} ${a.module ?? a.message} (${marker})`);
  }
  for (const v of report.violations) out.error(`${show(v.file)}${v.line ? ":" + v.line : ""}: [${v.rule}] ${v.message}`);
  if (report.violations.length) {
    out.error(`check-no-network: FAILED with ${report.violations.length} violation(s) in ${report.filesScanned} file(s)`);
    return 1;
  }
  if (report.filesScanned === 0) {
    out.error("check-no-network: scanned 0 source files - wrong directory? Refusing to pass vacuously.");
    return 2;
  }
  out.log(`check-no-network: OK (${report.filesScanned} files scanned, ${report.packagesChecked} package.json checked, ${report.allowed.length} allow-listed)`);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Self-test (run in CI: node scripts/check-no-network.mjs --self-test)
// ---------------------------------------------------------------------------------------------------------------

function selfTest() {
  const rules = (src) => scanSource(src, "t.ts").violations.map((v) => v.rule);
  const clean = (name, src) => assert.deepEqual(scanSource(src, "t.ts").violations, [], `${name} should be clean`);
  const dirty = (name, src, rule) => assert.ok(rules(src).includes(rule), `${name} should trigger ${rule}, got [${rules(src)}]`);

  // Code that must pass.
  clean("builtins", `import { readFileSync } from "node:fs";\nimport path from "path";\nimport { x } from "./x.js";\nimport "../y.js";`);
  clean("words in comments", `// import http from "node:http"; fetch(url); WebSocket\n/* require("net") \n fetch() */\nconst a = 1;`);
  clean("words in strings", `const a = "import http from 'node:http'"; const b = 'fetch(x)'; const c = "WebSocket";`);
  clean("words in templates", "const a = `we never call fetch( or import(\"node:net\")`;");
  clean("regex with quotes", "const re = /[\"'`]fetch/g; const ok = re.test(\"x\"); const b = 4 / 2; const c = a / 2 / 3;");
  clean("regex after return", `function f(s) { return /fetch\\(/.test(s); }`);
  clean("property named fetch", `const o = { fetch: 1, WebSocket: 2 }; o.fetch; o.WebSocket; cache.fetch(key);`);
  clean("template substitution is lexed as code", "const s = `a ${1 + 1} b ${\"x\"}`; const t = 1;");
  clean("import.meta and require.resolve", `const u = import.meta.url; const r = require.resolve("x");`);
  clean("hashbang", `#!/usr/bin/env node\nimport fs from "node:fs";`);

  // Network modules, every spelling.
  for (const m of ["http", "https", "http2", "net", "dns", "dns/promises", "tls", "dgram", "cluster", "inspector", "inspector/promises", "_http_client"]) {
    dirty(`import ${m}`, `import x from "node:${m}";`, "network-module");
    dirty(`bare import ${m}`, `import x from "${m}";`, "network-module");
  }
  dirty("side-effect import", `import "node:net";`, "network-module");
  dirty("export from", `export * from "node:tls";`, "network-module");
  dirty("export named from", `export { request } from 'node:https';`, "network-module");
  dirty("import type", `import type { Server } from "node:http";`, "network-module");
  dirty("multi-line import", `import {\n  createServer,\n} from\n  "node:http";`, "network-module");
  dirty("dynamic import", `const m = await import("node:dgram");`, "network-module");
  dirty("dynamic import template", "const m = await import(`node:http`);", "network-module");
  dirty("require", `const n = require("net");`, "network-module");
  dirty("import = require", `import n = require("node:dns");`, "network-module");
  dirty("escaped specifier", `import x from "node:\\x68ttp";`, "network-module");
  dirty("unicode-escaped specifier", `import x from "node:\\u0068ttp";`, "network-module");

  // Not a built-in / not relative.
  dirty("npm package", `import got from "got";`, "third-party-package");
  dirty("scoped package", `import x from "@scope/pkg";`, "third-party-package");
  dirty("url import", `import x from "https://example.test/x.js";`, "url-import");
  dirty("data import", `import x from "data:text/javascript,export default 1";`, "url-import");
  dirty("absolute import", `import x from "/etc/x.js";`, "absolute-import");

  // Unverifiable loads and code execution.
  dirty("dynamic non-literal import", `const m = await import(name);`, "dynamic-module-load");
  dirty("dynamic concatenated import", `await import("node:" + "http");`, "dynamic-module-load");
  dirty("template substitution import", "await import(`node:${x}`);", "dynamic-module-load");
  dirty("non-literal require", `require(name);`, "dynamic-module-load");
  dirty("require as value", `const r = require; r("x");`, "dynamic-module-load");
  dirty("createRequire", `import { createRequire } from "node:module"; const r = createRequire(import.meta.url);`, "dynamic-module-load");
  dirty("eval", `eval("1");`, "dynamic-code");
  dirty("new Function", `const f = new Function("return 1");`, "dynamic-code");
  dirty("process.binding", `process.binding("tcp_wrap");`, "native-escape");

  // Network globals.
  dirty("fetch call", `const r = await fetch(url);`, "network-global");
  dirty("globalThis.fetch", `globalThis.fetch(url);`, "network-global");
  dirty("optional chain fetch", `globalThis?.fetch?.(url);`, "network-global");
  dirty("fetch as value", `const f = ok ? fetch : null;`, "network-global");
  dirty("globalThis bracket", `globalThis["fetch"](url);`, "computed-global");
  dirty("globalThis computed", `globalThis[name](url);`, "computed-global");
  dirty("WebSocket", `const ws = new WebSocket(u);`, "network-global");
  dirty("XMLHttpRequest", `new XMLHttpRequest();`, "network-global");
  dirty("EventSource", `new EventSource(u);`, "network-global");
  dirty("sendBeacon", `navigator.sendBeacon(u, d);`, "network-global");
  dirty("identifier escape", `\\u0066etch(url);`, "network-global");
  dirty("fetch after spread", `const a = [...fetch];`, "network-global");

  // child_process allow marker.
  const cp = `import { execFile } from "node:child_process";`;
  assert.deepEqual(scanSource(`${cp} // wasitme:allow-child_process -- fixed argv, no log-derived input`, "t.ts").violations, []);
  assert.equal(scanSource(`${cp} // wasitme:allow-child_process -- fixed argv`, "t.ts").allowed.length, 1);
  assert.deepEqual(scanSource(`// wasitme:allow-child_process -- fixed argv\n${cp}`, "t.ts").violations, []);
  assert.deepEqual(scanSource(`/* wasitme:allow-child_process -- fixed argv */\n${cp}`, "t.ts").violations, []);
  dirty("child_process without marker", cp, "child-process");
  dirty("marker without reason", `${cp} // wasitme:allow-child_process`, "child-process");
  dirty("marker with empty reason", `${cp} // wasitme:allow-child_process --`, "child-process");
  dirty("marker too far away", `// wasitme:allow-child_process -- fixed argv\n\n${cp}`, "child-process");
  dirty("marker below the import", `${cp}\n// wasitme:allow-child_process -- fixed argv`, "child-process");
  dirty("require child_process", `const c = require("child_process");`, "child-process");
  dirty("marker never excuses a network module", `import h from "node:http"; // wasitme:allow-child_process -- nope`, "network-module");

  // Host modules (the Claude Code mod API): allowed only when named, and never a network module.
  dirty("host module without --host-module", `import { x } from "claude-code";`, "third-party-package");
  assert.deepEqual(scanSource(`import { x } from "claude-code";\nimport t from "claude-code/testing";`, "t.ts", { hostModules: ["claude-code"] }).violations, []);
  assert.ok(scanSource(`import { x } from "claude-codex";`, "t.ts", { hostModules: ["claude-code"] }).violations.length === 1, "a prefix is not the module");

  // Swift: networking frameworks and APIs in code; the same words in comments and strings pass.
  const swiftRules = (src) => scanSwiftSource(src, "t.swift").violations.map((v) => v.rule);
  assert.deepEqual(swiftRules("import Foundation\nimport AppKit\nlet u = URL(fileURLWithPath: \"/tmp\")\n// URLSession is not used\nlet s = \"URLSession and import Network\""), []);
  assert.deepEqual(swiftRules("import Network\n"), ["swift-network-import"]);
  assert.deepEqual(swiftRules("@preconcurrency import CFNetwork\n"), ["swift-network-import"]);
  assert.deepEqual(swiftRules("let t = URLSession.shared.dataTask(with: u)\n"), ["swift-network-api"]);
  assert.deepEqual(swiftRules("var r = URLRequest(url: u)\n"), ["swift-network-api"]);
  assert.deepEqual(swiftRules("webView.load(URLRequest(url: CanvasRouter.entryURL))\n"), ["swift-network-api"], "unmarked URLRequest fails");
  assert.deepEqual(swiftRules("webView.load(URLRequest(url: CanvasRouter.entryURL)) // wasitme:allow-local-scheme -- own scheme\n"), [], "marked local-scheme load passes");
  assert.deepEqual(swiftRules("webView.load(URLRequest(url: u)) // wasitme:allow-local-scheme\n"), ["swift-network-api"], "a marker needs a reason");
  assert.deepEqual(swiftRules("let s = URLSession.shared // wasitme:allow-local-scheme -- nope\n"), ["swift-network-api"], "the marker never covers URLSession");
  assert.deepEqual(swiftRules('let u = URL(string: "https://example.invalid/x")!\n'), ["swift-network-url"]);
  assert.deepEqual(swiftRules('let u = URL(string: "wasitme-app://app/index.html")!\n'), []);
  assert.deepEqual(swiftRules("let (d, _) = try await NSURLSession.shared.data(from: u)\n"), ["swift-network-api"]);
  assert.deepEqual(swiftRules("let c = NWConnection(host: h, port: 80, using: .tcp)\n"), ["swift-network-api"]);
  assert.deepEqual(swiftRules("let fd = socket(AF_INET, SOCK_STREAM, 0)\n"), ["swift-network-api"]);

  // Shell: network clients outside quotes and comments.
  const shellRules = (src) => scanShellSource(src, "t.sh").violations.map((v) => v.rule);
  assert.deepEqual(shellRules('#!/bin/sh\n# curl is never used here\necho "no curl, no wget"\nprintf \'%s\\n\' "ssh"\nmkdir -p "$d"\n'), []);
  assert.deepEqual(shellRules("curl -fsSL https://example.test/x\n"), ["shell-network-command"]);
  assert.deepEqual(shellRules('x=$(wget -qO- "$u")\n'), ["shell-network-command"]);
  assert.deepEqual(shellRules("if true; then nc -l 8080; fi\n"), ["shell-network-command"]);
  assert.deepEqual(shellRules('exec 3<>/dev/tcp/example.test/80\n'), ["shell-network-command"]);

  // Trees: file types, symlinks, package.json, vacuous scans.
  const tmp = mkdtempSync(join(tmpdir(), "wasitme-nonet-"));
  try {
    const pkgDir = join(tmp, "pkg");
    const src = join(pkgDir, "src");
    mkdirSync(join(src, "nested"), { recursive: true });
    writeFileSync(join(src, "a.ts"), `import { readFileSync } from "node:fs";\nexport const a = readFileSync;\n`);
    writeFileSync(join(src, "nested", "b.mjs"), `export const b = 2;\n`);
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "x", dependencies: {}, scripts: { test: "node --test" } }));
    const ok = scanDirectories([src]);
    assert.equal(ok.filesScanned, 2);
    assert.deepEqual(ok.violations, []);
    assert.equal(ok.packagesChecked, 1);

    writeFileSync(join(src, "nested", "c.js"), `const x = fetch;\n`);
    const bad = scanDirectories([src]);
    assert.equal(bad.violations.length, 1);
    assert.equal(basename(bad.violations[0].file), "c.js");
    rmSync(join(src, "nested", "c.js"));

    writeFileSync(join(src, "addon.node"), "\0");
    assert.ok(scanDirectories([src]).violations.some((v) => v.rule === "binary-code"));
    rmSync(join(src, "addon.node"));

    symlinkSync(tmp, join(src, "escape"));
    assert.ok(scanDirectories([src]).violations.some((v) => v.rule === "symlink"));
    rmSync(join(src, "escape"));

    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ dependencies: { got: "^14.0.0" } }));
    assert.ok(scanDirectories([src]).violations.some((v) => v.rule === "runtime-dependency"));
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ optionalDependencies: { fsevents: "*" } }));
    assert.ok(scanDirectories([src]).violations.some((v) => v.rule === "runtime-dependency"));
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ scripts: { postinstall: "node x.js" } }));
    assert.ok(scanDirectories([src]).violations.some((v) => v.rule === "install-script"));
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ devDependencies: { typescript: "^5" } }));
    assert.deepEqual(scanDirectories([src]).violations, []);

    // Swift and shell files in a tree are scanned too (and counted).
    const app = join(tmp, "app");
    mkdirSync(app);
    writeFileSync(join(app, "A.swift"), "import Foundation\nlet x = 1\n");
    writeFileSync(join(app, "hook.sh"), "#!/bin/sh\necho ok\n");
    writeFileSync(join(app, "statusline"), "#!/bin/sh\necho ok\n");
    assert.deepEqual(scanDirectories([app]).violations, []);
    assert.equal(scanDirectories([app]).filesScanned, 3, "swift, .sh and an extensionless #!/bin/sh script");
    writeFileSync(join(app, "statusline"), "#!/bin/sh\ncurl -s https://example.test\n");
    assert.ok(scanDirectories([app]).violations.some((v) => v.rule === "shell-network-command"));

    // CLI exit codes (spawned, so the real entry point is exercised).
    const run = (...args) => spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8" });
    assert.equal(run(src).status, 0);
    const empty = join(tmp, "empty");
    mkdirSync(empty);
    assert.equal(run(empty).status, 2, "an empty tree must not pass vacuously");
    assert.equal(run(join(tmp, "does-not-exist")).status, 1, "a missing directory is a violation");
    assert.equal(run("--bogus").status, 2);
    assert.equal(run("--host-module").status, 2, "--host-module needs a value");
    assert.equal(run("--host-module", "http", src).status, 2, "a network module can never be a host module");
    writeFileSync(join(src, "evil.ts"), `import net from "node:net";\n`);
    const failing = run(src);
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /evil\.ts:1: \[network-module\]/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log("check-no-network: self-test passed");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) process.exitCode = main(process.argv.slice(2));
