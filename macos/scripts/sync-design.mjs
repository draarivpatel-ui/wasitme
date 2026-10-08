#!/usr/bin/env node
// Brings the design system (design/system/, read-only here) into the Swift package, so `swift build` needs no node:
//
//   design/system/generated/Tokens.swift -> Sources/WasitmeUI/Theme/Generated/Tokens.swift   (byte-for-byte copy)
//
// Tokens.swift carries everything the app draws with: the palette, type roles (with PostScript names), space, radii,
// strokes, sizes, chart constants, copy, chip edge styles, the finding and app states, and every 16/18 px glyph as
// vector primitives. It is written by design/system/gen/build.mjs; nothing is generated here any more (the old
// DesignExtras.swift moved upstream into the design generators).
//
// Usage: node macos/scripts/sync-design.mjs [--check]
//   --check  write nothing; exit 1 if the copy is missing or differs, or Generated/ holds any other file
//            (build-app.sh runs this).
// WasitmeUITests/DesignSyncTests re-reads design/system and fails on drift too, so a stale copy cannot pass `swift test`.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MACOS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = resolve(MACOS, '..', 'design', 'system');
const OUT = join(MACOS, 'Sources', 'WasitmeUI', 'Theme', 'Generated');
const check = process.argv.includes('--check');
const COPIES = ['Tokens.swift'];

let stale = 0;
for (const name of COPIES) {
  const text = readFileSync(join(DESIGN, 'generated', name), 'utf8');
  const file = join(OUT, name);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (current === text) continue;
  if (check) {
    console.error(`sync-design: ${name} is out of date with design/system (run: node macos/scripts/sync-design.mjs)`);
    stale++;
  } else {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(file, text);
    console.log(`sync-design: wrote Sources/WasitmeUI/Theme/Generated/${name}`);
  }
}
// Anything else in Generated/ is a leftover from an older sync (it would still compile and could shadow a token).
for (const name of existsSync(OUT) ? readdirSync(OUT) : []) {
  if (COPIES.includes(name)) continue;
  if (check) {
    console.error(`sync-design: Sources/WasitmeUI/Theme/Generated/${name} is not generated from design/system (run: node macos/scripts/sync-design.mjs)`);
    stale++;
  } else {
    rmSync(join(OUT, name));
    console.log(`sync-design: removed Sources/WasitmeUI/Theme/Generated/${name}`);
  }
}
if (stale) process.exit(1);
if (check) console.log('sync-design: generated files match design/system');
