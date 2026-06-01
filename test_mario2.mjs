// Mario: longer run, check SPC RAM BRR data, write WAV regardless
import { SNES } from './src/SNES.js';
import { readFileSync, writeFileSync } from 'fs';
const snes = new SNES();
snes.loadRom(readFileSync('./rom/super_mario_world.smc'));
console.log = () => {};

const dsp = snes.apu.dsp;
const apu = snes.apu;
const origWrite = dsp.write.bind(dsp);

let konVoices = [];
dsp.write = function(addr, val) {
    const reg = addr & 0x7F;
    if (reg === 0x4C && val !== 0) konVoices.push({fr: globalThis._snesFrame, voices: val.toString(16)});
    return origWrite(addr, val);
};

for (let f = 0; f < 600; f++) { globalThis._snesFrame = f; snes.frame(); }

process.stdout.write(`KON fires: ${konVoices.length}, first5: ${JSON.stringify(konVoices.slice(0,5))}\n`);
process.stdout.write(`cpuP: [${[0,1,2,3].map(i=>apu.cpuPorts[i].toString(16)).join(',')}]\n`);
process.stdout.write(`uploadDone=${apu._uploadDone} uploadActive=${apu._uploadActive} nspcStarted=${apu._nspcStarted}\n`);
process.stdout.write(`nspcFrameStarted=${apu._nspcFrameStarted} nspcCmd=$${apu._nspcCmd?.toString(16)}\n`);

const dir = dsp.read(0x5D);
const dirBase = dir * 0x100;
process.stdout.write(`DIR=$${dir.toString(16)} → base=$${dirBase.toString(16)}\n`);
// print dir table entries 0-7
for (let i = 0; i < 8; i++) {
    const addr = dirBase + i * 4;
    const start = apu.ram[addr] | (apu.ram[addr+1] << 8);
    const loop  = apu.ram[addr+2] | (apu.ram[addr+3] << 8);
    const byte0 = apu.ram[start] ?? 0;
    process.stdout.write(`  DIR[${i}]: start=$${start.toString(16).padStart(4,'0')} loop=$${loop.toString(16).padStart(4,'0')} BRR[0]=$${byte0.toString(16).padStart(2,'0')}\n`);
}

// SRCN for voice 6 (reg $64)
const srcn6 = dsp.read(0x64);
process.stdout.write(`V6 SRCN=$${srcn6.toString(16)}\n`);

let maxL = 0;
for (let i = 0; i < dsp.samplePos; i++) if (Math.abs(dsp.sampleBufferL[i]) > maxL) maxL = Math.abs(dsp.sampleBufferL[i]);
process.stdout.write(`samplePos=${dsp.samplePos} maxL=${maxL.toFixed(4)}\n`);

const pos = dsp.samplePos;
if (pos > 0) {
    const L = dsp.sampleBufferL; const R = dsp.sampleBufferR;
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
