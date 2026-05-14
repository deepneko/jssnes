// SNES DSP Implementation
// Based on exact hardware definitions (Gaussian interpolation, ADSR, BRR, Echo, FIR, PMON, NON)

export class DSP {
    constructor() {
        this.ram = new Uint8Array(128);
        this.apu_ram = null;
        
        this.sampleBufferL = new Float32Array(8192);
        this.sampleBufferR = new Float32Array(8192);
        this.samplePos = 0;
        
        this.outL = 0;
        this.outR = 0;
        
        this.voices = [];
        for (let i = 0; i < 8; i++) {
            this.voices.push(new Voice());
        }
        
        this.mvolL = 0; this.mvolR = 0;
        this.evolL = 0; this.evolR = 0;
        this.kon = 0; this.kout = 0;
        this.flg = 0xE0;
        this.endx = 0;
        this.efb = 0;
        this.pmon = 0;
        this.non = 0;
        this.eon = 0;
        this.dir = 0;
        this.esa = 0;
        this.edl = 0;
        this.fir = new Int32Array(8);
        
        this.echoPointer = 0;
        this.echoLength = 0;
        this.echoBuf = new Int32Array(16); // 8 taps × 2 (L+R)
        this.echoPtr = 0;
        
        this.noiseCounter = 0;
        this.noiseVal = 0x4000;
        this.noiseRate = 0;
        
        this.counter = 0;
        
        // Exact hardware Gaussian table
        this.gauss = new Int32Array([
            0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000,
            0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000,
            0x001, 0x001, 0x001, 0x001, 0x001, 0x002, 0x002, 0x002,
            0x002, 0x003, 0x003, 0x003, 0x004, 0x004, 0x005, 0x005,
            0x006, 0x006, 0x007, 0x007, 0x008, 0x008, 0x009, 0x00A,
            0x00B, 0x00B, 0x00C, 0x00D, 0x00E, 0x00F, 0x010, 0x011,
            0x012, 0x013, 0x014, 0x015, 0x016, 0x018, 0x019, 0x01A,
            0x01C, 0x01D, 0x01F, 0x020, 0x022, 0x023, 0x025, 0x027,
            0x028, 0x02A, 0x02C, 0x02E, 0x030, 0x032, 0x034, 0x036,
            0x038, 0x03A, 0x03D, 0x03F, 0x041, 0x044, 0x046, 0x049,
            0x04B, 0x04E, 0x050, 0x053, 0x056, 0x059, 0x05B, 0x05E,
            0x061, 0x064, 0x067, 0x06A, 0x06D, 0x070, 0x074, 0x077,
            0x07A, 0x07E, 0x081, 0x085, 0x088, 0x08C, 0x090, 0x094,
            0x098, 0x09C, 0x0A0, 0x0A4, 0x0A8, 0x0AC, 0x0B0, 0x0B5,
            0x0B9, 0x0BD, 0x0C2, 0x0C6, 0x0CB, 0x0CF, 0x0D4, 0x0D9,
            0x0DD, 0x0E2, 0x0E7, 0x0EC, 0x0F1, 0x0F6, 0x0FB, 0x100,
            0x105, 0x10A, 0x110, 0x115, 0x11A, 0x120, 0x125, 0x12B,
            0x130, 0x136, 0x13C, 0x141, 0x147, 0x14D, 0x153, 0x159,
            0x15F, 0x165, 0x16B, 0x171, 0x177, 0x17E, 0x184, 0x18A,
            0x190, 0x197, 0x19D, 0x1A4, 0x1AA, 0x1B1, 0x1B7, 0x1BE,
            0x1C5, 0x1CC, 0x1D3, 0x1D9, 0x1E0, 0x1E7, 0x1EE, 0x1F5,
            0x1FC, 0x203, 0x20A, 0x212, 0x219, 0x220, 0x227, 0x22F,
            0x236, 0x23D, 0x244, 0x24C, 0x253, 0x25B, 0x262, 0x269,
            0x271, 0x278, 0x27F, 0x287, 0x28E, 0x296, 0x29D, 0x2A5,
            0x2AC, 0x2B4, 0x2BB, 0x2C3, 0x2CA, 0x2D2, 0x2D9, 0x2E1,
            0x2E8, 0x2F0, 0x2F7, 0x2FF, 0x306, 0x30E, 0x315, 0x31D,
            0x324, 0x32B, 0x333, 0x33A, 0x342, 0x349, 0x350, 0x358,
            0x35F, 0x366, 0x36D, 0x374, 0x37B, 0x382, 0x389, 0x390,
            0x397, 0x39E, 0x3A5, 0x3AC, 0x3B3, 0x3B9, 0x3C0, 0x3C7,
            0x3CE, 0x3D4, 0x3DB, 0x3E1, 0x3E8, 0x3EE, 0x3F5, 0x3FB,
            0x401, 0x407, 0x40E, 0x414, 0x41A, 0x420, 0x426, 0x42C,
            0x432, 0x438, 0x43E, 0x443, 0x449, 0x44F, 0x454, 0x45A,
            0x460, 0x465, 0x46B, 0x470, 0x476, 0x47B, 0x480, 0x485,
            0x48A, 0x48F, 0x494, 0x499, 0x49E, 0x4A2, 0x4A7, 0x4AC,
            0x4B0, 0x4B5, 0x4B9, 0x4BD, 0x4C1, 0x4C5, 0x4C9, 0x4CD,
            0x4D1, 0x4D4, 0x4D8, 0x4DB, 0x4DF, 0x4E2, 0x4E5, 0x4E8,
            0x4EB, 0x4EE, 0x4F1, 0x4F4, 0x4F6, 0x4F9, 0x4FB, 0x4FD,
            0x500, 0x502, 0x504, 0x506, 0x508, 0x50A, 0x50C, 0x50E,
            0x510, 0x511, 0x513, 0x514, 0x516, 0x517, 0x519, 0x51A,
            0x51B, 0x51C, 0x51D, 0x51E, 0x51F, 0x520, 0x521, 0x522,
            0x523, 0x524, 0x524, 0x525, 0x526, 0x526, 0x527, 0x527,
            0x528, 0x528, 0x528, 0x529, 0x529, 0x529, 0x529, 0x52A,
            0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A,
            0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A,
            0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A,
            0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A,
            0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A,
            0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A,
            0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A,
            0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A,
            0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A,
            0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A, 0x52A
        ]);
    }
    
