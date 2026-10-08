import { test } from "node:test";
import assert from "node:assert/strict";
import { isTable, parseToml } from "../../src/extract/configsnap/toml.js";
import type { TomlTable } from "../../src/extract/configsnap/toml.js";

const ok = (src: string): TomlTable => {
  const r = parseToml(src);
  assert.equal(r.errors, 0, "expected a clean parse");
  return r.root;
};
const table = (v: unknown): TomlTable => {
  assert.ok(isTable(v), "expected a table");
  return v;
};

test("scalars: strings, booleans, numbers, dates", () => {
  const r = ok(`
model = "gpt-6-luna"   # trailing comment
lit = 'C:\\raw\\path'
yes = true
no = false
n = 1_000
neg = -5
f = 3.14
e = 1e3
hex = 0xFF
d = 1979-05-27T07:32:00Z
d2 = 1979-05-27 07:32:00
t = 07:32:00
`);
  assert.equal(r.model, "gpt-6-luna");
  assert.equal(r.lit, "C:\\raw\\path");
  assert.equal(r.yes, true);
  assert.equal(r.no, false);
  assert.equal(r.n, 1000);
  assert.equal(r.neg, -5);
  assert.equal(r.f, 3.14);
  assert.equal(r.e, 1000);
  assert.equal(r.hex, 255);
  assert.equal(r.d, "1979-05-27T07:32:00Z");
  assert.equal(r.d2, "1979-05-27 07:32:00");
  assert.equal(r.t, "07:32:00");
});

test("string escapes and multi-line strings", () => {
  const r = ok(`
a = "tab\\there \\u00e9 \\"q\\" \\\\"
b = """
first
second \\
   joined"""
c = '''
raw \\n stays'''
d = """quote "" inside"""
`);
  assert.equal(r.a, 'tab\there é "q" \\');
  assert.equal(r.b, "first\nsecond joined");
  assert.equal(r.c, "raw \\n stays");
  assert.equal(r.d, 'quote "" inside');
});

test("TOML 1.1 escapes (\\e, \\xHH) are accepted; invalid ones are not", () => {
  const r = ok('a = "\\e[0m\\x41"\n');
  assert.equal(r.a, "\u001b[0mA");
  assert.ok(parseToml('a = "\\x4"\n').errors > 0);
  assert.ok(parseToml('a = "\\ud800"\n').errors > 0, "lone surrogate escape");
});

test("a header-looking line inside a multi-line string is string content, not a table", () => {
  const r = ok(`
note = """
[mcp_servers.injected]
command = "x"
"""
[mcp_servers.real]
command = "y"
`);
  assert.deepEqual(Object.keys(table(r.mcp_servers)), ["real"]);
  assert.equal(typeof r.note, "string");
});

test("tables, dotted and quoted keys, implicit then explicit tables", () => {
  const r = ok(`
[mcp_servers."my server".env]
KEY = "v"
[mcp_servers."my server"]
command = "c"
[plugins."x@y"]
enabled = true
[a.b.c]
k = 1
`);
  const servers = table(r.mcp_servers);
  assert.deepEqual(Object.keys(servers), ["my server"]);
  const s = table(servers["my server"]);
  assert.equal(s.command, "c");
  assert.equal(table(s.env).KEY, "v");
  assert.equal(table(table(r.plugins)["x@y"]).enabled, true);
  assert.equal(table(table(table(r.a).b).c).k, 1);
});

test("dotted keys at top level and inside tables", () => {
  const r = ok(`
mcp_servers.alpha.command = "a"
[profiles.fast]
model = "m"
sandbox.mode = "ro"
`);
  assert.equal(table(table(r.mcp_servers).alpha).command, "a");
  assert.equal(table(table(r.profiles).fast).model, "m");
});

