#!/usr/bin/env node
// Snes9x save state (freeze) parser: extracts WRAM ($7E:0000-$7F:FFFF, 128KB)
// Usage:
//   node tools/snes9x_state_extract.mjs <state-file> [<output.bin>]
//   default output: <state-file>.wram.bin
//
// Snes9x state format: optionally gzipped. After ungzip:
//   "#!s9xsnp:NN\r\n"
//   then chunks of the form "NAM:LLLLLL:<LEN bytes>\n" (LLLLLL = 6-digit decimal length)
//   The chunk containing main WRAM is "RAM:" (size 0x20000 = 131072 bytes).
//
// Strategy: scan for "RAM:000000:" through "RAM:131072:" patterns by finding
// "RAM:" then reading the 6-digit length. We pick the chunk whose length is exactly 131072.

import { readFileSync, writeFileSync } from 'fs';
import zlib from 'zlib';

const argv = process.argv.slice(2);
if (argv.length < 1) {
  console.error('Usage: snes9x_state_extract.mjs <state-file> [<output.bin>]');
  process.exit(1);
}
const inPath = argv[0];
const outPath = argv[1] || (inPath + '.wram.bin');

let buf = readFileSync(inPath);

// Try gunzip (Snes9x compresses by default)
try {
  const ungz = zlib.gunzipSync(buf);
  buf = ungz;
  console.log(`Ungzipped: ${ungz.length} bytes`);
} catch (e) {
  console.log(`Not gzipped (or gunzip failed): using raw ${buf.length} bytes`);
}

// Header sanity
const head = buf.slice(0, 32).toString('ascii');
console.log('Header:', JSON.stringify(head.slice(0, head.indexOf('\n') >= 0 ? head.indexOf('\n') : 32)));

// Walk chunks
function findChunks(buf) {
  const chunks = [];
  let i = 0;
  // Skip header line
  const nl = buf.indexOf(0x0a);
  if (nl >= 0 && nl < 32) i = nl + 1;

  while (i < buf.length - 12) {
    // chunk header: NAM:LLLLLL: where NAM is 3-4 alpha chars, L is 6 digits
    // Look for ':' followed by 6 digits then ':'
    // Try parsing at i: 3 or 4 letters, ':', 6 digits, ':'
    let nameEnd = -1;
    for (let j = i; j < i + 8 && j < buf.length; j++) {
      if (buf[j] === 0x3a) { nameEnd = j; break; }
    }
    if (nameEnd < 0 || nameEnd - i < 2 || nameEnd - i > 6) break;
    // Check 6-digit length follows
    if (nameEnd + 7 >= buf.length || buf[nameEnd + 7] !== 0x3a) break;
    const lenStr = buf.slice(nameEnd + 1, nameEnd + 7).toString('ascii');
    if (!/^\d{6}$/.test(lenStr)) break;
    const name = buf.slice(i, nameEnd).toString('ascii');
    const len = parseInt(lenStr, 10);
    const dataStart = nameEnd + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > buf.length) {
      console.log(`Chunk ${name} len ${len} truncated`);
      break;
    }
    chunks.push({ name, len, start: dataStart, end: dataEnd });
    i = dataEnd;
  }
  return chunks;
}

const chunks = findChunks(buf);
console.log('Chunks found:');
for (const c of chunks) {
  console.log(`  ${c.name.padEnd(6)} len=${c.len}`);
}

// Pick RAM chunk (main WRAM): expect len == 131072
const ram = chunks.find(c => c.name === 'RAM' && c.len === 131072)
         || chunks.find(c => c.name === 'RAM');
if (!ram) {
  console.error('ERROR: no RAM chunk found');
  process.exit(2);
}
const wram = buf.slice(ram.start, ram.end);
writeFileSync(outPath, wram);
console.log(`WRAM written: ${outPath} (${wram.length} bytes)`);

// Also report a summary of key bytes
function rd(off) { return wram[off]; }
console.log('\nKey WRAM bytes (in saved state):');
console.log(`  $0117 = $${rd(0x0117).toString(16).padStart(2,'0')}`);
console.log(`  $0126 = $${rd(0x0126).toString(16).padStart(2,'0')}  (game state byte)`);
console.log(`  $0127 = $${rd(0x0127).toString(16).padStart(2,'0')}  (substate)`);
console.log(`  $0152 = $${rd(0x0152).toString(16).padStart(2,'0')}  (NMI flag)`);
console.log(`  $0158-9 = $${rd(0x0158).toString(16).padStart(2,'0')} $${rd(0x0159).toString(16).padStart(2,'0')}  (frame counter)`);
console.log(`  $01BB-F = ${[0x1BB,0x1BC,0x1BD,0x1BE,0x1BF].map(a=>'$'+rd(a).toString(16).padStart(2,'0')).join(' ')}`);
console.log(`  $0BD7 = $${rd(0x0BD7).toString(16).padStart(2,'0')}  (TM precursor)`);
console.log(`  $1DF9 = $${rd(0x1DF9).toString(16).padStart(2,'0')}  (state-0 branch flag)`);
console.log(`  $B504 = $${rd(0xB504).toString(16).padStart(2,'0')}  (TM source)`);
