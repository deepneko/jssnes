// Diagnose the "swirl" emblem on RS3's character-creation screen (f=500).
import { SNES } from '../src/SNES.js';
import { readFileSync } from 'fs';

const snes = new SNES();
snes.loadRom(readFileSync('./rom/Romancing Sa-Ga 3 (Japan) (Rev 1).sfc'));
console.log = () => {};
const { mmu, ppu } = snes;

const START = 0x1000;
for (let f = 0; f <= 211; f++) {
  mmu.joy1 = (f % 60 < 4) ? START : 0;
  snes.frame();
}
for (let f = 212; f <= 500; f++) {
  mmu.joy1 = 0;
  snes.frame();
}

process.stderr.write(`bgmode=0x${ppu.bgmode.toString(16)} (mode=${ppu.bgmode & 7}, bg3Prio=${(ppu.bgmode>>3)&1}, tilesize=0x${(ppu.bgmode>>4).toString(16)})\n`);
process.stderr.write(`tm=0x${ppu.tm.toString(16)} ts=0x${ppu.ts.toString(16)} tmw=0x${ppu.tmw.toString(16)} tsw=0x${ppu.tsw.toString(16)}\n`);
for (let i = 1; i <= 4; i++) {
  process.stderr.write(`BG${i}: sc=0x${ppu['bg'+i+'sc'].toString(16)} hofs=${ppu['bg'+i+'hofs']} vofs=${ppu['bg'+i+'vofs']}\n`);
}
process.stderr.write(`bg12nba=0x${ppu.bg12nba.toString(16)} bg34nba=0x${ppu.bg34nba.toString(16)}\n`);
process.stderr.write(`obsel=0x${ppu.obsel.toString(16)}\n`);

// Dump OAM entries that are on-screen (visible) with their size/position
const objSizeTable = [[8,8],[16,16],[8,8],[32,32],[8,8],[64,64],[16,32],[16,32],[16,16],[32,32],[16,32],[32,64],[32,32],[64,64],[32,32],[64,64]];
const sizeSel = (ppu.obsel >> 5) & 7;
const sizes = [[8,8,16,16],[8,8,32,32],[8,8,64,64],[16,16,32,32],[16,16,64,64],[32,32,64,64],[16,32,32,64],[16,32,32,32]][sizeSel];
process.stderr.write(`OBJ size select=${sizeSel} -> small=${sizes[0]}x${sizes[1]} large=${sizes[2]}x${sizes[3]}\n`);

let visCount = 0;
for (let i = 0; i < 128; i++) {
  const base = i * 4;
  const x = ppu.oam[base];
  const y = ppu.oam[base+1];
  const tile = ppu.oam[base+2];
  const attr = ppu.oam[base+3];
  const highByte = ppu.oamHigh ? ppu.oamHigh[i] : 0;
  const sizeBit = (highByte >> 1) & 1;
  const xHigh = highByte & 1;
  const fullX = x | (xHigh << 8);
  const signedX = fullX >= 256 ? fullX - 512 : fullX;
  const [w,h] = sizeBit ? [sizes[2], sizes[3]] : [sizes[0], sizes[1]];
  if (y < 224 && signedX > -w && signedX < 256) {
    visCount++;
    process.stderr.write(`OAM[${i}] x=${signedX} y=${y} tile=0x${tile.toString(16)} attr=0x${attr.toString(16)} size=${w}x${h} prio=${(attr>>4)&3}\n`);
  }
}
process.stderr.write(`visible OAM count=${visCount}\n`);
