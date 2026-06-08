// Measure SPC cycles per opcode and APU efficiency during RMX upload
import { SNES } from '../src/SNES.js';
import { readFileSync } from 'fs';
const snes = new SNES();
snes.loadRom(readFileSync('./rom/rockmanx.sfc'));
console.log = () => {};
const apu = snes.apu;

let cpuPollCount = 0;
let cpuP0WriteCount = 0;
let spcStepCount = 0;
let spcCycleSum = 0;
let spcStepDuringUpload = 0;

const origStep = apu.step.bind(apu);
let prevCycles = 0;
apu.step = function() {
    const before = apu.cycles;
    origStep();
    const d = apu.cycles - before;
    spcStepCount++;
    spcCycleSum += d;
    if (globalThis._inUpload) spcStepDuringUpload++;
};

// Hook CPU read of $2140
const cpu = snes.cpu;
const origReadCpu = snes.mmu.read.bind(snes.mmu);
let pollDuringUpload = 0;
snes.mmu.read = function(addr) {
    if ((addr & 0xFFFF) === 0x2140 && globalThis._inUpload) pollDuringUpload++;
    return origReadCpu(addr);
};

const origWriteCPU = apu.writeCPU.bind(apu);
apu.writeCPU = function(port, val) {
    if (port === 0) cpuP0WriteCount++;
    return origWriteCPU(port, val);
};

let lastF2 = 0;
let firstKon = -1;
const origApuWrite = apu.write.bind(apu);
apu.write = function(addr, val) {
    if (addr === 0xF2) lastF2 = val;
    if (addr === 0xF3 && (lastF2 & 0x7F) === 0x4C && val !== 0 && firstKon < 0) {
        firstKon = globalThis._snesFrame;
    }
    return origApuWrite(addr, val);
};

globalThis._inUpload = false;
const startT = Date.now();
for (let f=0; f<400; f++) {
    globalThis._snesFrame = f;
    if (f === 127) globalThis._inUpload = true;
    snes.frame();
    if (firstKon >= 0 && f >= firstKon) { globalThis._inUpload = false; break; }
}
const elapsed = Date.now() - startT;

process.stdout.write(`SPC steps total            : ${spcStepCount}\n`);
process.stdout.write(`SPC cycle sum              : ${spcCycleSum}\n`);
process.stdout.write(`Avg SPC cycles/step        : ${(spcCycleSum/spcStepCount).toFixed(2)}\n`);
process.stdout.write(`SPC steps during upload    : ${spcStepDuringUpload}\n`);
process.stdout.write(`CPU $2140 reads in upload  : ${pollDuringUpload}\n`);
process.stdout.write(`CPU port0 writes           : ${cpuP0WriteCount}\n`);
process.stdout.write(`First KON frame            : ${firstKon}\n`);
process.stdout.write(`Wall-clock                 : ${elapsed} ms\n`);
process.stdout.write(`Ratio CPU-poll/SPC-step    : ${(pollDuringUpload/spcStepDuringUpload).toFixed(2)}\n`);
