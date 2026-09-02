#!/usr/bin/env node
// Build a store-ready zip of the extension: dist/<slug>-<version>.zip
// Run: node build.js
//
// Zero dependencies (node: only). Steps, in order:
//   1. syntax-check every shipped .js file (node --check);
//   2. run the test suite — a failing test fails the build;
//   3. validate manifest.json and every file it references;
//   4. generate placeholder icons if any referenced icon is missing;
//   5. zip the runtime files with a built-in writer (no system `zip` needed).
//
// The zip contains only what Chrome needs to load the extension: manifest,
// source files, icons. Dev artifacts (test/, build.js, make-icons.js, README)
// are left out.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");

function fail(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

function run(cmd, args, label) {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    fail(`${label} failed (exit ${result.status})`);
  }
}

// --- 1. Syntax-check the shipped sources ---------------------------------

const RUNTIME_FILES = [
  "manifest.json",
  "background.js",
  "config.js",
  "popup.html",
  "popup.css",
  "popup.js",
];

for (const file of RUNTIME_FILES.filter((f) => f.endsWith(".js"))) {
  run(process.execPath, ["--check", file], `node --check ${file}`);
}
console.log("syntax ok");

// --- 2. Tests -------------------------------------------------------------

run(process.execPath, ["test/pac.test.mjs"], "tests");
console.log("tests ok");

// --- 3. Manifest validation ----------------------------------------------

const manifestPath = join(ROOT, "manifest.json");
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`manifest.json is not valid JSON: ${error.message}`);
}
if (!manifest.version) {
  fail("manifest.json has no version");
}

const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons ?? {}),
].filter((file) => typeof file === "string");

for (const file of referenced) {
  if (!existsSync(join(ROOT, file))) {
    fail(`manifest references a missing file: ${file}`);
  }
}

// The full zip payload: runtime files plus everything the manifest points to
// (deduped). config.js is pulled in by background.js/popup.js imports.
const payload = [...new Set([...RUNTIME_FILES, ...referenced])];

// --- 4. Icons -------------------------------------------------------------

const missingIcons = Object.values(manifest.icons ?? {}).filter(
  (file) => !existsSync(join(ROOT, file)),
);
if (missingIcons.length > 0) {
  console.log(`generating missing icons: ${missingIcons.join(", ")}`);
  run(process.execPath, ["make-icons.js"], "make-icons");
  for (const file of missingIcons) {
    if (!existsSync(join(ROOT, file))) {
      fail(`make-icons.js did not produce ${file}`);
    }
  }
}

// --- 5. Zip ---------------------------------------------------------------

// Minimal ZIP writer: local file headers + raw-deflate payloads, central
// directory, end-of-central-directory. Good enough for a store upload and
// avoids depending on the system `zip` binary.
let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day =
    Math.max(0, date.getFullYear() - 1980) << 9 |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, day };
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = readFileSync(join(ROOT, entry.name));
    const crc = crc32(data);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const { time, day } = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    chunks.push(local, name, compressed);

    central.push({ name, crc, compressed, rawSize: data.length, time, day, offset });
    offset += local.length + name.length + compressed.length;
  }

  const centralStart = offset;
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); // central directory signature
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed to extract
    header.writeUInt16LE(0, 8); // flags
    header.writeUInt16LE(8, 10); // method: deflate
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.day, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressed.length, 20);
    header.writeUInt32LE(entry.rawSize, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(0, 30); // extra field length
    header.writeUInt16LE(0, 32); // comment length
    header.writeUInt16LE(0, 34); // disk number start
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(0, 38); // external attributes
    header.writeUInt32LE(entry.offset, 42); // local header offset
    chunks.push(header, entry.name);
    offset += header.length + entry.name.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - centralStart, 12); // central directory size
  eocd.writeUInt32LE(centralStart, 16); // central directory offset
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

const slug =
  manifest.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "extension";

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const entries = payload.map((name) => ({
  name,
  mtime: statSync(join(ROOT, name)).mtime,
}));
const zip = buildZip(entries);
const zipPath = join(DIST, `${slug}-${manifest.version}.zip`);
writeFileSync(zipPath, zip);

const totalBytes = entries.reduce(
  (sum, entry) => sum + statSync(join(ROOT, entry.name)).size,
  0,
);
console.log(`\npackaged ${entries.length} files (${totalBytes} bytes)`);
console.log(`-> ${zipPath} (${zip.length} bytes)`);