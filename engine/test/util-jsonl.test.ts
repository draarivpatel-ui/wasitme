/**
 * readJsonl (util.ts): byte-level "\n" splitting with one UTF-8 decode per line. Pinned: U+2028/U+2029 never split a
 * record; a multi-byte character across the 1 MiB read boundary survives; an oversized line counts as ONE bad line
 * however many chunks it spans, mid-file or as an unterminated tail; and the local-day formatter cache gives the same
 * days as a fresh formatter. Synthetic files in a temp folder only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDay, readJsonl } from "../src/util.js";

async function read(text: string | Buffer): Promise<{ records: Record<string, unknown>[]; badLines: number; truncatedTail: number }> {
  const dir = mkdtempSync(join(tmpdir(), "wasitme-jsonl-"));
  try {
    const p = join(dir, "s.jsonl");
    writeFileSync(p, text);
    const stats = { badLines: 0, truncatedTail: 0 };
    const records: Record<string, unknown>[] = [];
    for await (const r of readJsonl(p, stats)) records.push(r);
    return { records, ...stats };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readJsonl: an oversized line is ONE bad line, mid-file or as an unterminated tail (it spans many chunks)", async () => {
  // 45 MB: more than twice the 20 MB line limit, so an implementation that counts each crossing would count it twice.
  const big = `{"x":"${"a".repeat(45 * 1024 * 1024)}"}`;
  const mid = await read(`{"a":1}\n${big}\n{"b":2}\n`);
  assert.deepEqual([mid.records, mid.badLines, mid.truncatedTail], [[{ a: 1 }, { b: 2 }], 1, 0]);
  const tail = await read(`{"a":1}\n${big}`);
  assert.deepEqual([tail.records, tail.badLines, tail.truncatedTail], [[{ a: 1 }], 1, 0], "the skipped tail is not parsed as a record or a cut-off ending");
});

test("readJsonl: U+2028/U+2029 and multi-byte characters across the read boundary never split or garble a record", async () => {
  const pad = "b".repeat((1 << 20) - 9); // puts the two 3-byte characters across the first 1 MiB chunk boundary
  const r = await read(`{"t":"a b c"}\n{"p":"${pad}中中"}\n{"e":"é😀"}\n{"partial":`);
  assert.equal(r.records.length, 3);
  assert.equal(r.records[0]!.t, "a b c");
  assert.ok(String(r.records[1]!.p).endsWith("中中"));
  assert.equal(r.records[2]!.e, "é😀");
  assert.deepEqual([r.badLines, r.truncatedTail], [0, 1]);
});

test("readJsonl: CRLF, blank lines, non-objects and garbage are counted as before", async () => {
  const r = await read(`{"a":1}\r\n\r\n  \n[1]\nnull\n{bad\n{"z":2}`);
  assert.deepEqual([r.records, r.badLines, r.truncatedTail], [[{ a: 1 }, { z: 2 }], 3, 0]);
  assert.deepEqual((await read("")).records, []);
});

test("localDay: the cached formatter gives the same day as a fresh one, per zone, and still rejects an unknown zone", () => {
  for (const tz of ["UTC", "America/Chicago", "Asia/Kolkata", "Pacific/Kiritimati"]) {
    for (const iso of ["2026-03-08T07:59:59Z", "2026-11-01T05:30:00Z", "2026-12-31T23:59:59Z", "2027-01-01T00:00:00Z"]) {
      const fresh = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
      assert.equal(localDay(iso, tz), fresh, `${tz} ${iso}`);
      assert.equal(localDay(iso, tz), fresh, `${tz} ${iso} (cached)`);
    }
  }
  assert.throws(() => localDay("2026-01-01T00:00:00Z", "Mars/Olympus"), RangeError);
  assert.throws(() => localDay("2026-01-01T00:00:00Z", "Mars/Olympus"), RangeError, "a failed zone is not cached");
});