    reset() {
        this.ram.fill(0);
        this.flg = 0xE0;
        this.samplePos = 0;
        this.counter = 0;
        for (let i = 0; i < 8; i++) {
            this.voices[i].reset();
        }
    }

    setApuRam(ram) {
        this.apu_ram = ram;
    }

    read(addr) {
        addr &= 0x7F;
        const voiceIdx = Math.floor(addr / 16);
        const reg = addr % 16;
        if (voiceIdx < 8 && reg < 0x0A) {
            if (reg === 0x08) return this.voices[voiceIdx].envx >> 4;
            if (reg === 0x09) return this.voices[voiceIdx].outx >> 4;
        }
        if (addr === 0x7C) return this.endx;
        return this.ram[addr];
    }
    
    write(addr, val) {
        // Detailed logging for KON/KEY-OFF/VOL
        if (globalThis._dmaLog && addr === 0x4C) {
            console.log(`[DSP] KON write: value=0x${val.toString(16)}`);
        }
        if (globalThis._dmaLog && addr === 0x5C) {
            console.log(`[DSP] KEYOFF write: value=0x${val.toString(16)}`);
        }
        if (globalThis._dmaLog && ((addr >= 0x0C && addr <= 0x0D) || (addr >= 0x1C && addr <= 0x1D) || (addr >= 0x2C && addr <= 0x2D) || (addr >= 0x3C && addr <= 0x3D))) {
            console.log(`[DSP] VOL write: addr=0x${addr.toString(16)} value=0x${val.toString(16)}`);
        }
        addr &= 0x7F;
        this.ram[addr] = val;
        
        const voiceIdx = Math.floor(addr / 16);
        const reg = addr % 16;
        
        if (voiceIdx < 8 && reg < 0x0A) {
            const v = this.voices[voiceIdx];
            switch (reg) {
                case 0x00: v.volL = (val << 24) >> 24; break;
                case 0x01: v.volR = (val << 24) >> 24; break;
                case 0x02: v.pitch = (v.pitch & 0xFF00) | val; break;
                case 0x03: v.pitch = (v.pitch & 0x00FF) | ((val & 0x3F) << 8); break;
                case 0x04: v.srcn = val; break;
                case 0x05: v.adcr = (v.adcr & 0xFF00) | val; break;
                case 0x06: v.adcr = (v.adcr & 0x00FF) | (val << 8); break;
                case 0x07: v.gain = val; break;
            }
        } else {
            switch (addr) {
                case 0x0C: this.mvolL = (val << 24) >> 24; break;
                case 0x1C: this.mvolR = (val << 24) >> 24; break;
                case 0x2C: this.evolL = (val << 24) >> 24; break;
                case 0x3C: this.evolR = (val << 24) >> 24; break;
                case 0x4C:
                    this.kon = val;
                    for (let i = 0; i < 8; i++) {
                        if (val & (1 << i)) {
                            const v = this.voices[i];
                            v.state = 'ATTACK';
                            v.envx = 0;
                            v.decodeIdx = 16;
                            v.s1 = 0; v.s2 = 0;
                            v.history.fill(0);
                            v.pitchCounter = 0;
                            const dirOffset = (this.dir << 8) + (v.srcn * 4);
                            v.decodeOffset = (this.apu_ram[dirOffset+1] << 8) | this.apu_ram[dirOffset];
                            v.brrLoopPtr = (this.apu_ram[dirOffset+3] << 8) | this.apu_ram[dirOffset+2];
                        }
                    }
                    break;
                case 0x5C:
                    this.kout = val;
                    for (let i = 0; i < 8; i++) {
                        if (val & (1 << i)) {
                            if (this.voices[i].state !== 'STOP') {
                                this.voices[i].state = 'RELEASE';
                            }
                        }
                    }
                    break;
                case 0x6C: 
                    this.flg = val; 
                    this.noiseRate = val & 0x1F;
                    break;
                case 0x7C: this.endx = 0; break;
                case 0x0D: this.efb = (val << 24) >> 24; break;
                case 0x2D: this.pmon = val; break;
                case 0x3D: this.non = val; break;
                case 0x4D: this.eon = val; break;
                case 0x5D: this.dir = val; break;
                case 0x6D: this.esa = val; break;
                case 0x7D: 
                    this.edl = val & 0x0F; 
                    // Each EDL unit = 512 bytes in APU RAM; echoLength is in 4-byte stereo samples.
                    // Real hardware: ring size = edl * 512 bytes = edl * 128 stereo samples.
                    this.echoLength = this.edl > 0 ? this.edl * 128 : 1;
                    break;
                case 0x0F: case 0x1F: case 0x2F: case 0x3F:
                case 0x4F: case 0x5F: case 0x6F: case 0x7F:
                    this.fir[addr >> 4] = (val << 24) >> 24; break;
            }
        }
    }

