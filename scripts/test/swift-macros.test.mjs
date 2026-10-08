import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bannedOnly, CLT_PLUGIN_MODULES, defaultSdkPath, deriveMacros, findInterfaces, findMacroUses, formatMacros, interfaceModuleName, main,
  mergeMacros, parseKnown, parseMacros, reexportMap, sdkFamily, sdkMacros, visibleModules,
} from "../swift-macros.mjs";
import { makeTree, REPO_ROOT, runMain, runNode, SCRIPTS_DIR } from "./helpers.mjs";

// A small .swiftinterface with the same declaration shapes as the real macOS 27 SwiftUI / SwiftUICore interfaces.
const INTERFACE = `// swift-interface-format-version: 1.0
// swift-module-flags: -module-name SwiftUI
import Swift
@available(iOS 17.0, macOS 14.0, tvOS 17.0, watchOS 10.0, *)
@freestanding(declaration) public macro Preview(_ name: Swift.String? = nil, @SwiftUICore.ContentBuilder body: @escaping @_Concurrency.MainActor () -> any SwiftUICore.View) = #externalMacro(module: "PreviewsMacros", type: "SwiftUIView")
@available(iOS 26.0, macOS 27.0, tvOS 26.0, watchOS 26.0, visionOS 26.0, *)
@freestanding(declaration) public macro Preview<T>(_ name: Swift.String? = nil, arguments: [T], @SwiftUICore.ContentBuilder body: @escaping (T) -> any SwiftUICore.View) = #externalMacro(module: "PreviewsMacros", type: "SwiftUIViewGroup_1")
@attached(peer) public macro Previewable() = #externalMacro(
    module: "PreviewsMacros", type: "PreviewableMacro"
)
@attached(accessor) @attached(peer, names: prefixed(__Key_)) public macro Entry() = #externalMacro(
    module: "SwiftUIMacros", type: "EntryMacro"
)
@attached(accessor, names: named(init), named(get), named(set)) @attached(peer, names: prefixed(\`_\`), prefixed(__), prefixed(\`$\`)) public macro State() = #externalMacro(
    module: "SwiftUIMacros", type: "StateMacro"
)
@attached(accessor, names: named(init), named(get), named(set)) @attached(peer, names: prefixed(\`_\`), prefixed(__), prefixed(\`$\`)) public macro State<Value>(initialValue: Value) = #externalMacro(
    module: "SwiftUIMacros", type: "StateMacro"
)
@available(macOS 14.0, *)
@attached(member, names: named(x))
public macro Split()
  = #externalMacro(module: "OtherMacros", type: "SplitMacro")
@freestanding(expression) public macro _SwiftUIEntryTypeCheck<T>(_ type: T.Type) -> Swift::Void = #externalMacro(
    module: "SwiftUIMacros", type: "EntryTypeCheckMacro"
)
// a comment that mentions macro Fake(x) is not a declaration
public struct S { public func macroLike() {} }
public func macro(_ x: Int) {}
let text = "macro InString()"
public struct StateObject {}
`;

const swift = (body) => `import SwiftUI\n${body}\n`;

test("parseMacros: names, roles, plugin modules; overloads merge; comments, strings and functions are not macros", () => {
  const macros = parseMacros(INTERFACE);
  const byName = Object.fromEntries(macros.map((m) => [m.name, m]));
  assert.deepEqual(Object.keys(byName).sort(), ["Entry", "Preview", "Previewable", "Split", "State", "_SwiftUIEntryTypeCheck"]);
  assert.deepEqual(byName.Preview.roles, ["freestanding"]);
  assert.equal(byName.Preview.module, "PreviewsMacros");
  assert.deepEqual(byName.Entry.roles, ["attached"]);
  assert.deepEqual(byName.State.roles, ["attached"]);
  assert.equal(byName.State.module, "SwiftUIMacros");
  assert.deepEqual(byName.Split.roles, ["attached"], "attributes on the lines above are read");
  assert.equal(byName.Split.module, "OtherMacros", "the module is found on the continuation line");
  assert.deepEqual(byName._SwiftUIEntryTypeCheck.roles, ["freestanding"]);
  assert.ok(!("Fake" in byName) && !("InString" in byName) && !("macro" in byName));
});

