import { SNES } from './src/SNES.js';
import { readFileSync, writeFileSync } from 'fs';
const snes = new SNES();
snes.loadRom(readFileSync('./rom/rockmanx.sfc'));
console.log = () => {};

const dsp = snes.apu.dsp;
const origWrite = dsp.write.bind(dsp);
let konLog = [];
dsp.write = function(addr, val) {
    const reg = addr & 0x7F;
    if (reg === 0x4C && val !== 0 && konLog.length < 5) konLog.push({fr: globalThis._snesFrame, val:`$${val.toString(16)}`});
    return origWrite(addr, val);
};

for (let f = 0; f < 3000; f++) { globalThis._snesFrame = f; snes.frame(); }

process.stdout.write(`KON (non-zero): ${JSON.stringify(konLog)}\n`);
process.stdout.write(`cpuP[0]=$${snes.apu.cpuPorts[0].toString(16)} cpuP[1]=$${snes.apu.cpuPorts[1].toString(16)} spcPC=$${snes.apu.PC.toString(16).padStart(4,'0')}\n`);
let maxL = 0;
for (let i = 0; i < dsp.samplePos; i++) if (Math.abs(dsp.sampleBufferL[i]) > maxL) maxL = Math.abs(dsp.sampleBufferL[i]);
process.stdout.write(`samplePos=${dsp.samplePos} maxL=${maxL.toFixed(4)}\n`);

if (maxL > 0.001) {
    const pos = dsp.samplePos;
    const L = dsp.sampleBufferL;
    const R = dsp.sampleBufferR;
    const dataSize = pos * 4;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(32000, 24); buf.writeUInt32LE(128000, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < pos; i++) {
        buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
        buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 44 + i * 4 + 2);
    }
    writeFileSync('rmx_capcom_v5.wav', buf);
    process.stdout.write(`WAV written: ${(pos / 32000).toFixed(2)}s\n`);
}
