// Measure CPU cycles per frame vs SPC cycles per frame
import { SNES } from '../src/SNES.js';
import { readFileSync } from 'fs';
const snes = new SNES();
snes.loadRom(readFileSync('./rom/rockmanx.sfc'));
console.log = () => {};

let cpuCyclesStart = 0;
let apuCyclesStart = 0;
let cpuStepCount = 0;

// Hook
const origCpuStep = snes.cpu.step.bind(snes.cpu);
snes.cpu.step = function() {
    cpuStepCount++;
    return origCpuStep();
};

// Run 60 frames after init settles
for (let f=0; f<10; f++) { globalThis._snesFrame = f; snes.frame(); }
cpuCyclesStart = snes.cpu.cycles;
apuCyclesStart = snes.apu.cycles;
const stepStart = cpuStepCount;

for (let f=10; f<70; f++) { globalThis._snesFrame = f; snes.frame(); }

const cpuD = snes.cpu.cycles - cpuCyclesStart;
const apuD = snes.apu.cycles - apuCyclesStart;
const stepD = cpuStepCount - stepStart;
const frames = 60;

process.stdout.write(`CPU cycles over ${frames} frames : ${cpuD} (${(cpuD/frames).toFixed(0)}/frame)\n`);
process.stdout.write(`CPU steps  over ${frames} frames : ${stepD} (${(stepD/frames).toFixed(0)}/frame)\n`);
process.stdout.write(`Avg CPU cycles/step             : ${(cpuD/stepD).toFixed(2)}\n`);
process.stdout.write(`APU cycles over ${frames} frames : ${apuD} (${(apuD/frames).toFixed(0)}/frame)\n`);
process.stdout.write(`Expected APU cycles/frame       : 17066 (1.024MHz / 60)\n`);
process.stdout.write(`Expected CPU cycles/frame       : 59667 (3.58MHz / 60)\n`);
process.stdout.write(`Ratio APU/CPU achieved          : ${(apuD/cpuD).toFixed(3)}  (target 0.286)\n`);
