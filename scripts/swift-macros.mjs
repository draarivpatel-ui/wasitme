#!/usr/bin/env node
// swift-macros.mjs - keeps macos/ buildable with only the Command Line Tools (macos/README.md, "Toolchain traps").
//
// Why: the macOS SDK declares many features as Swift macros, and a macro only compiles if its compiler plugin is
// present. The Command Line Tools ship three plugins (verified 2026-10-04, /Library/Developer/CommandLineTools/usr/lib/
// swift/host/plugins): libSwiftMacros, libObservationMacros and testing/libTestingMacros. Every other plugin
// (SwiftUIMacros, PreviewsMacros, FoundationMacros, SwiftDataMacros, AppIntentsMacros, FoundationModelsMacros,
// TipKitMacros, StateReportingMacros, ...) ships with Xcode only, so a CLT-only `swift build` fails with "plugin for
// module 'X' not found". Verified 2026-10-04 with the CLT's own swiftc and SDK (macOS 27.0): `@State`, `@Entry`,
// `#Preview`, `@Animatable` (SwiftUIMacros/PreviewsMacros) and Foundation's `#Predicate` (FoundationMacros) each fail
// alone, while `@Observable` and `@Bindable` (Observation, whose plugin ships with the CLT) compile.
//
// So the ban is BY PLUGIN MODULE, not by framework: every `macro` declared in any .swiftinterface of the SDK
// (System/Library/Frameworks/*.framework and usr/lib/swift) whose #externalMacro module is not one the CLT ships
// (CLT_PLUGIN_MODULES) is banned. Built-ins without a plugin module (#file, #line, #warning, ...) are never banned.
// The list is NOT hand-written, so a new SDK that turns another API into a macro is caught the day it is installed. It
// is unioned with the committed snapshot scripts/swift-macros.known (written by --write-known), so a CI runner or
// contributor with an OLDER SDK still bans what a newer SDK declares. With no SDK at all (Linux) the snapshot alone is
// used; with neither, the check refuses to pass.
//
// Common names: macros from frameworks a Mac app does not import implicitly (SwiftData's @Model/@Index/@Attribute,
// TipKit's #Rule/@Parameter, FoundationModels' @Guide, AppIntents, StateReporting, WidgetKit, ...) only count in a file
// that imports the framework (directly, or through a module whose interface `@_exported import`s it), so the app's
// own property wrapper called `Parameter` is not mistaken for TipKit's. Macros from SwiftUI, SwiftUICore, Foundation and
// AppKit are banned in every file: those are visible through Clang umbrella re-exports this script cannot see.
//
// Usage:
//   node scripts/swift-macros.mjs [options] [dir ...]     scan Swift files under dir (default: macos)
//
//   --root DIR            repository root (default: the directory above scripts/)
//   --sdk PATH            SDK to read (default: `xcrun --sdk macosx --show-sdk-path`, which honours DEVELOPER_DIR / SDKROOT)
//   --only-selected-sdk   read only that SDK. By default every MacOSX*.sdk next to it is read too and the lists are
//                         merged: the app has to build for users whose SDK differs from this machine's (the spike:
//                         @State is fine with SDK 26.5 and a macro with SDK 27.0), so a macro declared by ANY installed
//                         SDK is banned.
//   --interface FILE      read this .swiftinterface directly instead of the SDK (repeatable; used by the tests)
//   --frameworks A,B      read only these frameworks' interfaces (default: every framework and usr/lib/swift module)
//   --list                print the macro list that is enforced (name, role, plugin module, frameworks) and exit
//   --write-known         write that list to scripts/swift-macros.known (merged with what is already there) and exit
//   --allow-missing-sdk   exit 0 with a notice when no interface can be found (e.g. a Linux runner)
//
// Exit codes: 0 clean or skipped, 1 a banned macro is used, 2 error (no SDK interface while Swift sources exist, an
// interface with zero macros, usage). Skipped = no Swift sources under the scanned dirs.
//
// What counts as a use: `@Name` for attached macros and `#Name` for freestanding ones (optionally module-qualified),
// matched whole-word in code only: comments and string literals are masked first, so `@StateObject` and "@State" in a
// string are fine. Excluded: **/reference/** (spike code, never built), .build/, .swiftpm/. Tests/ is scanned.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extOf, listFiles, matchesAny, readText, scanSwift } from "./lib/source-scan.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(SELF));
/** Plugin modules the Command Line Tools ship (host/plugins), so their macros build without Xcode. */
export const CLT_PLUGIN_MODULES = new Set(["SwiftMacros", "ObservationMacros", "TestingMacros"]);
/** Frameworks whose macros are banned in every file (implicitly visible in a Mac app; see the header). */
const AMBIENT_FRAMEWORKS = new Set(["SwiftUI", "SwiftUICore", "Foundation", "AppKit", "Cocoa", "Swift", "_Concurrency"]);
const ARCH_PREFERENCE = ["arm64e-apple-macos", "arm64-apple-macos", "x86_64-apple-macos"];
const EXCLUDE = ["**/reference/**", "**/.build/**", "**/.swiftpm/**"];
const KNOWN_FILE = "scripts/swift-macros.known";

