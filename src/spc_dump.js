// Serialize current APU state to an SPC file (SPC700 v0.30 format).
// Returns a Uint8Array of length 66048.
//   0x00-0x21 magic
//   0x23      version (0x1E)
//   0x25-0x26 PC LE
//   0x27-0x2B A,X,Y,PSW,SP
//   0x100-0x100FF  RAM (64KB)
//   0x10100-0x1017F DSP regs (128)
//   0x101C0-0x101FF IPL ROM
export function dumpSpc(apu) {
    const buf = new Uint8Array(0x10200);
    const magic = 'SNES-SPC700 Sound File Data v0.30';
    for (let i = 0; i < magic.length; i++) buf[i] = magic.charCodeAt(i);
    buf[0x21] = 0x1A; buf[0x22] = 0x1A;
    buf[0x23] = 0x1E;
    buf[0x25] = apu.PC & 0xFF;
    buf[0x26] = (apu.PC >> 8) & 0xFF;
    buf[0x27] = apu.A & 0xFF;
    buf[0x28] = apu.X & 0xFF;
    buf[0x29] = apu.Y & 0xFF;
    buf[0x2A] = apu.PSW & 0xFF;
    buf[0x2B] = apu.SP & 0xFF;
    // RAM: copy APU RAM image but overlay IO regs ($F4-$F7) with current cpuPorts
    // (which is the SPC's view of the input ports).
    for (let i = 0; i < 0x10000; i++) buf[0x100 + i] = apu.ram[i];
    buf[0x100 + 0xF0] = apu.testReg & 0xFF;
    buf[0x100 + 0xF1] = apu.control & 0xFF;
    buf[0x100 + 0xF2] = apu.dspAddr & 0xFF;
    buf[0x100 + 0xF4] = apu.cpuPorts[0];
    buf[0x100 + 0xF5] = apu.cpuPorts[1];
    buf[0x100 + 0xF6] = apu.cpuPorts[2];
    buf[0x100 + 0xF7] = apu.cpuPorts[3];
    buf[0x100 + 0xFA] = apu.timerTargets[0];
    buf[0x100 + 0xFB] = apu.timerTargets[1];
    buf[0x100 + 0xFC] = apu.timerTargets[2];
    // DSP regs
    for (let i = 0; i < 128; i++) buf[0x10100 + i] = apu.dsp.ram[i];
    // IPL ROM
    for (let i = 0; i < 64; i++) buf[0x101C0 + i] = apu.bootRom[i];
    return buf;
}
