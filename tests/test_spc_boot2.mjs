// Proper SPC700 boot simulation - fixed state machine
// Based on decoded $C7:$0000-$0180 boot protocol:
//   Phase 1 ($005A): CPX $2140 waiting for $AA/$BB (bootloader ready)  
//   Phase 2 ($0078): CMP $2140 waiting for $CC echo (upload start ack)
//   Phase 3 ($00AB): CMP $2140 waiting for frame counter echo (upload)
//   Phase 4 ($011C etc): various acks
//   Phase 5 ($09E0 fr=115): CMP $2140 waiting for music start ack ($E0)

import { readFileSync, writeFileSync } from 'fs';
import { SNES } from '../src/SNES.js';

const snes = new SNES();
snes.loadRom(readFileSync('./rom/chrono_trigger.sfc'));
snes.apu._enableHacks = false;

const mmu = snes.mmu;
const cpu = snes.cpu;
const ppu = snes.ppu;

// SPC70 boot simulation:
// - Start with $AA/$BB (IPL ready)
// - After CPU writes to port0: echo that value back immediately
// - For 16-bit CPX check: ports[0]=$AA ports[1]=$BB at start
let spcPorts = [0xAA, 0xBB, 0x00, 0x00]; // what SPC70 sends to CPU (CPU reads these)
let spcPhase = 'boot'; // 'boot', 'upload', 'running'
let lastCpuPort0 = 0;

const origWrite = mmu.write.bind(mmu);
const origRead = mmu.read.bind(mmu);

mmu.write = function(addr, val, ...args) {
  const eff = addr & 0xFFFF;
  if (eff >= 0x2140 && eff <= 0x2143) {
    const portIdx = eff - 0x2140;
    const v = val & 0xFF;
    if (portIdx === 0) {
      lastCpuPort0 = v;
      if (spcPhase === 'boot' && v === 0xCC) {
        // CPU started upload - echo $CC
        spcPorts[0] = 0xCC;
        spcPhase = 'upload';
      } else if (spcPhase === 'upload') {
        // Echo frame counter
        spcPorts[0] = v;
      } else if (spcPhase === 'running') {
        // Echo music commands
        spcPorts[0] = v;
      }
    } else if (portIdx === 1) {
      // port1 write - track for state transition
      if (spcPhase === 'upload') {
        // port1 = $00 with port0 = non-CC can mean execute or new block
        // After execute: transition to running
      }
    }
  }
  return origWrite(addr, val, ...args);
};

mmu.read = function(addr, ...args) {
  const eff = addr & 0xFFFF;
  if (eff >= 0x2140 && eff <= 0x2143) {
    origRead(addr, ...args);
    const portIdx = eff - 0x2140;
    return spcPorts[portIdx];
  }
  return origRead(addr, ...args);
};

// Run up to 2000 frames, check for logo in VRAM
let logoFound = false;
let logoFrame = -1;
let prevNonzero = 0;

for (let fr = 1; fr <= 2000; fr++) {
  snes.frame();
  
  let nonzero = 0;
  for (let i = 0xC000; i < 0xC800; i++) {
    if (ppu.vram[i] !== 0) nonzero++;
  }
  
  if (fr <= 30 || fr % 50 === 0 || nonzero !== prevNonzero) {
    const w2980 = mmu.wram[0x2980];
    const inidisp = ppu.inidisp ?? 0;
    const bg1sc = ppu.bg1sc ?? 0;
    console.log(`fr=${fr} VRAM_C000=${nonzero} $2980=${w2980.toString(16)} INIDISP=${inidisp.toString(16)} bg1sc=${bg1sc.toString(16)} phase=${spcPhase}`);
    prevNonzero = nonzero;
    
    if (nonzero > 100 && !logoFound) {
      logoFound = true;
      logoFrame = fr;
      console.log(`*** LOGO TILEMAP at fr=${fr}! ***`);
    }
  }
  
  if (logoFound && fr >= logoFrame + 10) break;
}

console.log(`\nPPU state: INIDISP=${(ppu.inidisp??0).toString(16)} bg1sc=${(ppu.bg1sc??0).toString(16)} tm=${(ppu.tm??0).toString(16)}`);
console.log(`WRAM $2980: ${mmu.wram[0x2980].toString(16)}`);
console.log(`VRAM $4000 first 8 bytes: ${Array.from(ppu.vram.slice(0x4000,0x4008)).map(x=>x.toString(16).padStart(2,'0')).join(' ')}`);
console.log(`VRAM $C000 first 8 bytes: ${Array.from(ppu.vram.slice(0xC000,0xC008)).map(x=>x.toString(16).padStart(2,'0')).join(' ')}`);
