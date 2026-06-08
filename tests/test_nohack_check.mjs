// Quick A/B test: with _enableHacks=false (default), check Mario + RMX
// for KON events, port handshake progress, and DSP output level.
import { SNES } from '../src/SNES.js';
import { readFileSync, writeFileSync } from 'fs';

function check(romPath, name, frames) {
    const snes = new SNES();
    snes.loadRom(readFileSync(romPath));
    console.log = () => {};
    const apu = snes.apu;
    let konCount = 0;
    let lastF2 = 0;
    const origWrite = apu.write.bind(apu);
    apu.write = function(addr, val) {
        if (addr === 0xF2) lastF2 = val;
        if (addr === 0xF3 && (lastF2 & 0x7F) === 0x4C && val !== 0) konCount++;
        return origWrite(addr, val);
    };
    // Resize DSP buffers
    const SR = 32000;
    apu.dsp.sampleBufferL = new Float32Array(SR * frames / 60 + SR);
    apu.dsp.sampleBufferR = new Float32Array(SR * frames / 60 + SR);
    apu.dsp.samplePos = 0;

    for (let f=0; f<frames; f++) {
        globalThis._snesFrame = f;
        snes.frame();
    }
    // Compute max abs
    let maxL = 0, sumSq = 0, nz = 0;
    const buf = apu.dsp.sampleBufferL;
    const n = apu.dsp.samplePos;
    for (let i=0; i<n; i++) {
        const v = Math.abs(buf[i]);
        if (v > maxL) maxL = v;
        sumSq += buf[i]*buf[i];
        if (v > 0.001) nz++;
    }
    const rms = Math.sqrt(sumSq / Math.max(1,n));
    process.stdout.write(`${name}: KON=${konCount} maxL=${maxL.toFixed(4)} rms=${rms.toFixed(4)} nonZero=${nz}/${n}\n`);
    process.stdout.write(`  apuPorts=[${Array.from(apu.apuPorts).map(v=>'$'+v.toString(16)).join(',')}] `);
    process.stdout.write(`cpuPorts=[${Array.from(apu.cpuPorts).map(v=>'$'+v.toString(16)).join(',')}]\n`);
    process.stdout.write(`  SPC PC=$${apu.PC.toString(16)} (${apu.PC >= 0xFFC0 ? 'IPL' : 'NSPC'}) ` +
                        `_nspcStarted=${apu._nspcStarted} _frameSyncReady=${apu._frameSyncReady}\n`);
}

process.stdout.write('=== Hacks DISABLED (_enableHacks=false default) ===\n');
check('./rom/super_mario_world.smc', 'Mario  ', 600);
check('./rom/rockmanx.sfc',          'RMX    ', 400);