test("deriveMacros: union over several interfaces, sorted", () => {
  const a = "@attached(accessor) public macro Zed() = #externalMacro(module: \"M\", type: \"Z\")\n";
  const b = "@attached(peer) public macro Alpha() = #externalMacro(module: \"M\", type: \"A\")\n@freestanding(declaration) public macro Zed() = #externalMacro(module: \"M\", type: \"Z\")\n";
  const got = deriveMacros([a, b]);
  assert.deepEqual(got.map((m) => m.name), ["Alpha", "Zed"]);
  assert.deepEqual(got[1].roles, ["attached", "freestanding"]);
});

test("findMacroUses: whole-word, code only, right sigil", () => {
  const macros = parseMacros(INTERFACE);
  const uses = (body) => findMacroUses(swift(body), macros).map((u) => `${u.sigil}${u.name}@${u.line}`);
  assert.deepEqual(uses("struct V { @State private var n = 0 }"), ["@State@2"]);
  assert.deepEqual(uses("struct V { @State var a = 0; @State var b = 1 }"), ["@State@2", "@State@2"]);
  assert.deepEqual(uses("struct V { @SwiftUI.State var a = 0 }"), ["@State@2"], "module-qualified");
  assert.deepEqual(uses("#Preview { V() }"), ["#Preview@2"]);
  assert.deepEqual(uses("extension EnvironmentValues { @Entry var x = 1 }"), ["@Entry@2"]);
  assert.deepEqual(uses("struct V { @Previewable @State var z = 0 }"), ["@Previewable@2", "@State@2"]);
  // not uses:
  assert.deepEqual(uses("struct V { @StateObject var m = M(); @Binding var b: Int; @Environment(\\.x) var x }"), [], "@StateObject is a property wrapper, not the State macro");
  assert.deepEqual(uses('// @State in a comment\n/* #Preview */\nlet s = "@State and #Preview and @Entry"'), []);
  assert.deepEqual(uses('let s = """\n  @State\n  """\nlet r = #"@Entry"#'), []);
  assert.deepEqual(uses("@Preview struct V {}"), [], "@Preview: Preview is freestanding, so only #Preview counts");
  assert.deepEqual(uses("#State"), [], "#State: State is attached, so only @State counts");
  assert.deepEqual(uses("@Observable final class M {}\nstruct V { @Bindable var m: M }"), [], "Observation macros are not in the SwiftUI interface");
  assert.deepEqual(uses("let _SwiftUIEntryTypeCheckLike = 1; let State = 2; var Preview = 3"), [], "plain identifiers");
});

test("findInterfaces: one file per framework, arch preference, private interfaces ignored", () => {
  const t = makeTree({
    "System/Library/Frameworks/SwiftUI.framework/Modules/SwiftUI.swiftmodule/x86_64-apple-macos.swiftinterface": "x",
    "System/Library/Frameworks/SwiftUI.framework/Modules/SwiftUI.swiftmodule/arm64e-apple-macos.swiftinterface": "x",
    "System/Library/Frameworks/SwiftUI.framework/Modules/SwiftUI.swiftmodule/arm64e-apple-macos.private.swiftinterface": "x",
    "System/Library/Frameworks/SwiftUICore.framework/Modules/SwiftUICore.swiftmodule/x86_64-apple-macos.swiftinterface": "x",
    "System/Library/Frameworks/SwiftUICore.framework/Modules/SwiftUICore.swiftmodule/arm64e-apple-ios-macabi.swiftinterface": "x",
  });
  try {
    const found = findInterfaces(t.root, ["SwiftUI", "SwiftUICore"]);
    assert.deepEqual(findInterfaces(t.root).map((f) => f.framework), ["SwiftUI", "SwiftUICore"], "default: every framework");
    assert.deepEqual(found.map((f) => [f.framework, f.file.slice(f.file.lastIndexOf("/") + 1)]), [
      ["SwiftUI", "arm64e-apple-macos.swiftinterface"],
      ["SwiftUICore", "x86_64-apple-macos.swiftinterface"],
    ]);
    assert.deepEqual(findInterfaces(t.root, ["Nope"]), []);
  } finally {
    t.cleanup();
  }
});