// ---------------------------------------------------------------------------------------------------------------
// Deriving the list from a .swiftinterface
// ---------------------------------------------------------------------------------------------------------------

const ATTRIBUTES_ONLY = /^(?:\s*@[\w.]+(?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?)*\s*$/;
const MODIFIER_TAIL = /\b(?:public|package|internal|open|private|fileprivate)\s+$/;

/** [{name, roles:["attached"|"freestanding"], module}] from the text of one .swiftinterface (one entry per name). */
export function parseMacros(text) {
  const lines = text.split("\n");
  const byName = new Map();
  let offset = 0;
  lines.forEach((line, idx) => {
    const lineStart = offset;
    offset += line.length + 1;
    const m = /\bmacro\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/.exec(line);
    if (!m) return;
    const prefix = line.slice(0, m.index).replace(MODIFIER_TAIL, "");
    if (!ATTRIBUTES_ONLY.test(prefix)) return; // inside a comment, string or some other declaration
    // Roles come from the attributes on this line and from attribute-only lines directly above it.
    let attrs = prefix;
    for (let k = idx - 1; k >= 0 && k >= idx - 6; k--) {
      const above = lines[k].trim();
      if (!above.startsWith("@") || !ATTRIBUTES_ONLY.test(above)) break;
      attrs += " " + above;
    }
    const roles = [];
    if (/@attached\b/.test(attrs)) roles.push("attached");
    if (/@freestanding\b/.test(attrs)) roles.push("freestanding");
    const after = text.slice(lineStart + m.index, lineStart + m.index + 600);
    const mod = /#externalMacro\(\s*module:\s*"([^"]+)"/.exec(after)?.[1] ?? null;
    const prev = byName.get(m[1]);
    if (prev) {
      for (const r of roles) if (!prev.roles.includes(r)) prev.roles.push(r);
      prev.module ??= mod;
    } else byName.set(m[1], { name: m[1], roles, module: mod });
  });
  return [...byName.values()];
}

/**
 * Union of the macros declared in several interfaces, sorted by name. Each input is the interface text, or
 * {text, framework}; a macro then records the frameworks that declare it.
 */
export function deriveMacros(inputs) {
  const merged = new Map();
  for (const input of inputs) {
    const { text, framework = null } = typeof input === "string" ? { text: input } : input;
    for (const mac of parseMacros(text)) {
      const prev = merged.get(mac.name);
      const fws = framework ? [framework] : [];
      if (!prev) merged.set(mac.name, { ...mac, roles: [...mac.roles], frameworks: fws });
      else {
        for (const r of mac.roles) if (!prev.roles.includes(r)) prev.roles.push(r);
        prev.module ??= mac.module;
        for (const f of fws) if (!prev.frameworks.includes(f)) prev.frameworks.push(f);
      }
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Only the macros a Command Line Tools-only build cannot expand: a plugin module that is not in CLT_PLUGIN_MODULES. */
export const bannedOnly = (macros) => macros.filter((m) => m.module && !CLT_PLUGIN_MODULES.has(m.module));

/** {framework: [modules it re-exports]} from `@_exported import X` lines of interface texts ({text, framework}). */
export function reexportMap(inputs) {
  const map = {};
  for (const { text, framework } of inputs) {
    if (!framework) continue;
    const set = new Set(map[framework] ?? []);
    for (const m of text.matchAll(/^@_exported\s+import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([A-Za-z_]\w*)/gm)) set.add(m[1]);
    map[framework] = [...set];
  }
  return map;
}

/** Module name an interface declares (`-module-name X` in its flags line), else from its X.swiftmodule directory. */
export function interfaceModuleName(text, file = "") {
  return /-module-name\s+([A-Za-z_]\w*)/.exec(text.slice(0, 4096))?.[1] ?? /([A-Za-z_]\w*)\.swiftmodule\/[^/]*$/.exec(file)?.[1] ?? null;
}

/** `xcrun --sdk macosx --show-sdk-path`, or null. */
export function defaultSdkPath(env = process.env) {
  try {
    return execFileSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** The SDK itself plus every MacOSX*.sdk beside it (distinct real paths), selected one first. */
export function sdkFamily(sdk) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    try {
      const real = realpathSync(p);
      if (!seen.has(real)) { seen.add(real); out.push(p); }
    } catch { /* unreadable: skip */ }
  };
  add(sdk);
  try {
    for (const name of readdirSync(dirname(sdk)).sort()) if (/^MacOSX.*\.sdk$/.test(name)) add(join(dirname(sdk), name));
  } catch { /* no siblings */ }
  return out;
}

function pickInterface(dir) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".swiftinterface") && !n.includes(".private.") && !n.includes(".package."));
  } catch {
    return null;
  }
  return ARCH_PREFERENCE.map((a) => `${a}.swiftinterface`).find((n) => names.includes(n))
    ?? names.find((n) => n.includes("-apple-macos") && !n.includes("macabi")) ?? names[0] ?? null;
}

