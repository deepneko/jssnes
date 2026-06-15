// Reproduce the RS3 character-creation screen (idle 500 frames, no input needed)
// and screenshot it to inspect the "swirl" emblem distortion.
import { SNES } from '../src/SNES.js';
import { readFileSync, writeFileSync } from 'fs';
import zlib from 'zlib';

function savePng(fb, W, H, filename) {
  const raw = Buffer.allocUnsafe(H * (1 + W * 3));
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0;
    for (let x = 0; x < W; x++) {
      const px = fb[y * W + x];
      raw[p++] = (px >> 16) & 255; raw[p++] = (px >> 8) & 255; raw[p++] = px & 255;
    }
  }
  function pngChunk(name, d) {
    const c = zlib.crc32(Buffer.concat([Buffer.from(name), d]));
    return Buffer.concat([Buffer.from([(d.length>>>24)&255,(d.length>>>16)&255,(d.length>>>8)&255,d.length&255]), Buffer.from(name), d, Buffer.from([(c>>>24)&255,(c>>>16)&255,(c>>>8)&255,c&255])]);
  }
  const ihdr = Buffer.from([0,0,W>>>8,W&255,0,0,H>>>8,H&255,8,2,0,0,0]);
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  writeFileSync(filename, Buffer.concat([sig, pngChunk('IHDR',ihdr), pngChunk('IDAT',idat), pngChunk('IEND',Buffer.alloc(0))]));
}

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

const W = ppu.frameBuffer.length === 256*224 ? 256 : 512;
const H = ppu.frameBuffer.length / W;
savePng(new Uint32Array(ppu.frameBuffer), W, H, '/tmp/rs3_swirl_f500.png');
process.stderr.write(`done W=${W} H=${H}\n`);