test("sdkFamily + CLI: macros declared by ANY installed SDK are banned unless --only-selected-sdk", () => {
  const iface = (sdk, fw, text) => [`${sdk}/System/Library/Frameworks/${fw}.framework/Modules/${fw}.swiftmodule/arm64e-apple-macos.swiftinterface`, text];
  const sdk26 = ["@freestanding(declaration) public macro Preview() = #externalMacro(module: \"PreviewsMacros\", type: \"P\")\n"];
  const sdk27 = [sdk26[0] + "@attached(accessor) public macro State() = #externalMacro(module: \"SwiftUIMacros\", type: \"S\")\n"];
  const t = makeTree({
    ...Object.fromEntries([iface("SDKs/MacOSX26.sdk", "SwiftUI", sdk26[0]), iface("SDKs/MacOSX27.sdk", "SwiftUI", sdk27[0])]),
    "macos/A.swift": swift("@State var a = 0"),
  });
  try {
    symlinkSync("MacOSX27.sdk", join(t.root, "SDKs", "MacOSX.sdk"));
    const sdks = sdkFamily(join(t.root, "SDKs", "MacOSX26.sdk"));
    assert.equal(sdks.length, 2, "the MacOSX.sdk symlink and MacOSX27.sdk are one SDK");
    assert.ok(sdks[0].endsWith("MacOSX26.sdk"), "the selected SDK comes first");
    const union = runMain(main, ["--root", t.root, "--sdk", join(t.root, "SDKs", "MacOSX26.sdk")]);
    assert.equal(union.code, 1, "State is a macro in the 27 SDK, so it is banned even though the selected 26 SDK does not declare it");
    assert.match(union.err, /macos\/A\.swift:2: \[sdk-macro\] @State/);
    const only = runMain(main, ["--root", t.root, "--sdk", join(t.root, "SDKs", "MacOSX26.sdk"), "--only-selected-sdk"]);
    assert.equal(only.code, 0, only.err);
  } finally {
    t.cleanup();
  }
});