/**
 * One interface file per module (arch preference: arm64e, arm64, x86_64), as [{framework, file}]. `frameworks` null =
 * every framework under System/Library/Frameworks plus every module under usr/lib/swift.
 */
export function findInterfaces(sdk, frameworks = null) {
  const found = [];
  const fwRoot = join(sdk, "System", "Library", "Frameworks");
  let names = frameworks;
  if (!names) {
    try {
      names = readdirSync(fwRoot).filter((n) => n.endsWith(".framework")).map((n) => n.slice(0, -".framework".length)).sort();
    } catch {
      names = [];
    }
  }
  for (const fw of names) {
    const dir = join(fwRoot, `${fw}.framework`, "Modules", `${fw}.swiftmodule`);
    if (!existsSync(dir)) continue;
    const pick = pickInterface(dir);
    if (pick) found.push({ framework: fw, file: join(dir, pick) });
  }
  const libRoot = join(sdk, "usr", "lib", "swift");
  let libs = [];
  try {
    libs = readdirSync(libRoot).filter((n) => n.endsWith(".swiftmodule")).map((n) => n.slice(0, -".swiftmodule".length)).sort();
  } catch { /* no usr/lib/swift */ }
  for (const mod of libs) {
    if (frameworks && !frameworks.includes(mod)) continue;
    const pick = pickInterface(join(libRoot, `${mod}.swiftmodule`));
    if (pick) found.push({ framework: mod, file: join(libRoot, `${mod}.swiftmodule`, pick) });
  }
  return found;
}