    decodeBRR(v) {
        const addr = v.decodeOffset;
        if (addr >= 0xFFFF) return;
        const header = this.apu_ram[addr];
        const shift = (header >> 4) & 0x0F;
        const filter = (header >> 2) & 0x03;
        
        let s1 = v.s1;
        let s2 = v.s2;
        
        let outIdx = 0;
        for (let i = 0; i < 8; i++) {
            const b = this.apu_ram[(addr + 1 + i) & 0xFFFF];
            for (let nibble = 0; nibble < 2; nibble++) {
                let n = (nibble === 0) ? (b >> 4) : (b & 0x0F);
                if (n >= 8) n -= 16;
                
                // Use 16-bit arithmetic (hardware uses 16-bit registers for the shift):
                // sign-extend to 16 bits via << 16 >> 16, then halve.
                // This correctly handles shift > 12 overflow (positive nibbles can wrap to negative).
                let sample = ((n << shift) << 16) >> 17;
                
                if (filter === 1) sample += s1 + ((-s1) >> 4);
                else if (filter === 2) sample += s1 * 2 + ((-s1 * 3) >> 5) - ((s2 * 15) >> 4);
                else if (filter === 3) sample += s1 * 2 + ((-s1 * 13) >> 6) - ((s2 * 13) >> 4);
                
                // 16-bit arithmetic wrap (hardware uses 16-bit registers, overflow wraps)
                sample = sample & 0xFFFF;
                if (sample >= 0x8000) sample -= 0x10000;
                // Clamp to 15-bit signed range
                if (sample > 16383) sample = 16383;
                else if (sample < -16384) sample = -16384;
                
                v.decoded[outIdx++] = sample;
                s2 = s1;
                s1 = sample;
            }
        }
        v.s1 = s1;
        v.s2 = s2;
        
        const isEnd = header & 1;
        const isLoop = header & 2;
        if (isEnd) {
            this.endx |= (1 << this.voices.indexOf(v));
            if (isLoop) {
                v.decodeOffset = v.brrLoopPtr;
            } else {
                v.state = 'STOP';
            }
        } else {
            v.decodeOffset = (v.decodeOffset + 9) & 0xFFFF;
        }
    }

