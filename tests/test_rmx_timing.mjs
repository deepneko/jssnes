// Measure when KON first fires in RMX, and how many frames upload takes.
import { SNES } from '../src/SNES.js';
import { readFileSync } from 'fs';
const snes = new SNES();
snes.loadRom(readFileSync('./rom/rockmanx.sfc'));
console.log = () => {};
const apu = snes.apu;

let firstKonFrame = -1;
let firstP1BBFrame = -1;
let firstP0CCFromSpcFrame = -1;
let firstUploadFrame = -1;
let lastUploadFrame = -1;
let f4ReadCount = 0;
let lastF2 = 0;

const origWrite = apu.write.bind(apu);
apu.write = function(addr, val) {
    if (addr === 0xF2) lastF2 = val;
    if (addr === 0xF3 && (lastF2 & 0x7F) === 0x4C && val !== 0 && firstKonFrame < 0) {
        firstKonFrame = globalThis._snesFrame;
    }
    if (addr === 0xF5 && val === 0xBB && firstP1BBFrame < 0) firstP1BBFrame = globalThis._snesFrame;
    return origWrite(addr, val);
};
const origRead = apu.read.bind(apu);
apu.read = function(addr) { if (addr === 0xF4) f4ReadCount++; return origRead(addr); };

const origWriteCPU = apu.writeCPU.bind(apu);
apu.writeCPU = function(port, val) {
    if (port === 0) {
        if (firstUploadFrame < 0) firstUploadFrame = globalThis._snesFrame;
        lastUploadFrame = globalThis._snesFrame;
    }
    return origWriteCPU(port, val);
};

const startTime = Date.now();
for (let f=0; f<400; f++) {
    globalThis._snesFrame = f;
    snes.frame();
    if (firstKonFrame >= 0 && f >= firstKonFrame + 5) break;
}
const elapsed = Date.now() - startTime;

process.stdout.write(`First SNES->APU port0 write : fr=${firstUploadFrame}\n`);
process.stdout.write(`Last  SNES->APU port0 write : fr=${lastUploadFrame}\n`);
process.stdout.write(`First SPC $BB handshake     : fr=${firstP1BBFrame}\n`);
process.stdout.write(`First KON                   : fr=${firstKonFrame}\n`);
process.stdout.write(`SPC $F4 reads (total)       : ${f4ReadCount}\n`);
process.stdout.write(`Wall-clock for emulation    : ${elapsed} ms\n`);
process.stdout.write(`SPC PC                      : $${apu.PC.toString(16)}\n`);
