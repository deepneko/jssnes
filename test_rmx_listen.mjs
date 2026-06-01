// Generate a longer WAV of RMX Capcom logo to listen to current output.
import { SNES } from './src/SNES.js';
import { readFileSync, writeFileSync } from 'fs';

const snes = new SNES();
snes.loadRom(readFileSync('./rom/rockmanx.sfc'));
console.log = () => {};

const dsp = snes.apu.dsp;

// Enlarge sample buffer (default 8192 ≈ 0.26s @ 32kHz). Aim for ~6 seconds.
const SR = 32000;
const SECONDS = 6;
dsp.sampleBufferL = new Float32Array(SR * SECONDS);
dsp.sampleBufferR = new Float32Array(SR * SECONDS);
dsp.samplePos = 0;

let konLog = [];
const origDW = dsp.write.bind(dsp);
dsp.write = function(addr, val) {
    const reg = addr & 0x7F;
    if (reg === 0x4C && val !== 0 && konLog.length < 20) {
        konLog.push({ fr: globalThis._snesFrame, val: '$' + val.toString(16) });
    }
    return origDW(addr, val);
};

// Run until samplePos fills or 600 frames (~10s) elapse.
for (let f = 0; f < 600; f++) {
    globalThis._snesFrame = f;
    snes.frame();
    if (dsp.samplePos >= dsp.sampleBufferL.length - 1000) break;
}

let maxL = 0;
for (let i = 0; i < dsp.samplePos; i++) {
    const a = Math.abs(dsp.sampleBufferL[i]);
    if (a > maxL) maxL = a;
}
process.stdout.write(`samplePos=${dsp.samplePos} (~${(dsp.samplePos / SR).toFixed(2)}s) maxL=${maxL.toFixed(4)}\n`);
process.stdout.write(`First KON events: ${JSON.stringify(konLog.slice(0, 10))}\n`);

const pos = dsp.samplePos;
const dataSize = pos * 4;
const buf = Buffer.alloc(44 + dataSize);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
for (let i = 0; i < pos; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, dsp.sampleBufferL[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, dsp.sampleBufferR[i])) * 32767), 44 + i * 4 + 2);
}
writeFileSync('rmx_capcom_listen.wav', buf);
process.stdout.write(`WAV written: rmx_capcom_listen.wav (${(pos / SR).toFixed(2)}s, ${(buf.length/1024).toFixed(1)} KB)\n`);