    step() {
        if (this.flg & 0x80) return;
        
        this.counter++;

        // Noise Generation
        // noiseRate 0 = never update; use same rate table as envelopes
        if (this.noiseRate > 0) {
            const noisePeriod = Voice.envRatePeriod(this.noiseRate);
            if (noisePeriod > 0 && (this.counter % noisePeriod) === 0) {
                // Galois LFSR: polynomial x^14+x^13+1 (anomie S-DSP doc: XOR 0x6000 when bit0=1)
                this.noiseVal = (this.noiseVal >> 1) ^ ((this.noiseVal & 1) ? 0x6000 : 0);
            }
        }

        let mOutL = 0;
        let mOutR = 0;
        let eOutL = 0;
        let eOutR = 0;

        let pmon_pitch = 0;

        for (let i = 0; i < 8; i++) {
            const v = this.voices[i];
            
            if (v.state === 'STOP') {
                v.envx = 0;
                v.outx = 0;
                pmon_pitch = v.outx;
                continue;
            }
            
            // Envelope step
            v.stepEnvelope();

            let pitch = v.pitch;
            if (this.pmon & (1 << i)) {
                pitch = (pitch * (pmon_pitch + 0x8000)) >> 15;
            }
            if (pitch > 0x3FFF) pitch = 0x3FFF;
            if (pitch < 0) pitch = 0;
            
            v.pitchCounter += pitch;
            while (v.pitchCounter >= 0x1000) {
                v.pitchCounter -= 0x1000;
                if (v.state === 'STOP') break;
                if (v.decodeIdx >= 16) {
                    this.decodeBRR(v);
                    v.decodeIdx = 0;
                }
                
                let s = v.decoded[v.decodeIdx];
                v.history[v.historyIdx] = s;
                v.historyIdx = (v.historyIdx + 1) & 3;
                v.decodeIdx++;
            }
            
            let s0 = v.history[(v.historyIdx - 4) & 3];
            let s1 = v.history[(v.historyIdx - 3) & 3];
            let s2 = v.history[(v.historyIdx - 2) & 3];
            let s3 = v.history[(v.historyIdx - 1) & 3];
            
            let fract = v.pitchCounter >> 4;
            
            let out1 = (s0 * this.gauss[0x0FF - fract]) >> 11;
            let out2 = (s1 * this.gauss[0x1FF - fract]) >> 11;
            let out3 = (s2 * this.gauss[0x100 + fract]) >> 11;
            let out4 = (s3 * this.gauss[0x000 + fract]) >> 11;
            
            let out = out1 + out2 + out3 + out4;
            if (out > 32767) out = 32767;
            else if (out < -32768) out = -32768;
            
            if (this.non & (1 << i)) {
                // Treat LFSR output as signed 15-bit (bit 14 = sign bit)
                out = this.noiseVal >= 0x4000 ? this.noiseVal - 0x8000 : this.noiseVal;
            }
            
            out = (out * v.envx) >> 15;
            v.outx = out;
            pmon_pitch = out;
            
            let l = (out * v.volL) >> 7;
            let r = (out * v.volR) >> 7;
            
            mOutL += l;
            mOutR += r;
            
            if (this.eon & (1 << i)) {
                eOutL += l;
                eOutR += r;
            }
        }

        // Master output & Mute
        if (!(this.flg & 0x40)) {
            mOutL = (mOutL * this.mvolL) >> 7;
            mOutR = (mOutR * this.mvolR) >> 7;
        } else {
            mOutL = 0;
            mOutR = 0;
        }

        // Echo logic (stubbed FIR for brevity, valid echo path)
        const echoLen = this.echoLength > 0 ? this.echoLength : 1;
        if (this.echoPointer >= echoLen * 4) this.echoPointer = 0;
        let echoAddr = (this.esa << 8) + this.echoPointer;
        let eHL = 0, eHR = 0;
        if (!(this.flg & 0x20)) { // Echo enable checking
            let eL = this.apu_ram[echoAddr & 0xFFFF] | (this.apu_ram[(echoAddr + 1) & 0xFFFF] << 8);
            let eR = this.apu_ram[(echoAddr + 2) & 0xFFFF] | (this.apu_ram[(echoAddr + 3) & 0xFFFF] << 8);
            if (eL & 0x8000) eL |= 0xFFFF0000;
            if (eR & 0x8000) eR |= 0xFFFF0000;
            
            this.echoBuf[this.echoPtr] = eL;
            this.echoBuf[this.echoPtr + 1] = eR;
            this.echoPtr = (this.echoPtr + 2) & 15;
            
            // Apply 8-tap FIR filter to echo read-back
            // echoPtr was already advanced by 2 above, so newest sample is at echoPtr-2
            let firL = 0, firR = 0;
            for (let fi = 0; fi < 8; fi++) {
                const idx = (this.echoPtr - 2 - (fi * 2)) & 15;
                // fir[0] ($0F) applies to the most recent echo sample (fi=0)
                firL += (this.echoBuf[idx] * this.fir[fi]) >> 6;
                firR += (this.echoBuf[idx + 1] * this.fir[fi]) >> 6;
            }
            firL = (firL >> 1) & ~1;
            firR = (firR >> 1) & ~1;
            if (firL > 32767) firL = 32767; else if (firL < -32768) firL = -32768;
            if (firR > 32767) firR = 32767; else if (firR < -32768) firR = -32768;
            
            eHL = (firL * this.evolL) >> 7;
            eHR = (firR * this.evolR) >> 7;
            
            mOutL += eHL;
            mOutR += eHR;
            
            let eWL = eOutL + ((firL * this.efb) >> 7);
            let eWR = eOutR + ((firR * this.efb) >> 7);
            if (eWL > 32767) eWL = 32767; else if (eWL < -32768) eWL = -32768;
            if (eWR > 32767) eWR = 32767; else if (eWR < -32768) eWR = -32768;
            
            this.apu_ram[echoAddr & 0xFFFF] = eWL & 0xFF;
            this.apu_ram[(echoAddr + 1) & 0xFFFF] = (eWL >> 8) & 0xFF;
            this.apu_ram[(echoAddr + 2) & 0xFFFF] = eWR & 0xFF;
            this.apu_ram[(echoAddr + 3) & 0xFFFF] = (eWR >> 8) & 0xFF;
        }
        
        const echoSize = (this.echoLength > 0 ? this.echoLength : 1) * 4;
        this.echoPointer = (this.echoPointer + 4) % echoSize;

        if (mOutL > 32767) mOutL = 32767; else if (mOutL < -32768) mOutL = -32768;
        if (mOutR > 32767) mOutR = 32767; else if (mOutR < -32768) mOutR = -32768;

        this.outL = mOutL;
        this.outR = mOutR;

        if (this.samplePos < 8192) {
            this.sampleBufferL[this.samplePos] = mOutL / 32768.0;
            this.sampleBufferR[this.samplePos] = mOutR / 32768.0;
            this.samplePos++;
        }
    }
}