test("committed snapshot (scripts/swift-macros.known): unioned with the SDK list, used alone without an SDK, written by --write-known", () => {
  const known = "# comment\n\nState\tattached\tSwiftUIMacros\nZapper\tfreestanding\tOtherMacros\n";
  const onlyPreview = "@freestanding(declaration) public macro Preview() = #externalMacro(module: \"PreviewsMacros\", type: \"P\")\n";
  const t = makeTree({
    "old.swiftinterface": onlyPreview,
    "scripts/swift-macros.known": known,
    "macos/A.swift": swift("struct A { @State var a = 0 }\nlet z = #Zapper(1)"),
  });
  try {
    const args = ["--root", t.root, "--interface", join(t.root, "old.swiftinterface")];
    const union = runMain(main, args);
    assert.equal(union.code, 1, "the older SDK does not declare State, the snapshot does");
    assert.match(union.err, /A\.swift:2: \[sdk-macro\] @State/);
    assert.match(union.err, /A\.swift:3: \[sdk-macro\] #Zapper/);
    assert.match(union.out, /3 banned macro name\(s\) \(SDK-derived \+ scripts\/swift-macros\.known\)/);
    assert.deepEqual(runMain(main, [...args, "--list"]).out.split("\n"), ["Preview\tfreestanding\tPreviewsMacros", "State\tattached\tSwiftUIMacros", "Zapper\tfreestanding\tOtherMacros"]);

    // No SDK at all (a Linux runner): the snapshot alone is enforced, loudly, instead of skipping.
    const noSdk = runMain(main, ["--root", t.root, "--sdk", join(t.root, "nowhere"), "--allow-missing-sdk"]);
    assert.equal(noSdk.code, 1);
    assert.match(noSdk.out, /checking against the committed snapshot scripts\/swift-macros\.known only/);

    // --write-known merges what the SDK declares with what is already recorded, and the result parses back.
    const written = runMain(main, [...args, "--write-known"]);
    assert.equal(written.code, 0, written.err);
    const text = readFileSync(join(t.root, "scripts", "swift-macros.known"), "utf8");
    assert.match(text, /^# scripts\/swift-macros\.known/);
    assert.deepEqual(parseKnown(text).map((m) => m.name), ["Preview", "State", "Zapper"]);

    // malformed snapshot: usage error
    writeFileSync(join(t.root, "scripts", "swift-macros.known"), "State attached\n");
    assert.equal(runMain(main, args).code, 2);
  } finally {
    t.cleanup();
  }
});

test("parseKnown / formatMacros / mergeMacros round-trip", () => {
  const a = [{ name: "B", roles: ["attached"], module: "M" }, { name: "A", roles: [], module: null }];
  const text = formatMacros(mergeMacros(a)).join("\n");
  assert.equal(text, "A\tunknown\t-\nB\tattached\tM");
  assert.deepEqual(parseKnown(text), [{ name: "A", roles: [], module: null, frameworks: [] }, { name: "B", roles: ["attached"], module: "M", frameworks: [] }]);
  assert.deepEqual(mergeMacros([{ name: "X", roles: ["attached"], module: null }], [{ name: "X", roles: ["freestanding"], module: "M" }]), [{ name: "X", roles: ["attached", "freestanding"], module: "M", frameworks: [] }]);
  // the optional fourth column: declaring frameworks
  const withFw = formatMacros([{ name: "Model", roles: ["attached"], module: "SwiftDataMacros", frameworks: ["SwiftData"] }]);
  assert.deepEqual(withFw, ["Model\tattached\tSwiftDataMacros\tSwiftData"]);
  assert.deepEqual(parseKnown(withFw[0])[0].frameworks, ["SwiftData"]);
  assert.throws(() => parseKnown("A\tattached\tM\tnot a framework"), /expected/);
  assert.throws(() => parseKnown("Bad Name\tattached\tM"), /expected/);
  assert.throws(() => parseKnown("A\tweird\tM"), /expected/);
});

function repo(files) {
  const t = makeTree({ "fixture.swiftinterface": INTERFACE, ...files });
  return { ...t, args: ["--root", t.root, "--interface", join(t.root, "fixture.swiftinterface")] };
}

test("CLI: a clean macos/ passes, a banned macro fails with file:line, reference/ is ignored, Tests/ is not", () => {
  const t = repo({
    "macos/Sources/App/A.swift": swift("struct A: View { @StateObject var m = M(); var body: some View { Text(\"@State\") } }"),
    "macos/reference/spike/B.swift": swift("struct B: View { @State var n = 0 }"),
    "macos/.build/x/C.swift": swift("@State var c = 0"),
  });
  try {
    const clean = runMain(main, t.args);
    assert.equal(clean.code, 0, clean.err);
    assert.match(clean.out, /1 Swift file\(s\) checked against 6 banned macro name\(s\) \(SDK-derived\), 0 use\(s\) found/);

    writeFileSync(join(t.root, "macos/Sources/App/D.swift"), swift("struct D: View {\n  @State private var open = false\n}\n#Preview { D() }"));
    mkdirSync(join(t.root, "macos/Tests/AppTests"), { recursive: true });
    writeFileSync(join(t.root, "macos/Tests/AppTests/E.swift"), swift("@Entry var e = 1"));
    const bad = runMain(main, t.args);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /macos\/Sources\/App\/D\.swift:3: \[sdk-macro\] @State is an SDK macro \(plugin module SwiftUIMacros/);
    assert.match(bad.err, /macos\/Sources\/App\/D\.swift:5: \[sdk-macro\] #Preview/);
    assert.match(bad.err, /macos\/Tests\/AppTests\/E\.swift:2: \[sdk-macro\] @Entry/);
    assert.ok(!bad.err.includes("reference") && !bad.err.includes(".build"));
    assert.match(bad.out, /3 use\(s\) found/);
  } finally {
    t.cleanup();
  }
});

test("CLI: no Swift sources is a skip (exit 0); other directories can be named", () => {
  const t = repo({ "docs/readme.md": "x\n" });
  try {
    const r = runMain(main, t.args);
    assert.equal(r.code, 0);
    assert.match(r.out, /SKIPPED \(no Swift sources under macos\)/);
    mkdirSync(join(t.root, "app"), { recursive: true });
    writeFileSync(join(t.root, "app/A.swift"), swift("@State var a = 0"));
    assert.equal(runMain(main, [...t.args, "app"]).code, 1);
    assert.equal(runMain(main, t.args).code, 0, "the default directory is still macos/");
  } finally {
    t.cleanup();
  }
});

test("CLI: no usable interface is an error, never a silent pass; --allow-missing-sdk downgrades it to a skip", () => {
  const t = makeTree({ "macos/A.swift": swift("@State var a = 0"), "empty-sdk/readme": "x" });
  try {
    const noSdkDir = runMain(main, ["--root", t.root, "--sdk", join(t.root, "empty-sdk")]);
    assert.equal(noSdkDir.code, 2);
    assert.match(noSdkDir.err, /would pass vacuously/);
    const allowed = runMain(main, ["--root", t.root, "--sdk", join(t.root, "empty-sdk"), "--allow-missing-sdk"]);
    assert.equal(allowed.code, 0);
    assert.match(allowed.out, /SKIPPED .*--allow-missing-sdk/);

    writeFileSync(join(t.root, "zero.swiftinterface"), "// swift-interface-format-version: 1.0\npublic struct X {}\n");
    const zero = runMain(main, ["--root", t.root, "--interface", join(t.root, "zero.swiftinterface")]);
    assert.equal(zero.code, 2, "an interface with no macros means the parser or the SDK changed");
    assert.match(zero.err, /declare no macros/);

    assert.equal(runMain(main, ["--root", t.root, "--interface", join(t.root, "missing.swiftinterface")]).code, 2);
    assert.equal(runMain(main, ["--bogus"]).code, 2);
  } finally {
    t.cleanup();
  }
});

test("CLI: --list prints name, role and module without needing Swift sources", () => {
  const t = repo({});
  try {
    const r = runMain(main, [...t.args, "--list"]);
    assert.equal(r.code, 0);
    const lines = r.out.split("\n");
    assert.ok(lines.includes("State\tattached\tSwiftUIMacros\tSwiftUI"), "the fourth column names the declaring framework (-module-name)");
    assert.ok(lines.includes("Preview\tfreestanding\tPreviewsMacros\tSwiftUI"));
    assert.equal(lines.length, 6);
  } finally {
    t.cleanup();
  }
});

test("CLI process: exit code 1 and stderr format when run as a script", () => {
  const t = repo({ "macos/A.swift": swift("@State var a = 0") });
  try {
    const r = runNode(join(SCRIPTS_DIR, "swift-macros.mjs"), t.args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /macos\/A\.swift:2: \[sdk-macro\] @State/);
  } finally {
    t.cleanup();
  }
});

// Integration against the SDK actually installed on this machine. Skipped where there is none (Linux CI, no Xcode).
const sdk = process.platform === "darwin" ? defaultSdkPath() : null;
const sdkVersion = sdk ? spawnSync("xcrun", ["--sdk", "macosx", "--show-sdk-version"], { encoding: "utf8" }).stdout.trim() : "";
const interfaces = sdk ? findInterfaces(sdk, ["SwiftUI"]) : [];

test("real SDK: the derived list contains Preview (and State on SDK 27+, where the spike found it is a macro)", { skip: interfaces.length === 0 && "no macOS SDK with SwiftUI interfaces on this machine" }, () => {
  const names = new Map();
  const r = runMain(main, ["--list"]);
  assert.equal(r.code, 0, r.err);
  for (const line of r.out.split("\n")) {
    const [name, role, mod] = line.split("\t");
    names.set(name, { role, mod });
  }
  assert.ok(names.size >= 2, `expected a handful of macros, got ${names.size}`);
  assert.equal(names.get("Preview")?.role, "freestanding");
  if (Number.parseFloat(sdkVersion) >= 27) {
    assert.equal(names.get("State")?.role, "attached");
    assert.equal(names.get("State")?.mod, "SwiftUIMacros");
    assert.ok(names.has("Entry"));
  }
  assert.ok(![...names.keys()].includes("Observable"), "Observation macros are not SwiftUI's and must not be banned");
});

test("real SDK: scripts/swift-macros.known is not behind the installed SDKs", { skip: interfaces.length === 0 && "no macOS SDK with SwiftUI interfaces on this machine" }, () => {
  const derived = sdkMacros(sdkFamily(sdk)).macros.map((m) => m.name);
  const known = new Set(parseKnown(readFileSync(join(REPO_ROOT, "scripts", "swift-macros.known"), "utf8")).map((m) => m.name));
  const missing = derived.filter((n) => !known.has(n));
  assert.deepEqual(missing, [], "an installed SDK declares macros the committed snapshot lacks: run `node scripts/swift-macros.mjs --write-known` and commit scripts/swift-macros.known");
});

// ---------------------------------------------------------------------------------------------------------------
// Review #7: ban by plugin module, not by framework
// ---------------------------------------------------------------------------------------------------------------

const iface = (module, body) => `// swift-interface-format-version: 1.0\n// swift-module-flags: -target arm64e-apple-macos27.0 -module-name ${module}\n${body}`;
const FOUNDATION = iface("Foundation", `@_exported import Foundation
@_exported import Observation
@freestanding(expression) public macro Predicate<each Input>(_ body: (repeat each Input) -> Swift.Bool) -> Foundation.Predicate<repeat each Input> = #externalMacro(module: "FoundationMacros", type: "PredicateMacro")
`);
const OBSERVATION = iface("Observation", `@attached(member, names: named(_$observationRegistrar)) public macro Observable() = #externalMacro(module: "ObservationMacros", type: "ObservableMacro")
`);
const SWIFT = iface("Swift", `@freestanding(expression) public macro line<T: Swift.ExpressibleByIntegerLiteral>() -> T = Builtin.LineMacro
@attached(member) public macro DebugDescription() = #externalMacro(module: "SwiftMacros", type: "DebugDescriptionMacro")
`);
const SWIFTDATA = iface("SwiftData", `@attached(member) @attached(extension, conformances: SwiftData.PersistentModel) public macro Model() = #externalMacro(module: "SwiftDataMacros", type: "PersistentModelMacro")
`);
const TIPKIT = iface("TipKit", `@_exported import SwiftUI
@freestanding(declaration) public macro Rule<T>(_ x: T) = #externalMacro(module: "TipKitMacros", type: "RuleMacro")
@attached(accessor) public macro Parameter() = #externalMacro(module: "TipKitMacros", type: "ParameterMacro")
`);
const HUB = iface("DataHub", "@_exported import SwiftData\npublic struct Hub {}\n"); // re-exports SwiftData

function sdkTree(files = {}) {
  const fw = (name, text) => [`SDK/System/Library/Frameworks/${name}.framework/Modules/${name}.swiftmodule/arm64e-apple-macos.swiftinterface`, text];
  const lib = (name, text) => [`SDK/usr/lib/swift/${name}.swiftmodule/arm64e-apple-macos.swiftinterface`, text];
  return makeTree({
    ...Object.fromEntries([
      fw("SwiftUI", INTERFACE), fw("Foundation", FOUNDATION), fw("SwiftData", SWIFTDATA), fw("TipKit", TIPKIT), fw("DataHub", HUB),
      lib("Observation", OBSERVATION), lib("Swift", SWIFT),
    ]),
    ...files,
  });
}

test("review #7: every framework and usr/lib/swift module is read; only plugins the CLT lacks are banned", () => {
  assert.deepEqual([...CLT_PLUGIN_MODULES].sort(), ["ObservationMacros", "SwiftMacros", "TestingMacros"]);
  const t = sdkTree();
  try {
    const { macros, reexports } = sdkMacros([join(t.root, "SDK")]);
    const names = macros.map((m) => m.name);
    for (const banned of ["Predicate", "Model", "Rule", "Parameter", "State", "Preview"]) assert.ok(names.includes(banned), banned);
    for (const fine of ["Observable", "DebugDescription", "line"]) assert.ok(!names.includes(fine), `${fine}: its plugin ships with the CLT (or it is a built-in)`);
    assert.deepEqual(macros.find((m) => m.name === "Model").frameworks, ["SwiftData"]);
    assert.deepEqual(reexports.TipKit, ["SwiftUI"]);
    assert.equal(interfaceModuleName(SWIFTDATA), "SwiftData");
    assert.deepEqual(bannedOnly([{ name: "X", roles: [], module: null }]), [], "a built-in has no plugin module");
  } finally {
    t.cleanup();
  }
});

test("review #7: #Predicate (FoundationMacros) is banned in any file; @Observable is not", () => {
  const t = sdkTree({
    "macos/Sources/A.swift": "import Foundation\nlet p = #Predicate<Int> { $0 > 1 }\n",
    "macos/Sources/B.swift": "import Observation\n@Observable final class M {}\n",
    "macos/Sources/C.swift": "import AppKit\nlet q = #Predicate<Int> { $0 > 2 }\n", // AppKit re-exports Foundation via Clang: ambient
  });
  try {
    const r = runMain(main, ["--root", t.root, "--sdk", join(t.root, "SDK"), "--only-selected-sdk"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /A\.swift:2: \[sdk-macro\] #Predicate is an SDK macro \(plugin module FoundationMacros/);
    assert.match(r.err, /C\.swift:2: \[sdk-macro\] #Predicate/);
    assert.ok(!r.err.includes("B.swift"));
  } finally {
    t.cleanup();
  }
});

test("review #7: common names from non-ambient frameworks count only where the framework is imported (directly or re-exported)", () => {
  const t = sdkTree({
    "macos/Sources/Own.swift": "import SwiftUI\n@propertyWrapper struct Parameter<T> { var wrappedValue: T }\nstruct V { @Parameter var x = 1 }\nfinal class Model {}\n",
    "macos/Sources/Data.swift": "import SwiftData\n@Model final class Item { var n = 0 }\n",
    "macos/Sources/Hub.swift": "import DataHub\n@Model final class Other {}\n",
    "macos/Sources/Tips.swift": "import TipKit\nstruct T: Tip { #Rule(x) }\n",
  });
  try {
    const r = runMain(main, ["--root", t.root, "--sdk", join(t.root, "SDK"), "--only-selected-sdk"]);
    assert.equal(r.code, 1);
    assert.ok(!r.err.includes("Own.swift"), "the app's own @Parameter wrapper is not TipKit's macro");
    assert.match(r.err, /Data\.swift:2: \[sdk-macro\] @Model .*SwiftDataMacros/);
    assert.match(r.err, /Hub\.swift:2: \[sdk-macro\] @Model/, "visible through @_exported import SwiftData");
    assert.match(r.err, /Tips\.swift:2: \[sdk-macro\] #Rule .*TipKitMacros/);
    assert.deepEqual([...visibleModules("import TipKit\n", reexportMap([{ framework: "TipKit", text: TIPKIT }]))].sort(), ["SwiftUI", "TipKit"]);
  } finally {
    t.cleanup();
  }
});

test("review #7 / #19: options that need a value refuse to run without one", () => {
  for (const flag of ["--root", "--sdk", "--interface", "--frameworks"]) {
    const r = runMain(main, [flag]);
    assert.equal(r.code, 2, flag);
    assert.match(r.err, /needs a value/);
  }
});
