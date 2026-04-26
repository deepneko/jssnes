import { CPU } from './CPU.js';
import { PPU } from './PPU.js';
import { APU } from './APU.js';
import { MMU } from './MMU.js';

export class SNES {
  constructor() {
    this.mmu = new MMU();
    this.cpu = new CPU(this.mmu);
    this.ppu = new PPU();
    this.apu = new APU();

    // Connect components
    this.mmu.connectPPU(this.ppu);
    this.mmu.connectAPU(this.apu);
  }

  loadRom(buffer) {
    this.mmu.loadRom(buffer);
    this.reset();
  }

  reset() {
    if (this.apu) this.apu.reset(); // Reset APU FIRST
    if (this.ppu) this.ppu.reset();
    this.cpu.reset(); // Then CPU starts execution
    
    // Register MMU globally for APU hacks
    globalThis._snesMMU = this.mmu;
  }

  getAudioSamples() {
      if (!this.apu || !this.apu.dsp) return null;
      const dsp = this.apu.dsp;
      const length = dsp.samplePos;
      if (length === 0) return null;
      
      const left = new Float32Array(dsp.sampleBufferL.buffer, 0, length);
      const right = new Float32Array(dsp.sampleBufferR.buffer, 0, length);
      
      // Make copies so DSP can keep writing
      const lCopy = new Float32Array(left);
      const rCopy = new Float32Array(right);
      
      dsp.samplePos = 0;
      return { left: lCopy, right: rCopy };
  }

  frame() {
    if (this.frameCount === undefined) this.frameCount = 0;
    this.frameCount++;
    globalThis._snesFrame = this.frameCount;
    globalThis._snesCPU = this.cpu;
    const scanlinesPerFrame = 262;
    const cyclesPerScanline = Math.floor(1364 / 6); // ~227: SNES CPU ~3.58MHz, 1364 master clocks/line
    
    // Total simplified frame loop
    for (let line = 0; line < scanlinesPerFrame; line++) { this.line = line;
        // VBlank Start (Line 225)
        if (line === 225) {
            this.mmu.rdnmi |= 0x80; // Set VBlank Flag
            if (this.mmu.nmitimen & 0x80) { // NMI Enabled
                this.cpu.nmiPending = true;
            }
        }
        
        // Clear VBlank bit at Line 0
        if (line === 0) {
            this.mmu.rdnmi &= 0x7F; // Clear VBlank Flag
            this.ppu.field = (this.ppu.field + 1) & 1; // Toggle field
            if (this.mmu.hdmaen) this.mmu.initHDMA();
        }
        
        // Update HVBJOY ($4212)
        // Bit 7: VBlank, Bit 0: Auto-Joypad Status
        let hvbjoy = 0;
        if (line >= 225) hvbjoy |= 0x80;
        
        // Auto-Joypad Reading (Scanlines 225-227 roughly)
        // Always copy at VBlank so it's ready, actual hardware delays it 3 scanlines
        if (line === 225) {
            hvbjoy |= 1;
        }
        if (line >= 225 && line <= 227 && (this.mmu.nmitimen & 1)) {
            hvbjoy |= 1; // Busy
            // Actually perform the read at start of 225
            if (line === 225) {
                // Copy joypad states to auto registers $4218-$421F
                // Joy1 (16 bits) -> 4218, 4219
                const j1 = this.mmu.joy1;
                this.mmu.autoJoy[0] = j1 & 0xFF;
                this.mmu.autoJoy[1] = (j1 >> 8) & 0xFF;
                // Joy2
                const j2 = this.mmu.joy2;
                this.mmu.autoJoy[2] = j2 & 0xFF;
                this.mmu.autoJoy[3] = (j2 >> 8) & 0xFF;
                // Joy3/4 (if multitap) - assume 0
                this.mmu.autoJoy[4] = 0;
                this.mmu.autoJoy[5] = 0;
                this.mmu.autoJoy[6] = 0;
                this.mmu.autoJoy[7] = 0;
            }
        }
        
        // Execute CPU instructions for one scanline duration
        let lineCycles = 0;
        let irqFired = false;
        const irqMode = this.mmu.nmitimen & 0x30;
        
        while (lineCycles < cyclesPerScanline) {
            // Check IRQ
            if (!irqFired && irqMode) {
                const dots = lineCycles * 1.5;
                if (irqMode === 0x30) {
                    if (line === this.mmu.vtime && dots >= this.mmu.htime) {
                        this.mmu.timeUp = true;
                        this.cpu.irqPending = true;
                        irqFired = true;
                    }
                } else if (irqMode === 0x20) {
                    if (line === this.mmu.vtime && dots >= 0) { // Fires early on line
                        this.mmu.timeUp = true;
                        this.cpu.irqPending = true;
                        irqFired = true;
                    }
                } else if (irqMode === 0x10) {
                    if (dots >= this.mmu.htime) {
                        this.mmu.timeUp = true;
                        this.cpu.irqPending = true;
                        irqFired = true;
                    }
                }
            }

            // HBlank starts around cycle 1096 of 1364 (137 of 170)
            if (lineCycles >= 137) {
                if (this.ppu) this.ppu.hvbjoy = hvbjoy | 0x40; // Set HBlank
            } else {
                if (this.ppu) this.ppu.hvbjoy = hvbjoy & ~0x40; // Clear HBlank
            }
            const cyclesTaken = this.cpu.step();
            lineCycles += cyclesTaken;

            if (this.ppu) {
                this.ppu.vcounter = line;
                this.ppu.hcounter = Math.floor(lineCycles * (1364 / cyclesPerScanline));
            }
        }

        // Step APU at fixed rate: ~65 SPC700 cycles/scanline (1.024MHz / (262 lines × 60.1fps))
        // This decouples APU from CPU so block moves (MVN/MVP) don't over-clock audio.
        if (this.apu) {
            if (this.apuScanlineTarget === undefined) this.apuScanlineTarget = 0;
            this.apuScanlineTarget += 65;
            while (this.apuScanlineTarget > this.apu.cycles) {
                this.apu.step();
            }
        }

        // Emulate HDMA before rendering the scanline
        if (line < 225 && this.mmu.hdmaen) {
            this.mmu.doHDMA();
        }

        // Render visible lines
        if (line < 224) {
            this.ppu.renderLine(line);
        }
    }

    // Debug: track WRAM[$9A] (CGADSUB shadow) changes near triforce scene
    const w9a = this.mmu.wram[0x9a];
    if (this._prev9A === undefined) this._prev9A = w9a;
    if (w9a !== this._prev9A) {
        // console.log(`[Frame ${this.frameCount}] $9A changed: ...`);
        this._prev9A = w9a;
    }
  }
}