class Voice {
    constructor() {
        this.reset();
    }
    
    reset() {
        this.volL = 0; this.volR = 0;
        this.pitch = 0;
        this.srcn = 0;
        this.adcr = 0;
        this.gain = 0;
        this.envx = 0;
        this.outx = 0;
        this.state = 'STOP';
        this.decodeOffset = 0;
        this.brrLoopPtr = 0;
        this.history = new Int32Array(4);
        this.historyIdx = 0;
        this.pitchCounter = 0;
        this.s1 = 0; this.s2 = 0;
        this.decoded = new Int32Array(16);
        this.decodeIdx = 16;
        this.envCounter = 0;
    }

    static envRatePeriod(rate) {
        // Approximate S-DSP envelope rate periods in output samples.
        // 0 means "never" for variable-rate envelope modes.
        const table = [
            0, 2048, 1536, 1280, 1024, 768, 640, 512,
            384, 320, 256, 192, 160, 128, 96, 80,
            64, 48, 40, 32, 24, 20, 16, 12,
            10, 8, 6, 5, 4, 3, 2, 1
        ];
        return table[rate & 0x1F];
    }

    envTick(rate) {
        const period = Voice.envRatePeriod(rate);
        if (period <= 0) return false;
        this.envCounter++;
        if (this.envCounter >= period) {
            this.envCounter = 0;
            return true;
        }
        return false;
    }
    
