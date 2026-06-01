// Capture full Capcom logo jingle (~5 seconds)
// Fix: replace DSP sample buffer with large external accumulator
import { SNES } from './src/SNES.js';
import { readFileSync, writeFileSync } from 'fs';

const snes = new SNES();
snes.loadRom(readFileSync('./rom/rockmanx.sfc'));
console.log = () => {};

const dsp = snes.apu.dsp;

// Replace internal buffer with large one (10 seconds headroom)
const SAMPLES = 32000 * 10;
dsp.sampleBufferL = new Float32Array(SAMPLES);
dsp.sampleBufferR = new Float32Array(SAMPLES);
dsp.samplePos = 0;

// Track KON
const origWrite = dsp.write.bind(dsp);
let konFired = false;
let captureStart = -1;
dsp.write = function(addr, val) {
    const reg = addr & 0x7F;
    if (reg === 0x4C && val !== 0 && !konFired) {
        konFired = true;
        captureStart = dsp.samplePos;
        process.stderr.write(`KON fired fr=${globalThis._snesFrame} voices=$${val.toString(16)} samplePos=${dsp.samplePos}\n`);
        // Reset buffer to capture from this point
        dsp.sampleBufferL.fill(0);
        dsp.sampleBufferR.fill(0);
        dsp.samplePos = 0;
    }
    return origWrite(addr, val);
};

// Run: need ~600 frames past KON for 10s (KON at ~141, so run 750 total)
for (let f = 0; f < 750; f++) {
    globalThis._snesFrame = f;
    snes.frame();
}

const pos = dsp.samplePos;
let maxL = 0;
for (let i = 0; i < pos; i++) if (Math.abs(dsp.sampleBufferL[i]) > maxL) maxL = Math.abs(dsp.sampleBufferL[i]);
process.stdout.write(`KON fired: ${konFired}\n`);
process.stdout.write(`samplePos=${pos} maxL=${maxL.toFixed(4)} duration=${(pos/32000).toFixed(2)}s\n`);
process.stdout.write(`spcPC=$${snes.apu.PC.toString(16).padStart(4,'0')}\n`);

if (pos > 0) {
    const L = dsp.sampleBufferL;
    const R = dsp.sampleBufferR;
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
    writeFileSync('rmx_capcom_full.wav', buf);
    process.stdout.write(`WAV written: rmx_capcom_full.wav (${(pos/32000).toFixed(2)}s)\n`);
}
