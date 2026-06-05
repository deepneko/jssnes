#!/usr/bin/env node
// Run the JS emulator for N frames and dump WRAM ($7E:0000-$7F:FFFF, 128KB).
// Usage: node tools/js_wram_dump.mjs <frames> [<output.bin>]

import { SNES } from '../src/SNES.js';
import { readFileSync, writeFileSync } from 'fs';

const frames = parseInt(process.argv[2] || '200', 10);
const outPath = process.argv[3] || `/tmp/js_wram_${frames}.bin`;

const s = new SNES();
s.loadRom(readFileSync('./rom/chrono_trigger.sfc'));

// Suppress emulator console noise
const origLog = console.log;
console.log = () => {};
for (let f = 0; f < frames; f++) s.frame();
console.log = origLog;

const wram = s.mmu.wram;
// Verify length
if (wram.length !== 0x20000) {
  console.log(`WARN: wram length is ${wram.length}, expected 131072`);
}
writeFileSync(outPath, Buffer.from(wram.buffer, wram.byteOffset, wram.byteLength));
console.log(`JS WRAM written: ${outPath} (${wram.length} bytes) after ${frames} frames`);

// Echo key bytes
function rd(off) { return wram[off]; }
console.log('\nKey WRAM bytes (JS emulator):');
console.log(`  $0117 = $${rd(0x0117).toString(16).padStart(2,'0')}`);
console.log(`  $0126 = $${rd(0x0126).toString(16).padStart(2,'0')}  (game state byte)`);
console.log(`  $0127 = $${rd(0x0127).toString(16).padStart(2,'0')}  (substate)`);
console.log(`  $0152 = $${rd(0x0152).toString(16).padStart(2,'0')}  (NMI flag)`);
console.log(`  $0158-9 = $${rd(0x0158).toString(16).padStart(2,'0')} $${rd(0x0159).toString(16).padStart(2,'0')}  (frame counter)`);
console.log(`  $01BB-F = ${[0x1BB,0x1BC,0x1BD,0x1BE,0x1BF].map(a=>'$'+rd(a).toString(16).padStart(2,'0')).join(' ')}`);
console.log(`  $0BD7 = $${rd(0x0BD7).toString(16).padStart(2,'0')}`);
console.log(`  $1DF9 = $${rd(0x1DF9).toString(16).padStart(2,'0')}`);
console.log(`  $B504 = $${rd(0xB504).toString(16).padStart(2,'0')}`);