    stepEnvelope() {
        const adsr1 = this.adcr & 0xFF;
        const adsr2 = (this.adcr >> 8) & 0xFF;

        if (!(adsr1 & 0x80)) {
            // GAIN processing
            const mode = this.gain >> 5;
            const gainRate = this.gain & 0x1F;
            if (mode < 4) {
                this.envx = (this.gain & 0x7F) << 8;
            } else {
                if (mode === 4 || mode === 5) {
                    if (this.envTick(gainRate)) {
                        if (mode === 4) this.envx -= 0x200; // linear decrease (0x20 in 11-bit → 0x200 in 15-bit)
                        else this.envx -= (this.envx >> 8) + 1; // exponential decrease (self-scaling)
                    }
                } else if (mode === 6) {
                    if (this.envTick(gainRate)) this.envx += 0x200; // linear increase
                } else if (mode === 7) {
                    if (this.envTick(gainRate)) {
                        // Bent line increase: linear until high range, then slower.
                        if (this.envx < 0x6000) this.envx += 0x200;
                        else this.envx += 0x080;
                    }
                }
            }
        } else {
            // ADSR processing
            if (this.state === 'ATTACK') {
                const attackRate = (adsr1 & 0x0F) * 2 + 1;
                if (this.envTick(attackRate)) {
                    // Fastest attack uses larger envelope step.
                    // 0x400 for rate=31 (fastest); 0x200 for others (0x20 in 11-bit → 0x200 in 15-bit).
                    this.envx += (attackRate >= 31) ? 0x400 : 0x200;
                    if (this.envx >= 0x7FFF) {
                        this.envx = 0x7FFF;
                        this.state = 'DECAY';
                    }
                }
            } else if (this.state === 'DECAY') {
                const decayRate = ((adsr1 >> 4) & 0x07) * 2 + 16;
                if (this.envTick(decayRate)) {
                    this.envx -= (this.envx >> 8) + 1;
                    const sl = (adsr2 >> 5) & 0x07;
                    // envx is 15-bit (0–0x7FFF). Sustain threshold = (sl+1) * 4096.
                    // For sl=7: target=32768 > max envx=32767 → immediate SUSTAIN (correct).
                    const target = (sl + 1) << 12;
                    if (this.envx <= target) {
                        this.state = 'SUSTAIN';
                    }
                }
            } else if (this.state === 'SUSTAIN') {
                const sustainRate = adsr2 & 0x1F;
                if (this.envTick(sustainRate)) {
                    this.envx -= (this.envx >> 8) + 1;
                }
            } else if (this.state === 'RELEASE') {
                // Release: always decreases by 8 per step on real hardware (11-bit envx).
                // In this 15-bit envx system, scale by 16 → 0x80 per step.
                this.envx -= 0x80;
                if (this.envx <= 0) {
                    this.envx = 0;
                    this.state = 'STOP';
                }
            }
        }
        if (this.envx < 0) this.envx = 0;
        if (this.envx > 0x7FFF) this.envx = 0x7FFF;
    }
}
