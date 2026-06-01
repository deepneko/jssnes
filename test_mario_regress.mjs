// Mario regression test - reset samplePos after first KON to capture actual audio
import { SNES } from './src/SNES.js';
import { readFileSync, writeFileSync } from 'fs';
const snes = new SNES();
snes.loadRom(readFileSync('./rom/super_mario_world.smc'));
console.log = () => {};

const dsp = snes.apu.dsp;
const origWrite = dsp.write.bind(dsp);
let konLog = [];
let sampleResetDone = false;
dsp.write = function(addr, val) {
    const reg = addr & 0x7F;
    if (reg === 0x4C && val !== 0) {
        konLog.push({fr: globalThis._snesFrame, voices: val.toString(16)});
        // Reset sample buffer at first KON to capture actual audio output
        if (!sampleResetDone) {
            sampleResetDone = true;
            dsp.samplePos = 0;
            dsp.sampleBufferL.fill(0);
            dsp.sampleBufferR.fill(0);
        }
    }
    return origWrite(addr, val);
};

for (let f = 0; f < 600; f++) { globalThis._snesFrame = f; snes.frame(); }

const apu = snes.apu;
process.stdout.write(`KON fires: ${konLog.length}, first5: ${JSON.stringify(konLog.slice(0,5))}\n`);
process.stdout.write(`cpuP: [${[0,1,2,3].map(i=>apu.cpuPorts[i].toString(16)).join(',')}]\n`);
process.stdout.write(`uploadDone=${apu._uploadDone} uploadActive=${apu._uploadActive} nspcStarted=${apu._nspcStarted}\n`);

let maxL = 0;
for (let i = 0; i < dsp.samplePos; i++) if (Math.abs(dsp.sampleBufferL[i]) > maxL) maxL = Math.abs(dsp.sampleBufferL[i]);
process.stdout.write(`samplePos=${dsp.samplePos} maxL=${maxL.toFixed(4)}\n`);

if (dsp.samplePos > 0) {
    const pos = dsp.samplePos; const L = dsp.sampleBufferL; const R = dsp.sampleBufferR;
    const dataSize = pos * 4;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF',0); buf.writeUInt32LE(36+dataSize,4); buf.write('WAVE',8); buf.write('fmt ',12);
    buf.writeUInt32LE(16,16); buf.writeUInt16LE(1,20); buf.writeUInt16LE(2,22);
    buf.writeUInt32LE(32000,24); buf.writeUInt32LE(128000,28); buf.writeUInt16LE(4,32); buf.writeUInt16LE(16,34);
    buf.write('data',36); buf.writeUInt32LE(dataSize,40);
    for (let i=0;i<pos;i++) {
        buf.writeInt16LE(Math.round(Math.max(-1,Math.min(1,L[i]))*32767),44+i*4);
        buf.writeInt16LE(Math.round(Math.max(-1,Math.min(1,R[i]))*32767),44+i*4+2);
    }
    writeFileSync('mario_test.wav', buf);
    process.stdout.write(`WAV written: ${(pos/32000).toFixed(2)}s\n`);
}

// Regression pass/fail
if (konLog.length > 0 && maxL > 0.001) {
    process.stdout.write(`\nPASS: Mario audio OK (KON fires=${konLog.length}, maxL=${maxL.toFixed(4)})\n`);
} else if (konLog.length > 0) {
    process.stdout.write(`\nWARN: Mario KON fires (${konLog.length}) but audio silent (maxL=${maxL.toFixed(4)})\n`);
} else {
    process.stdout.write(`\nFAIL: Mario no KON fires\n`);
}