/** The banned macros of one or more SDK directories, with their re-export map: {macros, reexports, files}. */
export function sdkMacros(sdkDirs, frameworks = null) {
  const files = sdkDirs.flatMap((d) => findInterfaces(d, frameworks));
  const inputs = files.map((f) => ({ framework: f.framework, text: readFileSync(f.file, "utf8") }));
  return { macros: bannedOnly(deriveMacros(inputs)), reexports: reexportMap(inputs), files };
}

// ---------------------------------------------------------------------------------------------------------------
// Finding uses
// ---------------------------------------------------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

/** Modules a Swift file can see: its imports, closed over `@_exported import` (from `reexports`). */
export function visibleModules(maskedCode, reexports = {}) {
  const seen = new Set();
  const queue = [];
  for (const m of maskedCode.matchAll(/^[ \t]*(?:@[\w.]+(?:\([^)\n]*\))?[ \t]+)*import[ \t]+(?:(?:typealias|struct|class|enum|protocol|let|var|func)[ \t]+)?([A-Za-z_]\w*)/gm)) queue.push(m[1]);
  while (queue.length) {
    const mod = queue.pop();
    if (seen.has(mod)) continue;
    seen.add(mod);
    for (const r of reexports[mod] ?? []) queue.push(r);
  }
  return seen;
}

/** Does this macro count in a file that sees `visible`? Ambient-framework (or framework-less) macros always do. */
function macroVisible(mac, visible) {
  const fws = mac.frameworks ?? [];
  if (!fws.length || fws.some((f) => AMBIENT_FRAMEWORKS.has(f))) return true;
  // A cross-import overlay such as _SwiftData_SwiftUI (declares @Query) is visible when one of its parts is imported.
  return fws.some((f) => visible.has(f) || (f.startsWith("_") && f.slice(1).split("_").some((part) => part && !AMBIENT_FRAMEWORKS.has(part) && visible.has(part))));
}

/** Uses of the banned macros in Swift source: [{line, name, sigil, module}]. Comments and strings are ignored. */
export function findMacroUses(text, macros, reexports = {}) {
  if (!macros.length) return [];
  const { code, lineOf } = scanSwift(text);
  const visible = visibleModules(code, reexports);
  const byName = new Map(macros.map((m) => [m.name, m]));
  const re = new RegExp(String.raw`(?<![\w])([@#])(?:[A-Za-z_]\w*\.)*(${macros.map((m) => escapeRe(m.name)).join("|")})(?![\w])`, "g");
  const out = [];
  for (const m of code.matchAll(re)) {
    const mac = byName.get(m[2]);
    const wantsAt = mac.roles.includes("attached") || !mac.roles.length;
    const wantsHash = mac.roles.includes("freestanding") || !mac.roles.length;
    if (!((m[1] === "@" && wantsAt) || (m[1] === "#" && wantsHash))) continue;
    if (!macroVisible(mac, visible)) continue;
    out.push({ line: lineOf(m.index), name: mac.name, sigil: m[1], module: mac.module });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------

/**
 * `name<TAB>roles joined by +<TAB>module[<TAB>frameworks joined by ,]` lines (the --list format). `#` comments and blank
 * lines are ignored. A line without the frameworks column is banned in every file (no import gating).
 */
export function parseKnown(text, source = "known list") {
  const out = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) return;
    const [name, roles = "", mod = "-", fws = ""] = line.split("\t");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name ?? "") || !/^(?:|unknown|(?:attached|freestanding)(?:\+(?:attached|freestanding))*)$/.test(roles) || !/^(?:|[A-Za-z_]\w*(?:,[A-Za-z_]\w*)*)$/.test(fws)) {
      throw new Error(`${source}:${i + 1}: expected "name<TAB>attached|freestanding|attached+freestanding<TAB>module[<TAB>Framework,Framework]"`);
    }
    out.push({ name, roles: roles === "unknown" || !roles ? [] : roles.split("+"), module: mod === "-" ? null : mod, frameworks: fws ? fws.split(",") : [] });
  });
  return out;
}

