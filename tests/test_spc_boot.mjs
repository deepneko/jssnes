// Decode $C7:$0050-$0160 to understand the full APU protocol
// and trace exactly what values are written/expected at each stuck point

import { readFileSync } from 'fs';
import { SNES } from '../src/SNES.js';

const romRaw = readFileSync('./rom/chrono_trigger.sfc');
function romByte(bank, addr) {
  let b = bank & 0x7F; if (b < 0x40) b += 0x40;
  return romRaw[(b - 0x40) * 0x10000 + addr];
}

// Key findings from decode:
// $C7:$004D: A2 AA BB = LDX #$BBAA (expects SPC70 to return AA at port0, BB at port1)
// $C7:$005A: EC 40 21 = CPX $2140 (16-bit compare of X=$BBAA with [$2140:$2141])
// $C7:$005D: D0 F1 = BNE $0050 ← STUCK 1
//
// $C7:$00A8: 8D 40 21 = STA $2140 (write frame counter)
// $C7:$00AB: CD 40 21 = CMP $2140 (wait for SPC echo of frame counter)
// $C7:$00AE: D0 FB = BNE $00AB ← STUCK 2
//
// Proper fix: set APU ports to return $AA/$BB initially, then echo frame counter

// WHAT DOES SPC700 IPL BOOT ROM DO?
// - At reset: writes $AA to $F4 (port0), $BB to $F5 (port1) - bootloader ready
// - Waits for CPU to write $CC to $F4 ($2140)
// - Echoes $CC back: $F4 = $CC
// - Receives dest addr from $F5:$F6 ($2141:$2142?), or $F6:$F7 ($2142:$2143?)  
// - Actually: $F4=$CC = trigger, reads $F5 for flags, $F6:$F7 for start address
// - Then enters upload loop: for each byte: CPU sends to $F4; SPC stores it; 
//   SPC echoes same value + increments its own counter
// - ACTUALLY: SPC echoes SAME VALUE (not incremented) per byte to confirm receipt?
// Let me check: the STUCK 2 has apuPorts=[2b,bb,0,0] and cpuPorts=[2b,a3,0,2]
//   APU port0=$2B = same as cpu port0=$2B = ECHO IS ALREADY WORKING for stuck2?
//   But the stuck fires... maybe the emulator's "apuPorts" reading is wrong?

// Run with PROPER SPC700 boot simulation
const snes = new SNES();
snes.loadRom(readFileSync('./rom/chrono_trigger.sfc'));
snes.apu._enableHacks = false;

const mmu = snes.mmu;
const cpu = snes.cpu;
const ppu = snes.ppu;

// SPC700 IPL boot state machine
let spcState = 0; // 0=waiting for init, 1=ready ($AA/$BB sent), 2=upload, 3=executing
let spcPort0 = 0xAA; // SPC70 starts with $AA on port0
let spcPort1 = 0xBB; // SPC70 starts with $BB on port1
let spcPort2 = 0x00;
let spcPort3 = 0x00;
let cpuPort0Written = 0;
let cpuPort1Written = 0;
let cpuPort2Written = 0;
let cpuPort3Written = 0;

const origWrite = mmu.write.bind(mmu);
const origRead = mmu.read.bind(mmu);

mmu.write = function(addr, val, ...args) {
  const eff = addr & 0xFFFF;
  if (eff === 0x2140) {
    cpuPort0Written = val & 0xFF;
    // SPC70 state transitions:
    if (spcState === 1) {
      // Waiting for $CC to start upload
      if (cpuPort0Written === 0xCC) {
        spcPort0 = 0xCC; // echo $CC back
        spcState = 2; // transition to upload mode
      }
    } else if (spcState === 2) {
      // During upload: echo the frame counter (what CPU writes to port0)
      spcPort0 = cpuPort0Written;
    } else if (spcState === 3) {
      // After execute: echo port0 writes
      spcPort0 = cpuPort0Written;
    }
  } else if (eff === 0x2141) {
    cpuPort1Written = val & 0xFF;
    if (spcState === 2) {
      if (cpuPort1Written === 0x00) {
        // New block start or execute command - check port2/3
        if (cpuPort2Written === 0 && cpuPort3Written === 0) {
          spcPort0 = 0; // ack execute
          spcState = 3;
        }
      }
    }
  } else if (eff === 0x2142) {
    cpuPort2Written = val & 0xFF;
  } else if (eff === 0x2143) {
    cpuPort3Written = val & 0xFF;
  }
  return origWrite(addr, val, ...args);
};

mmu.read = function(addr, ...args) {
  const eff = addr & 0xFFFF;
  if (eff === 0x2140) {
    origRead(addr, ...args); // call original to keep emulator state consistent
    return spcPort0;
  } else if (eff === 0x2141) {
    origRead(addr, ...args);
    return spcPort1;
  } else if (eff === 0x2142) {
    origRead(addr, ...args);
    return spcPort2;
  } else if (eff === 0x2143) {
    origRead(addr, ...args);
    return spcPort3;
  }
  return origRead(addr, ...args);
};

// Run 1500 frames, check for logo
let logoFound = false;
let logoFrame = -1;

for (let fr = 1; fr <= 1500; fr++) {
  snes.frame();
  
  if (fr <= 30 || fr % 50 === 0) {
    let nonzero = 0;
    for (let i = 0xC000; i < 0xC800; i++) {
      if (ppu.vram[i] !== 0) nonzero++;
    }
    const w2980 = mmu.wram[0x2980];
    const w0280 = mmu.wram[0x0280];
    const inidisp = ppu.inidisp ?? ppu.brightness ?? 0;
    const bg1sc = ppu.bg1sc ?? 0;
    console.log(`fr=${fr} VRAM_C000=${nonzero} $2980=${w2980.toString(16)} $0280=${w0280.toString(16)} INIDISP=${inidisp.toString(16)} bg1sc=${bg1sc.toString(16)}`);
    
    if (nonzero > 100 && !logoFound) {
      logoFound = true;
      logoFrame = fr;
      console.log(`*** LOGO TILEMAP APPEARED at frame ${fr}! ***`);
    }
  }
  
  if (logoFound && fr >= logoFrame + 5) break;
}

console.log(`\nFinal WRAM dump:`);
console.log(`  $2980-$2990: ${Array.from(mmu.wram.slice(0x2980, 0x2990)).map(x=>x.toString(16).padStart(2,'0')).join(' ')}`);
console.log(`  $0280-$0290: ${Array.from(mmu.wram.slice(0x0280, 0x0290)).map(x=>x.toString(16).padStart(2,'0')).join(' ')}`);
