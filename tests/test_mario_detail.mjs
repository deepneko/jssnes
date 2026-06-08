// Mario detailed DSP state check
import { SNES } from '../src/SNES.js';
import { readFileSync, writeFileSync } from 'fs';
const snes = new SNES();
snes.loadRom(readFileSync('./rom/super_mario_world.smc'));
console.log = () => {};

const dsp = snes.apu.dsp;
const origWrite = dsp.write.bind(dsp);

let dspWrites = [];
let konVoices = [];
dsp.write = function(addr, val) {
    const reg = addr & 0x7F;
    if (dspWrites.length < 50) dspWrites.push({reg: reg.toString(16).padStart(2,'0'), val: val.toString(16).padStart(2,'0'), fr: globalThis._snesFrame});
    if (reg === 0x4C && val !== 0) konVoices.push({fr: globalThis._snesFrame, voices: val});
    return origWrite(addr, val);
};

for (let f = 0; f < 300; f++) { globalThis._snesFrame = f; snes.frame(); }

process.stdout.write(`KON fires: ${konVoices.length}, first: ${JSON.stringify(konVoices[0])}\n`);
process.stdout.write(`\nFirst 50 DSP writes:\n`);
for (const w of dspWrites.slice(0, 30)) {
    process.stdout.write(`  reg:$${w.reg} val:$${w.val} fr:${w.fr}\n`);
}

// Check DSP register state after KON fires
process.stdout.write(`\nDSP registers after run:\n`);
process.stdout.write(`  MVOLl=$${dsp.read(0x0C).toString(16)} MVOLr=$${dsp.read(0x1C).toString(16)}\n`);
process.stdout.write(`  KON=$${dsp.read(0x4C).toString(16)} KOF=$${dsp.read(0x5C).toString(16)}\n`);
process.stdout.write(`  FLG=$${dsp.read(0x6C).toString(16)} ENDX=$${dsp.read(0x7C).toString(16)}\n`);
process.stdout.write(`  DIR=$${dsp.read(0x5D).toString(16)} ESA=$${dsp.read(0x6D).toString(16)}\n`);

// Check voice 0 regs
process.stdout.write(`  V0 VOL_L=$${dsp.read(0x00).toString(16)} VOL_R=$${dsp.read(0x01).toString(16)} PITCH=$${dsp.read(0x02).toString(16)}:$${dsp.read(0x03).toString(16)} SRCN=$${dsp.read(0x04).toString(16)}\n`);

// Check BRR in SPC RAM at DIR*$100 + voice0*4
const dir = dsp.read(0x5D);
const dirBase = dir * 0x100;
process.stdout.write(`  DIR base: $${dirBase.toString(16)}\n`);
process.stdout.write(`  DIR[0] sample start: $${(apu.ram[dirBase]|(apu.ram[dirBase+1]<<8)).toString(16)}\n`);

const apu = snes.apu;
const sampleStart = apu.ram[dirBase] | (apu.ram[dirBase+1] << 8);
process.stdout.write(`  BRR[0] bytes at $${sampleStart.toString(16)}: ${Array.from(apu.ram.slice(sampleStart, sampleStart+9)).map(v=>v.toString(16).padStart(2,'0')).join(' ')}\n`);

// Check if sampleBufferL has any data
let maxL = 0;
for (let i = 0; i < dsp.samplePos; i++) if (Math.abs(dsp.sampleBufferL[i]) > maxL) maxL = Math.abs(dsp.sampleBufferL[i]);
process.stdout.write(`\nsamplePos=${dsp.samplePos} maxL=${maxL.toFixed(4)}\n`);

// Write WAV anyway
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