export const formatMacros = (macros) =>
  macros.map((m) => `${m.name}\t${m.roles.join("+") || "unknown"}\t${m.module ?? "-"}${m.frameworks?.length ? `\t${[...m.frameworks].sort().join(",")}` : ""}`);

/** Union by name (roles and frameworks merged), sorted. */
export function mergeMacros(...lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const mac of list) {
      const prev = merged.get(mac.name);
      if (!prev) merged.set(mac.name, { ...mac, roles: [...mac.roles], frameworks: [...(mac.frameworks ?? [])] });
      else {
        for (const r of mac.roles) if (!prev.roles.includes(r)) prev.roles.push(r);
        prev.module ??= mac.module;
        for (const f of mac.frameworks ?? []) if (!prev.frameworks.includes(f)) prev.frameworks.push(f);
      }
    }
  }
  return [...merged.values()].sort((x, y) => x.name.localeCompare(y.name));
}

export function main(argv, io = { out: (m) => process.stdout.write(m + "\n"), err: (m) => process.stderr.write(m + "\n") }, env = process.env) {
  let root = REPO_ROOT;
  let sdk = null;
  const interfaces = [];
  let frameworks = null;
  let list = false;
  let writeKnown = false;
  let allowMissing = false;
  let onlySelected = false;
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root" || a === "--sdk" || a === "--interface" || a === "--frameworks") {
      const v = argv[++i];
      if (v === undefined || v === "" || v.startsWith("--")) { io.err(`swift-macros: ${a} needs a value`); return 2; }
      if (a === "--root") root = resolve(v);
      else if (a === "--sdk") sdk = resolve(v);
      else if (a === "--interface") interfaces.push(resolve(v));
      else frameworks = v.split(",").filter(Boolean);
    } else if (a === "--list") list = true;
    else if (a === "--write-known") writeKnown = true;
    else if (a === "--allow-missing-sdk") allowMissing = true;
    else if (a === "--only-selected-sdk") onlySelected = true;
    else if (a === "-h" || a === "--help") { io.out("usage: swift-macros.mjs [--root DIR] [--sdk PATH [--only-selected-sdk] | --interface FILE ...] [--frameworks A,B] [--list | --write-known] [--allow-missing-sdk] [dir ...]"); return 0; }
    else if (a.startsWith("--")) { io.err(`swift-macros: unknown option ${a}`); return 2; }
    else dirs.push(a.replace(/\/+$/, ""));
  }
  if (!dirs.length) dirs.push("macos");
  const inspect = list || writeKnown;

  const swiftFiles = inspect ? [] : listFiles(root).filter((rel) => extOf(rel) === "swift" && matchesAny(rel, dirs.map((d) => `${d}/**`)) && !matchesAny(rel, EXCLUDE));
  if (!inspect && swiftFiles.length === 0) {
    io.out(`swift-macros: SKIPPED (no Swift sources under ${dirs.join(", ")})`);
    return 0;
  }

  // The committed snapshot (scripts/swift-macros.known): macros seen in newer SDKs than this machine or CI runner has.
  const knownPath = join(root, KNOWN_FILE);
  let known = [];
  if (existsSync(knownPath)) {
    try {
      // A recorded module the CLT ships is dropped; an entry with no recorded module keeps being banned.
      known = parseKnown(readFileSync(knownPath, "utf8"), KNOWN_FILE).filter((m) => !m.module || !CLT_PLUGIN_MODULES.has(m.module));
    } catch (e) {
      io.err(`swift-macros: ${e.message}`);
      return 2;
    }
  }

  // Interface files: explicit, or from the SDK (the selected one plus its siblings).
  let files = interfaces.map((file) => ({ framework: null, file }));
  let sdkWhy = null;
  let sdkPath = null;
  if (!files.length) {
    sdkPath = sdk ?? defaultSdkPath(env);
    if (sdkPath) for (const dir of onlySelected ? [sdkPath] : sdkFamily(sdkPath)) files.push(...findInterfaces(dir, frameworks));
    if (!files.length) sdkWhy = sdkPath ? `no ${frameworks ? frameworks.join("/") : "framework"} .swiftinterface under ${sdkPath}` : "no macOS SDK found (xcrun failed)";
  }

  let derived = [];
  let reexports = {};
  if (files.length) {
    const inputs = [];
    for (const f of files) {
      try {
        const text = readFileSync(f.file, "utf8");
        inputs.push({ text, framework: f.framework ?? interfaceModuleName(text, f.file) });
      } catch (e) {
        io.err(`swift-macros: cannot read ${f.file}: ${e.message}`);
        return 2;
      }
    }
    const all = deriveMacros(inputs);
    if (!all.length) {
      io.err(`swift-macros: the interface(s) declare no macros (${files.length} file(s)). Either the SDK stopped using macros (then delete this check) or the parser no longer understands the format; refusing to pass vacuously`);
      return 2;
    }
    derived = bannedOnly(all);
    reexports = reexportMap(inputs);
  } else if (known.length && !writeKnown) {
    io.out(`swift-macros: ${sdkWhy}; checking against the committed snapshot ${KNOWN_FILE} only`);
  } else if (allowMissing && !inspect) {
    io.out(`swift-macros: SKIPPED (${sdkWhy}); --allow-missing-sdk`);
    return 0;
  } else {
    io.err(`swift-macros: ${sdkWhy}; cannot derive the banned macro list, so the check would pass vacuously. Install Xcode or the Command Line Tools, or pass --sdk/--interface (--allow-missing-sdk to skip on a machine without the SDK)`);
    return 2;
  }

  const macros = mergeMacros(derived, known);
  if (writeKnown) {
    const sdkVersion = (() => {
      try { return execFileSync("xcrun", ["--sdk", "macosx", "--show-sdk-version"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "unknown"; }
    })();
    const header = [
      `# ${KNOWN_FILE}: SDK macros whose compiler plugin is not shipped with the Command Line Tools, so they must not be`,
      `# used in macos/ (macos/README.md). Generated by \`node scripts/swift-macros.mjs --write-known\` (macOS SDK ${interfaces.length ? "(given interface)" : sdkVersion},`,
      `# ${frameworks ? frameworks.join(" + ") : "every framework and usr/lib/swift module"}), merged with the previous contents.`,
      "# scripts/swift-macros.mjs always unions this snapshot with the macros the installed SDKs declare, so a machine or CI runner",
      "# with an older SDK (where @State is still a property wrapper) bans the same names as one with a newer SDK.",
      "# Format: name<TAB>roles<TAB>plugin module<TAB>declaring frameworks. Keep it sorted; regenerate after installing a newer Xcode.",
    ];
    mkdirSync(dirname(knownPath), { recursive: true });
    writeFileSync(knownPath, [...header, ...formatMacros(macros)].join("\n") + "\n");
    io.out(`swift-macros: wrote ${macros.length} macro(s) to ${KNOWN_FILE}`);
    return 0;
  }
  if (list) {
    for (const line of formatMacros(macros)) io.out(line);
    return 0;
  }

  const findings = [];
  for (const rel of swiftFiles) {
    const text = readText(root, rel);
    if (text === null) continue;
    for (const u of findMacroUses(text, macros, reexports)) findings.push({ rel, ...u });
  }
  for (const f of findings) {
    io.err(`${f.rel}:${f.line}: [sdk-macro] ${f.sigil}${f.name} is an SDK macro${f.module ? ` (plugin module ${f.module}, shipped with Xcode only)` : ""}: a Command Line Tools-only build fails with "plugin for module not found"`);
  }
  io.out(`swift-macros: ${swiftFiles.length} Swift file(s) checked against ${macros.length} banned macro name(s) (SDK-derived${known.length ? ` + ${KNOWN_FILE}` : ""}), ${findings.length} use(s) found`);
  return findings.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) process.exitCode = main(process.argv.slice(2));
