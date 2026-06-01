// ROOT FIX: APU port echo simulation
// The SPC700 is not running (apu._enableHacks=false), so APU port reads return wrong values
// The fix: intercept MMU reads for $2140-$2143 and return what the CPU last wrote
// This simulates the SPC700 properly echoing back port values (the handshake protocol)
// WITHOUT modifying any src/ files

import { readFileSync, writeFileSync } from 'fs';
import { PNG } from 'pngjs';
import { SNES } from './src/SNES.js';

const rom = readFileSync('./rom/chrono_trigger.sfc');
const snes = new SNES();
snes.loadRom(rom);
snes.apu._enableHacks = false;

const mmu = snes.mmu;
const cpu = snes.cpu;
const ppu = snes.ppu;
const wram = mmu.wram;

// APU echo: track what CPU writes to $2140-$2143, return those on reads
const cpuAputPorts = [0, 0, 0, 0]; // CPU writes to ports 0-3

const origWrite = mmu.write.bind(mmu);
const origRead = mmu.read.bind(mmu);

mmu.write = function(addr, val, ...args) {
  const eff = addr & 0xFFFF;
  // APU ports: CPU writes to $2140-$2143
  if (eff >= 0x2140 && eff <= 0x2143) {
    cpuAputPorts[eff - 0x2140] = val & 0xFF;
  }
  return origWrite(addr, val, ...args);
};

mmu.read = function(addr, ...args) {
  const eff = addr & 0xFFFF;
  // APU ports: CPU reads $2140-$2143 = SPC700 output
  // With broken APU, we mirror back what CPU wrote (echo simulation)
  if (eff >= 0x2140 && eff <= 0x2143) {
    const portIdx = eff - 0x2140;
    const echoVal = cpuAputPorts[portIdx];
    // Let the original read happen too (for emulator state)
    origRead(addr, ...args);
    return echoVal;
  }
  return origRead(addr, ...args);
};

// Run frames until logo appears in VRAM or 1500 frames
let logoFound = false;
let logoFrame = -1;

for (let fr = 1; fr <= 1500; fr++) {
  snes.frame();
  
  // Check VRAM $C000: tilemap for BG1
  // Logo tilemap should be non-zero if logo is being displayed
  if (fr % 50 === 0 || fr <= 30) {
    let nonzero = 0;
    for (let i = 0xC000; i < 0xC800; i++) {
      if (ppu.vram[i] !== 0) nonzero++;
    }
    const w2980 = wram[0x2980];
    const w0280 = wram[0x0280];
    const w027e = wram[0x027E];
    const w0282 = wram[0x0282];
    console.log(`fr=${fr} VRAM_C000_nonzero=${nonzero} $2980=${w2980.toString(16)} $0280=${w0280.toString(16)} $027E=${w027e.toString(16)} $0282=${w0282.toString(16)}`);
    
    if (nonzero > 100 && !logoFound) {
      logoFound = true;
      logoFrame = fr;
    }
  }
  
  if (logoFound && fr >= logoFrame + 10) break;
}

if (!logoFound) {
  // Check final VRAM state
  let nonzero = 0;
  for (let i = 0xC000; i < 0xC800; i++) {
    if (ppu.vram[i] !== 0) nonzero++;
  }
  console.log(`\nFinal: VRAM $C000 nonzero=${nonzero}`);
}

// Check INIDISP and PPU state
console.log(`\nPPU state at end:`);
console.log(`  INIDISP=$${ppu.inidisp?.toString(16) ?? '??'} (brightness)`);
console.log(`  bg1sc=$${ppu.bg1sc?.toString(16) ?? '??'}`);
console.log(`  bg12nba=$${ppu.bg12nba?.toString(16) ?? '??'}`);
console.log(`  tm=$${ppu.tm?.toString(16) ?? '??'}`);

// Check WRAM key values
console.log(`\nWRAM at end:`);
console.log(`  $2980=${wram[0x2980].toString(16)} $2981=${wram[0x2981].toString(16)} ... $2988=${wram[0x2988].toString(16)}`);
console.log(`  $0280=${wram[0x0280].toString(16)} $0282=${wram[0x0282].toString(16)} $027E=${wram[0x027E].toString(16)}`);

// VRAM $C000 sample
console.log(`\nVRAM $C000-$C040 (first 64 bytes of BG1 tilemap):`);
const samp = [];
for (let i = 0xC000; i < 0xC040; i++) samp.push(ppu.vram[i].toString(16).padStart(2,'0'));
console.log(samp.join(' '));