test("arrays: multi-line, nested, trailing commas, comments, header-like rows", () => {
  const r = ok(`
notify = [
  "wasitme",   # a comment
  "ping",
]
grid = [
  [1, 2],
  [3, 4]
]
mixed = [ "a", 1, true, { k = "v" } ]
`);
  assert.deepEqual(r.notify, ["wasitme", "ping"]);
  assert.deepEqual(r.grid, [[1, 2], [3, 4]]);
  assert.ok(Array.isArray(r.mixed) && r.mixed.length === 4);
});

test("inline tables, including multi-line and nested", () => {
  const r = ok(`
[mcp_servers]
a = { command = "x", args = ["1", "2"], env = { K = "v" } }
b = {
  command = "y"
}
`);
  const servers = table(r.mcp_servers);
  assert.deepEqual(Object.keys(servers), ["a", "b"]);
  assert.equal(table(table(servers.a).env).K, "v");
});

test("arrays of tables", () => {
  const r = ok(`
[[skills.config]]
path = "a"
[[skills.config]]
path = "b"
`);
  const list = table(r.skills).config;
  assert.ok(Array.isArray(list));
  assert.equal(list.length, 2);
  assert.equal(table(list[1]).path, "b");
});

test("CRLF line endings and a UTF-8 BOM", () => {
  const r = ok("\uFEFFmodel = \"m\"\r\n[a]\r\nk = 1\r\n");
  assert.equal(r.model, "m");
  assert.equal(table(r.a).k, 1);
});

test("empty and comment-only input parse to an empty table", () => {
  assert.deepEqual(Object.keys(ok("")), []);
  assert.deepEqual(Object.keys(ok("# nothing\n\n   \n# more")), []);
});

test("malformed input is counted, not thrown, and never echoed", () => {
  const cases = [
    'model = "unterminated\nnext = 1',
    "model gpt-6",
    "model = gpt-6",
    "model = ",
    "[unclosed\nk = 1",
    "[a]\n[a]\n",
    "k = 1\nk = 2",
    '= "no key"',
    "arr = [1, 2",
    "t = { a = 1",
    'bad = "\\q"',
    "x = 1 trailing",
  ];
  for (const src of cases) {
    const r = parseToml(src);
    assert.ok(r.errors > 0, `expected errors for ${JSON.stringify(src)}`);
  }
});

test("good statements around a bad one are still read (errors>0 tells the caller not to trust the tree)", () => {
  const r = parseToml('a = 1\nbroken = \nb = 2\n');
  assert.equal(r.errors, 1);
  assert.equal(r.root.a, 1);
  assert.equal(r.root.b, 2);
});

test("unterminated multi-line string swallows the rest and is an error", () => {
  const r = parseToml('a = """never closed\nb = 1\n');
  assert.ok(r.errors > 0);
});

test("hostile: __proto__ / constructor keys cannot pollute or change behaviour", () => {
  const r = parseToml(`
[__proto__.polluted]
yes = true
[constructor.prototype]
polluted = true
`);
  assert.equal(r.errors, 0);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(r.root), null);
  assert.deepEqual(Object.keys(r.root).sort(), ["__proto__", "constructor"]);
  const r2 = parseToml(`__proto__ = "x"\n`);
  assert.equal(r2.errors, 0);
  assert.equal(r2.root["__proto__"], "x");
});

test("hostile: extreme nesting is rejected without blowing the stack", () => {
  const deep = "a = " + "[".repeat(50_000) + "]".repeat(50_000);
  const r = parseToml(deep);
  assert.ok(r.errors > 0);
  const deepInline = "a = " + "{ b = ".repeat(5000) + "1" + " }".repeat(5000);
  assert.ok(parseToml(deepInline).errors > 0);
});

test("hostile: a million bad lines terminate quickly with an error", () => {
  const t0 = Date.now();
  const r = parseToml("= x\n".repeat(200_000));
  assert.ok(r.errors > 0);
  assert.ok(Date.now() - t0 < 5000, "must not be quadratic");
});

test("values with # inside strings are not comments", () => {
  const r = ok(`a = "x # not a comment" # real comment\nb = 'y#z'\n`);
  assert.equal(r.a, "x # not a comment");
  assert.equal(r.b, "y#z");
});
