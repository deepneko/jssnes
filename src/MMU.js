export class MMU {
  constructor() {
    this.wram = new Uint8Array(128 * 1024); // 128KB WRAM
    this.sram = new Uint8Array(128 * 1024); // 128KB SRAM
    this.rom = null;
    this.ppu = null;
    this.apu = null;
    
    // DMA Channels (0-7)
    this.dma = [];
    for (let i = 0; i < 8; i++) {
        this.dma[i] = {
            dmap: 0, // Control
            bbad: 0, // Dest ($21xx)
            a1t: 0,  // Src Addr (16-bit)
            a1b: 0,  // Src Bank
            das: 0,  // Size / Indirect Bank
            dasb: 0, // Indirect Addr (HDMA)
            a2a: 0,  // Line Counter (HDMA)
            ntrl: 0, // Unknown / HDMA related
            
            // HDMA runtime state
            tableAddress: 0,
            tableBank: 0,
            indirectAddress: 0,
            repeat: false,
            doTransfer: false,
            completed: false
        };
    }
    this.mdmaen = 0; // DMA Enable
    this.hdmaen = 0; // HDMA Enable
    this.nmitimen = 0;
    this.rdnmi = 0;
    
    // WRAM Access Registers ($2180 - $2183)
    this.wmaddl = 0; // 16-bit
    this.wmaddh = 0; // 1-bit (17-bit total address)
    
    // Joypads
    this.joy1 = 0;
    this.joy2 = 0;
    this.joy1Str = 0;
    this.joy2Str = 0;
    this.joyStrobe = 0;
    
    // Auto Joypad Read registers
    this.autoJoy = new Uint8Array(8); // 4218-421F
    
    // Hardware Math Registers ($4202 - $4206, $4214 - $4217)
    this.multiplicand = 0; // $4202
    this.multiplier = 0;   // $4203
    this.dividend = 0;     // $4204, $4205
    this.divisor = 0;      // $4206
    this.quotient = 0;     // $4214, $4215
    this.product = 0;      // $4216, $4217 (also used for remainder)
    
    // IRQ Timer Registers
    this.vtime = 0; // Vertical IRQ Timer
    this.htime = 0; // Horizontal IRQ Timer
    this.timeUp = false; // IRQ Flag ($4211.7)
  }

  connectPPU(ppu) {
    this.ppu = ppu;
  }

  connectAPU(apu) {
    this.apu = apu;
  }

  loadRom(buffer) {
    let data = new Uint8Array(buffer);
    if (data.length % 1024 === 512) {
        console.log("SMC Header detected, stripping...");
        data = data.slice(512);
    }
    this.rom = data;
    console.log("ROM loaded, size: " + this.rom.length);
    
    // Improved LoROM vs HiROM Detection
    let loScore = 0;
    let hiScore = 0;
    
    // Check LoROM ($007FC0)
    if (this.rom.length >= 0x8000) {
        // Title Check
        const title = this.rom.slice(0x7FC0, 0x7FC0 + 21);
        loScore += this.checkHeader(title);
        
        // Map Mode Check at $7FD5 (0x20=LoSlow, 0x30=LoFast)
        const mapMode = this.rom[0x7FD5];
        if ((mapMode & ~0x10) === 0x20) loScore += 5;
    }
    
    // Improve Detection with Vector Analysis
    // LoROM Vectors: 0x7FE0-0x7FFF
    // HiROM Vectors: 0xFFE0-0xFFFF
    
    const countValidVectors = (base) => {
        let count = 0;
        // Check NMI (base+10), Reset (base+12), IRQ (base+14)
        for (let i = 4; i < 16; i+=2) {
             const addr = base + i;
             if (addr + 1 >= this.rom.length) continue;
             const vec = this.rom[addr] | (this.rom[addr+1] << 8);
             if (vec > 0x8000 && vec < 0xFFFF) count++;
        }
        return count;
    };
    
    // Check LoROM
    const loVecScore = (this.rom.length >= 0x8000) ? countValidVectors(0x7FE0) : 0;
    // Check HiROM
    const hiVecScore = (this.rom.length >= 0x10000) ? countValidVectors(0xFFE0) : 0;
    
    if (loVecScore > hiVecScore) {
        loScore += 10;
    } else if (hiVecScore > loScore) {
        hiScore += 10;
    }

    // Prefer LoROM if scores are close or undetermined
    this.isHiRom = (hiScore > loScore);
    console.log(`Mapper detection: ${this.isHiRom ? "HiROM" : "LoROM"} (Lo:${loScore} Hi:${hiScore}) [VecScores: ${loVecScore}/${hiVecScore}]`);
    
    // Debug: Check Vectors
    setTimeout(() => {
        const readWord = (addr) => {
            const lo = this.read(addr);
            const hi = this.read((addr + 1) & 0xFFFF); // Wrap in bank 0
            return (hi << 8) | lo;
        };
        
        const nNMI = readWord(0xFFEA);
        const nIRQ = readWord(0xFFEE);
        const eReset = readWord(0xFFFC);
        const eIRQ = readWord(0xFFFE);
        
        console.log(`[MMU] Vectors: Native [NMI:${nNMI.toString(16)} IRQ:${nIRQ.toString(16)}] Emu [Reset:${eReset.toString(16)} IRQ:${eIRQ.toString(16)}]`);
    }, 100);
  }
  
  checkHeader(bytes) {
      if (!bytes) return 0;
      let score = 0;
      for (let i = 0; i < bytes.length; i++) {
          const c = bytes[i];
          if (c >= 0x20 && c <= 0x7E) score++; // Printable ASCII
      }
      return score;
  }

  read(addr) {
    const bank = (addr >> 16) & 0xFF;
    const offset = addr & 0xFFFF;

    // Direct Page / WRAM Mirror (00-3F:0000-1FFF)
    // Applies to both LoROM and HiROM
    if (bank <= 0x3F && offset <= 0x1FFF) {
      return this.wram[offset];
    }
    
    // WRAM (7E-7F) Full access
    if (bank >= 0x7E && bank <= 0x7F) {
        const wramAddr = ((bank & 1) << 16) | offset;
        return this.wram[wramAddr];
    }

    // SRAM
    if (!this.isHiRom) {
        // LoROM SRAM: 70-7D (and F0-FD), 0000-7FFF
        if (((bank >= 0x70 && bank <= 0x7D) || (bank >= 0xF0 && bank <= 0xFD)) && offset <= 0x7FFF) {
             const sramBank = (bank & 0x0F) * 0x8000;
             return this.sram[(sramBank + offset) % this.sram.length];
        }
    } else {
        // HiROM SRAM: 20-3F (and A0-BF), 6000-7FFF
        if (((bank >= 0x20 && bank <= 0x3F) || (bank >= 0xA0 && bank <= 0xBF)) && offset >= 0x6000 && offset <= 0x7FFF) {
             const sramBank = (bank & 0x1F) * 0x2000;
             return this.sram[(sramBank + (offset - 0x6000)) % this.sram.length];
        }
    }

    if (this.rom) {
        let romAddr = -1;
        
        // LoROM Mapping
        if (!this.isHiRom) {
            // Banks 00-7D & 80-FD: 8000-FFFF is ROM
            // (Ignoring 00-3F 0000-7FFF special mappings for now)
            if ((bank & 0x7F) <= 0x7D && offset >= 0x8000) {
                // Map: (Bank & 0x7F) * 32KB + (Offset - 0x8000)
                // Note: Bank 00->00000, 01->08000, 02->10000...
                // Actually Bank / 2 * 64K + Remainder?
                // Standard LoROM:
                // Bank 00: 0000-7FFF (Sys), 8000-FFFF (Rom 00000-07FFF)
                // Bank 01: 0000-7FFF (Sys), 8000-FFFF (Rom 08000-0FFFF)
                romAddr = ((bank & 0x7F) << 15) | (offset & 0x7FFF);
            }
        } 
        // HiROM Mapping
        else {
            // HiROM: Linear map in C0-FF.
            // C0: 0000-FFFF -> Rom 000000-00FFFF
            if (bank >= 0xC0) {
                 romAddr = ((bank & 0x3F) << 16) | offset;
            } else if (bank >= 0x80 && offset >= 0x8000) {
                 // Mirror of C0-FF upper half
                 romAddr = ((bank & 0x3F) << 16) | offset;
            } else if (bank < 0x40 && offset >= 0x8000) {
                 // Mirror of C0-FF upper half
                 romAddr = ((bank & 0x3F) << 16) | offset;
            } else if (bank >= 0x40 && bank <= 0x7D) {
                 // Usually ROM linear?
                 romAddr = ((bank & 0x3F) << 16) | offset;
            }
        }
        
        if (romAddr !== -1 && romAddr < this.rom.length) {
            return this.rom[romAddr];
        }
    }


    // PPU Reigsters / System Area
    // Mirrors: 00-3F and 80-BF
    // Addresses 2000-5FFF are system I/O (PPU, APU, DMA, Registers)
    
    // Check if address is in System Area
    // Condition: Bank is 00-3F or 80-BF AND Offset is 2000-5FFF
    if ((bank & 0x40) === 0 && offset >= 0x2000 && offset <= 0x5FFF) {
        // PPU Registers ($2100-$213F)
        if (offset >= 0x2100 && offset <= 0x213F) {
            return this.ppu ? this.ppu.read(offset) : 0;
        }
        
        // APU Communication ($2140-$2143)
        if (offset >= 0x2140 && offset <= 0x2143) {
            let val = this.apu ? this.apu.read(offset & 3) : 0;
            // console.log(`[MMU] Read $${offset.toString(16)} (APU) = 0x${val.toString(16)}`);
            return val;
        }
        
        // WRAM Data Read ($2180)
        if (offset === 0x2180) {
            // Read from WRAM at WMADD
            // Not implemented yet
            return 0;
        }
        
        // Joypad / IO ($4000-$4017)
        // Joypad Read ($4016/$4017)
        if (offset === 0x4016) {
           const bit = (this.joy1Str >> 15) & 1;
           if (!this.joyStrobe) {
             this.joy1Str = (this.joy1Str << 1) | 1;
           }
           return bit | 0x40;
        }
        if (offset === 0x4017) {
           const bit = (this.joy2Str >> 15) & 1;
           if (!this.joyStrobe) {
             this.joy2Str = (this.joy2Str << 1) | 1;
           }
           return bit | 0x40;
        }

        // Interrupt / DMA Enables ($4200-$420D)
        if (offset === 0x4200) return this.nmitimen; // Usually not readable
        
        // $4210 Reads NMI status
        if (offset === 0x4210) {
            const val = (this.rdnmi & 0x80) | 0x02; 
            this.rdnmi &= 0x7F; 
            return val;
        }

        // TIMEUP ($4211)
        if (offset === 0x4211) {
            const val = (this.timeUp ? 0x80 : 0);
            this.timeUp = false;
            if (this.apu && this.apu.irqPending) {
                 // Clear APU irq line? Usually unrelated.
            }
            // Clear CPU IRQ line (usually happens automatically?
            // Actually, if using level interrupts, clearing the source clears the line.
            // My CPU implementation clears line on taking interrupt.
            // But if interrupt wasn't taken yet (masked by I), clearing this stops it from firing later.
            // So we should signal CPU.
            // However, direct access is tricky. Let's rely on CPU polling checkInterrupts()
            return val;
        }
        
        // HVBJOY ($4212)
        if (offset === 0x4212) {
             if (this.ppu && this.ppu.hvbjoy) return this.ppu.hvbjoy;
             return 0;
        }

        // Math Registers Read ($4214 - $4217)
        if (offset === 0x4214) return this.quotient & 0xFF; // Quotient L
        if (offset === 0x4215) return (this.quotient >> 8) & 0xFF; // Quotient H
        if (offset === 0x4216) return this.product & 0xFF; // Product/Remainder L
        if (offset === 0x4217) return (this.product >> 8) & 0xFF; // Product/Remainder H

        // Auto Joypad Read ($4218-$421F)
        if (offset >= 0x4218 && offset <= 0x421F) {
            return this.autoJoy[offset - 0x4218];
        }

        // DMA Registers ($4300-$437F)
        if (offset >= 0x4300 && offset <= 0x437F) {
            const channel = (offset >> 4) & 0x7;
            const reg = offset & 0xF;
            const d = this.dma[channel];
            switch (reg) {
                case 0: return d.dmap;
                case 1: return d.bbad;
                case 2: return d.a1t & 0xFF;
                case 3: return (d.a1t >> 8) & 0xFF; 
                case 4: return d.a1b;
                case 5: return d.das & 0xFF;
                case 6: return (d.das >> 8) & 0xFF;
                default: return 0xFF;
            }
        }
    }

    return 0; // Open bus
  }

  write(addr, value) {
    const bank = (addr >> 16) & 0xFF;
    const offset = addr & 0xFFFF;

    // Track $9B writes for debugging
    if ((bank <= 0x3F && offset === 0x9B) || (bank === 0x7E && offset === 0x9B)) {
        const fr = globalThis._snesFrame || 0;
        if (fr >= 1) {
            const cpuRef = globalThis._snesCPU;
            const pc = cpuRef ? `${cpuRef.PB.toString(16).padStart(2,'0')}:${cpuRef.PC.toString(16).padStart(4,'0')}` : '??:????';
            console.log(`[$9B WRITE] frame=${fr} val=0x${value.toString(16).padStart(2,'0')} PC=${pc}`);
        }
    }

    // Direct Page / WRAM Mirror (00-3F:0000-1FFF)
    if (bank <= 0x3F && offset <= 0x1FFF) {
        this.wram[offset] = value;
        return;
    }
    // WRAM (7E-7F) Full access
    if (bank >= 0x7E && bank <= 0x7F) {
        const wramAddr = ((bank & 1) << 16) | offset;
        this.wram[wramAddr] = value;
        return;
    }
    
    // SRAM Write
    if (!this.isHiRom) {
        // LoROM SRAM
        if (((bank >= 0x70 && bank <= 0x7D) || (bank >= 0xF0 && bank <= 0xFD)) && offset <= 0x7FFF) {
             const sramBank = (bank & 0x0F) * 0x8000;
             this.sram[(sramBank + offset) % this.sram.length] = value;
             return;
        }
    } else {
        // HiROM SRAM
        if (((bank >= 0x20 && bank <= 0x3F) || (bank >= 0xA0 && bank <= 0xBF)) && offset >= 0x6000 && offset <= 0x7FFF) {
             const sramBank = (bank & 0x1F) * 0x2000;
             this.sram[(sramBank + (offset - 0x6000)) % this.sram.length] = value;
             return;
        }
    }

    // System Area Write (2000-5FFF in Banks 00-3F & 80-BF)
    if ((bank & 0x40) === 0 && offset >= 0x2000 && offset <= 0x5FFF) {
        
        // PPU Registers
        if (offset >= 0x2100 && offset <= 0x213F) {
            if (this.ppu) this.ppu.write(offset, value);
            return;
        }
        
        // APU Communication ($2140-$2143)
        if (offset >= 0x2140 && offset <= 0x2143) {
            if (this.apu) this.apu.write(offset & 3, value);
            // console.log(`[MMU] Write $${offset.toString(16)} (APU) = 0x${value.toString(16)}`);
            return;
        }
        
        // WRAM Access ($2180-$2183)
        if (offset === 0x2180) {
            // WMDATA: Write to WRAM and increment address
            const addr = (this.wmaddh & 1) * 0x10000 + this.wmaddl; // 17-bit address
            this.wram[addr & 0x1FFFF] = value;
            
            // Increment logic (usually 17-bit wrap? SNES wraps at 128KB? or 0000-FFFF?)
            // WRAM is 128KB (0-1FFFF).
            // Increment is usually 17-bit.
            const next = (addr + 1) & 0x1FFFF;
            this.wmaddl = next & 0xFFFF;
            this.wmaddh = (next >> 16) & 1;
            return;
        }
        if (offset === 0x2181) { this.wmaddl = (this.wmaddl & 0xFF00) | value; return; }
        if (offset === 0x2182) { this.wmaddl = (this.wmaddl & 0x00FF) | (value << 8); return; }
        if (offset === 0x2183) { this.wmaddh = value & 1; return; }

        
        // OLD JOYPAD PORTS ($4016)
        if (offset === 0x4016) {
             const strobe = value & 1;
             if (this.joyStrobe === 1 && strobe === 0) {
                 this.joy1Str = this.joy1;
                 this.joy2Str = this.joy2;
             }
             this.joyStrobe = strobe;
             return;
        }

        // Interrupt / NMI Enable ($4200)
        if (offset === 0x4200) {
            // log NMITIMEN 2
            this.nmitimen = value;
            return;
        }
        
        // H/V Timer ($4207-$420A)
        if (offset === 0x4207) { this.htime = (this.htime & 0xFF00) | value; return; }
        if (offset === 0x4208) { this.htime = (this.htime & 0x00FF) | ((value & 1) << 8); return; }
        if (offset === 0x4209) { this.vtime = (this.vtime & 0xFF00) | value; return; }
        if (offset === 0x420A) { this.vtime = (this.vtime & 0x00FF) | ((value & 1) << 8); return; }
        
        // Math Registers Write ($4202 - $4206)
        if (offset === 0x4202) { this.multiplicand = value; return; } // Multiplicand
        if (offset === 0x4203) { // Multiplier -> Execute Multiplication
            this.multiplier = value;
            this.product = this.multiplicand * this.multiplier;
            return;
        }
        if (offset === 0x4204) { this.dividend = (this.dividend & 0xFF00) | value; return; } // Dividend L
        if (offset === 0x4205) { this.dividend = (this.dividend & 0x00FF) | (value << 8); return; } // Dividend H
        if (offset === 0x4206) { // Divisor -> Execute Division
            this.divisor = value;
            if (this.divisor === 0) {
                this.quotient = 0xFFFF; // Divide by zero
                this.product = this.dividend; // Remainder gets dividend
            } else {
                this.quotient = Math.floor(this.dividend / this.divisor) & 0xFFFF;
                this.product = (this.dividend % this.divisor) & 0xFFFF;
            }
            return;
        }
        
        // DMA / HDMA Enable
        if (offset === 0x420B) { // MDMAEN
            this.mdmaen = value;
            this.executeDMA();
            return;
        }
        if (offset === 0x420C) { // HDMAEN
            this.hdmaen = value;
            return;
        }
        
        // DMA Registers ($4300-$437F)
        if (offset >= 0x4300 && offset <= 0x437F) {
            const channel = (offset >> 4) & 0x7;
            const reg = offset & 0xF;
            const d = this.dma[channel];
            switch (reg) {
                case 0: d.dmap = value; break;
                case 1: d.bbad = value; break;
                case 2: d.a1t = (d.a1t & 0xFF00) | value; break;
                case 3: d.a1t = (d.a1t & 0x00FF) | (value << 8); break;
                case 4: d.a1b = value; break;
                case 5: d.das = (d.das & 0xFF00) | value; break;
                case 6: d.das = (d.das & 0x00FF) | (value << 8); break;
                case 7: d.dasb = value; break; 
                case 8: d.a2a = (d.a2a & 0xFF00) | value; break;
                case 9: d.a2a = (d.a2a & 0x00FF) | (value << 8); break;
            }
            return; 
        }
    }
  }

  executeDMA() {
      for (let i = 0; i < 8; i++) {
          if (this.mdmaen & (1 << i)) {
              this.doDMA(i);
              this.mdmaen &= ~(1 << i); 
          }
      }
  }

  doDMA(ch) {
      const d = this.dma[ch];
      let srcBank = d.bbad; // Wait, bbad is dest ($21xx). a1b is src bank.
      // Re-read structure:
      // bbad: Dest ($21xx)
      // a1t: Src Addr (16-bit)
      // a1b: Src Bank
      
      let workSrcBank = d.a1b;
      let workSrcAddr = d.a1t;
      const destBase = 0x2100 | d.bbad;
      
      const mode = d.dmap & 0x07; // Transfer Mode
      const fixed = (d.dmap & 0x10) !== 0; // Fixed Source Address? No, Bit 4 is Fixed?
      // Bit 3: Unused / Repeat?
      // Bit 4: Decrement/Increment? Wait.
      // 7: Direction (0=A->B, 1=B->A)
      // 6: HDMA Indirect
      // 5: Unused?
      // 4: Decrement (if 1)
      // 3: Fixed (if 1)
      
      const direction = (d.dmap & 0x80) !== 0; 
      const dec = (d.dmap & 0x10) !== 0; // Check docs: Bit 4 is Decrement (usually bit 4 is decrement A-Bus addr?)
      // Actually: 
      // 7: Transfer Direction
      // 6: Addressing Mode (HDMA) / Unused (DMA)
      // 5: Unused?
      // 4: Increment/Decrement (0=Inc, 1=Dec) IF Fixed is 0
      // 3: Fixed (0=Adjust, 1=Fixed)
      
      // Let's re-verify bits. SNES Dev manuals:
      // Bit 7: Direction (0: CPU->PPU, 1: PPU->CPU)
      // Bit 6: HDMA Addressing (0: Direct, 1: Indirect)
      // Bit 5: Unused
      // Bit 4: A-Bus Step (0: Increment, 1: Decrement)
      // Bit 3: A-Bus Fixed (0: Not Fixed, 1: Fixed)
      // Bit 2-0: Transfer Mode
      
      const stepDec = (d.dmap & 0x10) !== 0;
      const stepFixed = (d.dmap & 0x08) !== 0;
      
      let count = d.das; // Size
      if (count === 0) count = 0x10000;
      
      // console.log(`DMA Ch${ch} Mode${mode} Addr ${d.a1b.toString(16)}:${d.a1t.toString(16)} -> 21${d.bbad.toString(16).padStart(2,'0')} Size ${count}`);
      
      // Transfer loop
      let stepBytes = 1;
      let pattern = [0];
      
      // console.log(`[MMU] DMA Ch${ch} Mode${mode} ${direction?'Rd':'Wr'} Addr ${workSrcBank.toString(16).padStart(2,'0')}:${workSrcAddr.toString(16).padStart(4,'0')} -> 21${d.bbad.toString(16).padStart(2,'0')} Size ${count}`);
      
      switch(mode) {
          case 0: pattern = [0]; break;
          case 1: pattern = [0, 1]; break;
          case 2: pattern = [0, 0]; break;
          case 3: pattern = [0, 0, 1, 1]; break;
          case 4: pattern = [0, 1, 2, 3]; break;
          case 5: pattern = [0, 1, 0, 1]; break;
          default: pattern = [0]; break; // Fallback
      }
      
      let pIdx = 0;
      
      while (count > 0) {
          if (!direction) { // Mem (A) -> PPU (B)
             // Read byte from A-Bus
             const val = this.read((workSrcBank << 16) | workSrcAddr);
             
             // Write to PPU B-Bus
             // Calculate Dest Register based on pattern
             const offset = pattern[pIdx];
             this.write(destBase + offset, val);
             
             pIdx = (pIdx + 1) % pattern.length;
          } else {
             // PPU (B) -> Mem (A) - Read Not implemented fully usually
             // Just skip for now or read 0
          }
           
          if (!stepFixed) {
              if (!stepDec) workSrcAddr = (workSrcAddr + 1) & 0xFFFF;
              else workSrcAddr = (workSrcAddr - 1) & 0xFFFF;
          }
          
          count--;
      }
      
      d.das = 0; // Register update (becomes 0 after transfer)
      d.a1t = workSrcAddr; // Address updates
  }

  initHDMA() {
      for (let i = 0; i < 8; i++) {
          if (this.hdmaen & (1 << i)) {
              const d = this.dma[i];
              d.tableAddress = d.a1t;
              d.tableBank = d.a1b;
              
              d.a2a = this.read((d.tableBank << 16) | d.tableAddress);
              d.tableAddress++;
              
              d.repeat = (d.a2a & 0x80) !== 0;
              d.a2a &= 0x7F;
              d.completed = (d.a2a === 0);
              
              if ((i === 6 || i === 7) && globalThis.snesFrame === 858) {
                  console.log(`[HDMA INIT] Ch ${i} repeat: ${d.repeat}, a2a: ${d.a2a}`);
              }

              const indirect = (d.dmap >> 6) & 1;
              if (indirect === 1 && !d.completed) {
                  const lo = this.read((d.tableBank << 16) | d.tableAddress);
                  d.tableAddress++;
                  const hi = this.read((d.tableBank << 16) | d.tableAddress);
                  d.tableAddress++;
                  d.indirectAddress = (hi << 8) | lo;
              }
              d.doTransfer = true;
          }
      }
  }

  doHDMA() {
      for (let i = 0; i < 8; i++) {
          if (this.hdmaen & (1 << i)) {
              const d = this.dma[i];
              if (d.completed) continue;
              
              const mode = d.dmap & 7;
              const indirect = (d.dmap >> 6) & 1;
              
              if (d.doTransfer) {
                  let pattern;
                  switch(mode) {
                      case 0: pattern = [0]; break;
                      case 1: pattern = [0, 1]; break;
                      case 2: pattern = [0, 0]; break;
                      case 3: pattern = [0, 0, 1, 1]; break;
                      case 4: pattern = [0, 1, 2, 3]; break;
                      case 5: pattern = [0, 1, 0, 1]; break;
                      default: pattern = [0]; break;
                  }
                  
                  const destBase = 0x2100 | d.bbad;
                  for (let pOffset of pattern) {
                      let val;
                      if (indirect === 0) {
                          val = this.read((d.tableBank << 16) | d.tableAddress);
                          d.tableAddress++;
                      } else {
                          val = this.read((d.dasb << 16) | d.indirectAddress);
                          d.indirectAddress++;
                      }
                      this.write(destBase + pOffset, val);
                  }
              }
              
              d.a2a--;
              
              if (d.a2a === 0) {
                  d.a2a = this.read((d.tableBank << 16) | d.tableAddress);
                  d.tableAddress++;
                  
                  d.repeat = (d.a2a & 0x80) !== 0;
                  d.a2a &= 0x7F;
                  if (d.a2a === 0) {
                      d.completed = true;
                  } else {
                      if (indirect === 1) {
                          const lo = this.read((d.tableBank << 16) | d.tableAddress);
                          d.tableAddress++;
                          const hi = this.read((d.tableBank << 16) | d.tableAddress);
                          d.tableAddress++;
                          d.indirectAddress = (hi << 8) | lo;
                      }
                      d.doTransfer = true;
                  }
              } else {
                  d.doTransfer = d.repeat;
              }
          }
      }
  }

  readWord(addr) {
    const lo = this.read(addr);
    const hi = this.read((addr + 1) & 0xFFFFFF); // Auto-wrap? simplified
    return (hi << 8) | lo;
  }

  writeWord(addr, value) {
    this.write(addr, value & 0xFF);
    this.write((addr + 1) & 0xFFFFFF, (value >> 8) & 0xFF);
  }
}
