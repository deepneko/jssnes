
export class PPU {
  constructor() {
    this.vram = new Uint8Array(64 * 1024); // 64KB VRAM
    this.oam = new Uint8Array(544); // Object Attribute Memory
    this.cgram = new Uint8Array(512); // Color Generator RAM

    // Framebuffer (256x224, 32-bit RGBA) - Little Endian (ABGR)
    this.frameBuffer = new Uint32Array(256 * 224);
    
    // Line Buffers
    this.zBuffer = new Uint8Array(256);
    this.layerBuffer = new Uint8Array(256); // 0=Backdrop, 1=BG1, 2=BG2, 3=BG3, 4=BG4, 5=OBJ
    this.objBuffer = new Uint32Array(256); // Stores Sprite Color (0 = transparent)
    this.objPrioBuffer = new Uint8Array(256); // Stores Sprite Priority (0-3)
    this.objPalHighBuffer = new Uint8Array(256); // 1 = OBJ palette 4-7 (color-math eligible), 0 = palette 0-3

    // Registers
    this.inidisp = 0x8F; // Display Control 1 (Forced Blank on reset)
    this.obsel = 0;   // Object Size and Character Size
    this.oamaddl = 0; // OAM Address Low
    this.oamaddh = 0; // OAM Address High
    this.oamAddr = 0; // Internal OAM Byte Address (10-bit)
    this.bgmode = 0;  // BG Mode and Tile Size
    this.mosaic = 0;  // Mosaic
    
    // BG Screen Base and Sc Size ($2107-$210A)
    this.bg1sc = 0; this.bg2sc = 0; this.bg3sc = 0; this.bg4sc = 0;
    // BG Character Address ($210B-$210C)
    this.bg12nba = 0; this.bg34nba = 0;

    // Scroll Registers ($210D-$2114) - Write twice mechanism
    this.bg1hofs = 0; this.bg1vofs = 0;
    this.bg2hofs = 0; this.bg2vofs = 0;
    this.bg3hofs = 0; this.bg3vofs = 0;
    this.bg4hofs = 0; this.bg4vofs = 0;
    this.m7hofs = 0;  this.m7vofs = 0; // Mode 7
    
    // Internal latch for double-byte writes (Scroll, VRAM addr)
    this.bg_latch = 0; 
    
    // Mode 7 Registers
    this.m7_latch = 0;
    this.m7a = 0; this.m7b = 0; this.m7c = 0; this.m7d = 0;
    this.m7x = 0; this.m7y = 0;
    this.m7sel = 0;
    
    // VRAM Address
    this.vmain = 0; // VRAM Address Increment Mode
    this.vmaddl = 0;
    this.vmaddh = 0;
    this.vramAddr = 0; // Internal full address
    this.vramReadBuffer = 0;

    // CGRAM Address
    this.cgadd = 0;
    this.cgdata_latch = null; // Write twice byte
    
    // OAM Latch
    this.oamWriteRegister = 0;
    this.oamFlip = 0;
    this.oamReadFlip = 0;

    // Window / Color Math (Simplified, placeholders)
    this.w12sel = 0; this.w34sel = 0; this.wobjsel = 0;
    this.wh0 = 0; this.wh1 = 0; this.wh2 = 0; this.wh3 = 0;
    this.wbglog = 0; this.wobjlog = 0;
    this.tm = 0; this.ts = 0; // Main/Sub screen designation
    this.cgwsel = 0;
    this.tmw = 0;
    this.tsw = 0; this.cgadsub = 0;
    this.coldataR = 0; this.coldataG = 0; this.coldataB = 0;
    
    // Status
    this.hvbjoy = 0; // V-Blank, H-Blank etc
    this.stat77 = 0; // PPU1 Status
    this.stat78 = 0; // PPU2 Status (Interlace)
    this.field = 0;  // 0 or 1
    
    this.debugLogged = false;
  }
  
  dumpDebugInfo() {
      if (this.debugLogged) return;
      this.debugLogged = true;
      
      let out = "";
      const log = (msg) => { out += msg + "\n"; };
      
      log("========== START PPU DEBUG DUMP ==========");
      log(`Line: 100`);
      log(`OBSEL: 0x${this.obsel.toString(16)} (BaseBits: ${this.obsel & 7}, SizeBits: ${this.obsel >> 5})`);
      log(`BGMode: ${this.bgmode & 7}`);
      log(`BG1SC: 0x${this.bg1sc.toString(16)}, BG2SC: 0x${this.bg2sc.toString(16)}`);
      log(`BG12NBA: 0x${this.bg12nba.toString(16)} (BG1: ${this.bg12nba & 0xF}, BG2: ${this.bg12nba >> 4})`);
      log(`TM (MainScreen): 0x${this.tm.toString(16)}`);
      
      log("--- OAM DUMP (First 16 Sprites) ---");
      for (let i = 0; i < 16; i++) {
          const addr = i * 4;
          const x = this.oam[addr];
          const y = this.oam[addr + 1];
          const tile = this.oam[addr + 2];
          const attr = this.oam[addr + 3];
          // High table bit
          const hiByte = this.oam[512 + (i >> 2)];
          const shift = (i & 3) * 2;
          const xHi = (hiByte >> shift) & 1;
          const size = (hiByte >> (shift + 1)) & 1;
          
          const finalX = x | (xHi << 8);
          log(`Sprite ${i}: X=${finalX}(${xHi?'+256':''}) Y=${y} Tile=${tile.toString(16)} Attr=${attr.toString(16)} Size=${size?'Large':'Small'}`);
      }
      
    const spriteBaseAddr = (this.obsel & 7) << 13;
    const currentLogicBase = spriteBaseAddr;
      
      log(`--- VRAM DUMP (At Sprite Base: 0x${currentLogicBase.toString(16)}) ---`);
      let vramStr = "";
      for (let i = 0; i < 64; i++) {
          vramStr += this.vram[currentLogicBase + i].toString(16).padStart(2, '0') + " ";
          if ((i + 1) % 16 === 0) vramStr += "\n";
      }
      log(vramStr);
      log("========== END PPU DEBUG DUMP ==========");
      
      // Render to Screen
      if (typeof document === 'undefined') return;
      let container = document.getElementById('debug-overlay');
      if (!container) {
          container = document.createElement('div');
          container.id = 'debug-overlay';
          container.style.cssText = "position: absolute; top: 250px; left: 10px; background: rgba(0,0,0,0.9); color: #0f0; font-family: monospace; white-space: pre; padding: 10px; z-index: 9999; border: 1px solid #0f0; max-height: 500px; overflow: auto;";
          document.body.appendChild(container);
      }
      container.textContent = out;
  }

  reset() {
      this.inidisp = 0x8F;
      this.vram.fill(0);
      this.oam.fill(0);
      this.cgram.fill(0);
      this.oamaddl = 0;
      this.oamaddh = 0;
      this.oamAddr = 0;
      this.oamWriteRegister = 0;
      this.oamFlip = 0;
      this.oamReadFlip = 0;
      this.stat77 = 0;
      this.stat78 = 0;
      this.field = 0;
  }

  multiplyResult() {
      const a = (this.m7a << 16) >> 16; // 16-bit signed
      const bSigned = ((this.m7b >> 8) << 24) >> 24; // upper 8-bits signed
      return a * bSigned;
  }

  read(addr) {
    // PPU Read ($2134-$213F mostly)
    switch(addr) {
        case 0x2134: return this.multiplyResult() & 0xFF; // MPY L
        case 0x2135: return (this.multiplyResult() >> 8) & 0xFF; // MPY M
        case 0x2136: return (this.multiplyResult() >> 16) & 0xFF; // MPY H  
        case 0x2137: // SLHV (Software Latch)
            this.latchH = this.hcounter || 0;
            this.latchV = this.vcounter || 0;
            this.countersLatched = true;
            return 0; // return open bus or last read value
        case 0x2138:
            {
                let byte;
                if (this.oamAddr & 0x100) {
                    const addr = (((this.oamAddr & 0x10f) << 1) + (this.oamReadFlip & 1)) & 0x21f;
                    byte = this.oam[addr];
                    if (this.oamReadFlip & 1) {
                        this.oamAddr = (this.oamAddr + 1) & 0x1ff;
                    }
                } else {
                    const addr = ((this.oamAddr << 1) + (this.oamReadFlip & 1)) & 0x1ff;
                    byte = this.oam[addr];
                    if (this.oamReadFlip & 1) {
                        this.oamAddr = (this.oamAddr + 1) & 0x1ff;
                    }
                }
                this.oamReadFlip ^= 1;
                return byte;
            }
        case 0x2139: // VMDATALRead
           {
               const val = this.vramReadBuffer & 0xFF;
               if ((this.vmain & 0x80) === 0) {
                   this.incVramAddr();
                   this.updateVramRead(); 
               }
               return val;
           }
        case 0x213A: // VMDATAHRead
           {
               const val = (this.vramReadBuffer >> 8) & 0xFF;
               if ((this.vmain & 0x80) !== 0) {
                   this.incVramAddr();
                   this.updateVramRead();
               }
               return val;
           }
        case 0x213B: // CGDATA Read
           // Simplified: return 0 or implement palette read
           return 0;
        case 0x213C: { // OPHCT (Latched HCounter)
            if (this.ophctFlip) {
                this.ophctFlip = false;
                return ((this.latchH >> 8) & 0x01) | 0; // open bus bits 1-7
            } else {
                this.ophctFlip = true;
                return this.latchH & 0xFF;
            }
        }
        case 0x213D: { // OPVCT (Latched VCounter)
            if (this.opvctFlip) {
                this.opvctFlip = false;
                return ((this.latchV >> 8) & 0x01) | 0; // open bus bits 1-7
            } else {
                this.opvctFlip = true;
                return this.latchV & 0xFF;
            }
        }
        case 0x213E: return 1; // PPU1 Status (5=Over, 6=TimeOver, 7=AxB) - always 1 (v 0001) for revision
        case 0x213F: 
           {
               // PPU2 Status
               // Bit 7: Field (0 or 1)
               // Bit 6: External Latch Flag
               // Bit 0-3: Version (usually 2 or 3)
               let latchFlag = this.countersLatched ? 0x40 : 0;
               const val = (this.field ? 0x80 : 0) | latchFlag | 0x03; // Revision 3
               
               // Reset latch word flip-flops
               this.ophctFlip = false;
               this.opvctFlip = false;
               this.countersLatched = false;
               return val;
           }
        default: return 0;
    }
  }

  write(addr, value) {
    switch (addr) {
        case 0x2100:
            this.inidisp = value;
            break;
        case 0x2101: this.obsel = value; break;
        case 0x2102: 
            this.oamaddl = value; 
            // Update internal OAM address (Word -> Byte)
            this.oamAddr = ((this.oamaddh & 1) << 8) | this.oamaddl; 
            this.oamFlip = 0;
            this.oamReadFlip = 0;
            break;
        case 0x2103: 
            this.oamaddh = value & 1; 
            // Update internal OAM address (Word -> Byte)
            this.oamAddr = ((this.oamaddh & 1) << 8) | this.oamaddl;
            this.oamFlip = 0;
            this.oamReadFlip = 0;
            break;
        // OAMDATA ($2104)
        case 0x2104:
            if ((this.oamFlip & 1) === 0) {
                this.oamWriteRegister = (this.oamWriteRegister & 0xff00) | value;
            }

            if (this.oamAddr & 0x100) {
                const addr = (((this.oamAddr & 0x10f) << 1) + (this.oamFlip & 1)) & 0x21f;
                this.oam[addr] = value;
                if (this.oamFlip & 1) {
                    this.oamAddr = (this.oamAddr + 1) & 0x1ff;
                }
            } else if (this.oamFlip & 1) {
                const addr = (this.oamAddr << 1) & 0x1ff;
                this.oam[addr] = this.oamWriteRegister & 0xff;
                this.oam[addr + 1] = value;
                this.oamAddr = (this.oamAddr + 1) & 0x1ff;
            }

            this.oamFlip ^= 1;
            break;

        case 0x2105: this.bgmode = value; break;
        case 0x2106: this.mosaic = value; break;
        
        case 0x2107: this.bg1sc = value; break;
        case 0x2108: this.bg2sc = value; break;
        case 0x2109: this.bg3sc = value; break;
        case 0x210A: this.bg4sc = value; break;
        
        case 0x210B: this.bg12nba = value; break;
        case 0x210C: this.bg34nba = value; break;

        // Scroll (write twice)
        case 0x210D: 
            // HOFS: (new<<8 | latch&~7 | old_hofs_hi&7)   (per bsnes)
            this.bg1hofs = ((value << 8) | (this.bg_latch & ~7) | ((this.bg1hofs >> 8) & 7)) ;
            this.m7hofs = (value << 8) | this.m7_latch;
            this.bg_latch = value; this.m7_latch = value; 
            break; 
        case 0x210E: 
            // VOFS: (new<<8 | latch)   (per bsnes - simpler formula)
            this.bg1vofs = ((value << 8) | this.bg_latch) ;
            this.m7vofs = (value << 8) | this.m7_latch;
            this.bg_latch = value; this.m7_latch = value; 
            break;
        case 0x210F: this.bg2hofs = ((value << 8) | (this.bg_latch & ~7) | ((this.bg2hofs >> 8) & 7)) ; this.bg_latch = value; break;
        case 0x2110: this.bg2vofs = ((value << 8) | this.bg_latch) ; this.bg_latch = value; break;
        case 0x2111: this.bg3hofs = ((value << 8) | (this.bg_latch & ~7) | ((this.bg3hofs >> 8) & 7)) ; this.bg_latch = value; break;
        case 0x2112: this.bg3vofs = ((value << 8) | this.bg_latch) ; this.bg_latch = value; break;
        case 0x2113: this.bg4hofs = ((value << 8) | (this.bg_latch & ~7) | ((this.bg4hofs >> 8) & 7)) ; this.bg_latch = value; break;
        case 0x2114: this.bg4vofs = ((value << 8) | this.bg_latch) ; this.bg_latch = value; break;
        
        case 0x2115: this.vmain = value; break;
        case 0x2116:
           this.vmaddl = value;
           this.vramAddr = (this.vmaddh << 8) | this.vmaddl;
           break;
        case 0x2117: this.vmaddh = value; 
           this.vramAddr = (this.vmaddh << 8) | this.vmaddl; 
           this.prefetchVram();
           break;
           
        case 0x2118: // VMDATAL
           {
               let addr = this.getVramTranslatedAddr();
               this.vram[addr * 2] = value;
               if ((this.vmain & 0x80) === 0) this.incVramAddr();
           }
           break;
        case 0x2119: // VMDATAH
           {
               let addr = this.getVramTranslatedAddr();
               this.vram[addr * 2 + 1] = value;
               if ((this.vmain & 0x80) !== 0) this.incVramAddr();
           }
           break;
           
        case 0x211A: this.m7sel = value; break;
        case 0x211B: this.m7a = (value << 8) | this.m7_latch; this.m7_latch = value; break;
        case 0x211C: this.m7b = (value << 8) | this.m7_latch; this.m7_latch = value; break;
        case 0x211D: this.m7c = (value << 8) | this.m7_latch; this.m7_latch = value; break;
        case 0x211E: this.m7d = (value << 8) | this.m7_latch; this.m7_latch = value; break;
        case 0x211F: this.m7x = (value << 8) | this.m7_latch; this.m7_latch = value; break;
        case 0x2120: this.m7y = (value << 8) | this.m7_latch; this.m7_latch = value; break;
           
        case 0x2121: this.cgadd = value; this.cgdata_latch = null; break;
        case 0x2122: // CGDATA - Write twice

           if (this.cgdata_latch === null) {
               this.cgdata_latch = value;
           } else {
               const addr = this.cgadd * 2;
               this.cgram[addr] = this.cgdata_latch;
               this.cgram[addr + 1] = value;
               
               this.cgadd = (this.cgadd + 1) & 0xFF;
               this.cgdata_latch = null;
           }
           break;

        case 0x212C: this.tm = value; break; // Main Screen Designation
        case 0x212D: this.ts = value; break; // Sub Screen Designation
        case 0x212E: this.tmw = value; break; 
        case 0x212F: this.tsw = value; break;

        case 0x2123: this.wbg12 = value; break;
        case 0x2124: this.wbg34 = value; break;
        case 0x2125: this.wobjsel = value; break;
        case 0x2126: this.w1l = value; break;
        case 0x2127: this.w1r = value; break;
        case 0x2128: this.w2l = value; break;
        case 0x2129: this.w2r = value; break;
        case 0x212A: this.wbgobj = value; break;
        case 0x212B: this.wcolmath = value; break;

        case 0x2130: { this.cgwsel = value; break; }
        case 0x2131: { this.cgadsub = value; break; }
        case 0x2132:
           {
           if (value & 0x80) this.coldataB = value & 0x1F;
           if (value & 0x40) this.coldataG = value & 0x1F;
           if (value & 0x20) this.coldataR = value & 0x1F;
           break;
           }
        case 0x2133: this.setini = value; break;
    }
  }

  incVramAddr() {
      const step = [1, 32, 128, 128][this.vmain & 0x03]; 
      this.vramAddr = (this.vramAddr + step) & 0x7FFF;
  }
  
  getVramTranslatedAddr() {
      let addr = this.vramAddr & 0x7FFF;
      let mapping = (this.vmain >> 2) & 3;
      if (mapping === 0) return addr;
      if (mapping === 1) return (addr & 0xFF00) | ((addr & 0x00E0) >> 5) | ((addr & 0x001F) << 3);
      if (mapping === 2) return (addr & 0xFE00) | ((addr & 0x01C0) >> 6) | ((addr & 0x003F) << 3);
      if (mapping === 3) return (addr & 0xFC00) | ((addr & 0x0380) >> 7) | ((addr & 0x007F) << 3);
      return addr;
  }

  prefetchVram() {
      let addr = this.getVramTranslatedAddr();
      this.vramReadBuffer = (this.vram[addr * 2 + 1] << 8) | this.vram[addr * 2];
  }

  updateVramRead() {
      this.prefetchVram();
  }
  
  // --- Rendering ---
  
  getColor(paletteIndex) {
      const addr = (paletteIndex * 2) & 0x1FF;
      const lo = this.cgram[addr];
      const hi = this.cgram[addr + 1];
      const val = (hi << 8) | lo;
      
      const r5 = val & 0x1F;
      const g5 = (val >> 5) & 0x1F;
      const b5 = (val >> 10) & 0x1F;
      const r = (r5 << 3) | (r5 >> 2);
      const g = (g5 << 3) | (g5 >> 2);
      const b = (b5 << 3) | (b5 >> 2);
      
      // ABGR (A=mask)
      return (0xFF << 24) | (b << 16) | (g << 8) | r;
  }

  renderPass(line, layers, mode, bg3Prio, outputOffset) {
    if (mode === 0) {
        if (layers & 0x08) this.renderLayer(line, 4, 0, 10, 50);
        if (layers & 0x04) this.renderLayer(line, 3, 0, 20, 60);
        if (layers & 0x02) this.renderLayer(line, 2, 0, 30, 70);
        if (layers & 0x01) this.renderLayer(line, 1, 0, 40, 80);
    } else if (mode === 1) {
        // Correct Mode 1 priority (front→back):
        // Fullsnes Mode 1 priority (front→back):
        // BG3-H_boost(110) > OBJ-3(100) > BG1-H(90) > OBJ-2(80) > BG2-H(70) > OBJ-1(60) > BG1-L(50) > BG2-L(40) > OBJ-0(30) > BG3-H_noboost(20) > BG3-L(10)
        let zBg3L = 10, zBg3H = bg3Prio ? 110 : 20;
        let zBg1L = 50, zBg2L = 40, zBg1H = 90, zBg2H = 70;  // BG2-H is below OBJ-2
        
        // Render from back to front, but zBuffer handles it anyway
        if (layers & 0x04) this.renderLayer(line, 3, 1, zBg3L, zBg3H); // BG3
        if (layers & 0x02) this.renderLayer(line, 2, 1, zBg2L, zBg2H); // BG2
        if (layers & 0x01) this.renderLayer(line, 1, 1, zBg1L, zBg1H); // BG1
    } else if (mode === 2) {
        // Mode 2: 16-color BGs, offset-per-tile
        if (layers & 0x02) this.renderLayer(line, 2, 2, 20, 50);
        if (layers & 0x01) this.renderLayer(line, 1, 2, 30, 60);
    } else if (mode >= 3 && mode <= 6) {
        // Other modes, primarily 3,4 (BG1=256-color)
        if (layers & 0x02) this.renderLayer(line, 2, mode, 20, 50);
        if (layers & 0x01) this.renderLayer(line, 1, mode, 30, 60);
    } else if (mode === 7) {
        if (layers & 0x01) this.renderMode7(line);
    }
    
    if (layers & 0x10) {
       const isSub = this.frameBuffer === this.subFrameBuffer;
       const tmw = isSub ? (this.tsw || 0) : (this.tmw || 0);
       const wobjsel = this.wobjsel || 0;
       const wbglog = this.wbgobj || 0;
       const wobjlog = this.wcolmath || 0; // WOBJLOG is 212B, bits 4-5
       const w1l = this.w1l || 0;
       const w1r = this.w1r || 0;
       const w2l = this.w2l || 0;
       const w2r = this.w2r || 0;
       
       let checkWindow = false;
       let w1E = false, w1I = false, w2E = false, w2I = false, logic = 0;
       if (tmw & 0x10) {
           checkWindow = true;
           w1E = (wobjsel & 0x02)!==0; w1I = (wobjsel & 0x01)!==0;
           w2E = (wobjsel & 0x08)!==0; w2I = (wobjsel & 0x04)!==0;
           logic = wobjlog & 0x03;
       }

       for (let x=0; x<256; x++) {
           if (checkWindow) {
              let in1 = false, in2 = false;
              if (w1E) { let _w1in = x >= w1l && x <= w1r; in1 = w1I ? !_w1in : _w1in; }
              if (w2E) { let _w2in = x >= w2l && x <= w2r; in2 = w2I ? !_w2in : _w2in; }
              let masked = false;
              if (w1E && !w2E) masked = in1;
              else if (!w1E && w2E) masked = in2;
              else if (w1E && w2E) {
                  if (logic===0) masked = in1 || in2;
                  else if (logic===1) masked = in1 && in2;
                  else if (logic===2) masked = in1 !== in2;
                  else masked = in1 === in2;
              }
              if (masked) continue;
           }
           
           if (this.objBuffer[x] !== 0) {
               const p = this.objPrioBuffer[x];
               // Mode 1: OBJ-0(30) OBJ-1(60) OBJ-2(80) OBJ-3(100)
               // Other:  OBJ-0(20) OBJ-1(50) OBJ-2(80) OBJ-3(100)
               let z = (mode === 1) ? [30, 60, 80, 100][p] : [20, 50, 80, 100][p];
               if (z > this.zBuffer[x]) {
                   this.frameBuffer[outputOffset + x] = this.objBuffer[x];
                   this.zBuffer[x] = z;
                   this.layerBuffer[x] = 5;
               }
           }
       }
    }
  }

  renderLine(line) {
    if (line >= 224) return;
    
    this.zBuffer.fill(0); // Clear to 0 instead of 1
    this.layerBuffer.fill(0);
    this.objBuffer.fill(0);
    this.objPrioBuffer.fill(0);
    this.objPalHighBuffer.fill(0);
    
    const backdrop = this.getColor(0);
    const outputOffset = line * 256;
    
    if (this.tm !== 0 && !this.debugLogged && line === 100) this.dumpDebugInfo();

    // OP scene CGRAM[0] gradient scan: log a few scanlines during OP to see if HDMA updates it
    const fr = globalThis._snesFrame || 0;
    // OP scene diagnostics: log whenever tm/bgmode/inidisp changes
    if (globalThis._dmaLog && line === 0 && !(this.inidisp & 0x80) && fr > 10 && fr < 2000) {
        const tmKey = `${this.tm}_${this.bgmode}_${this.bg12nba}_${this.bg1sc}_${this.inidisp}_${this.bg34nba}_${this.bg3sc}`;
        if (this._lastTmKey !== tmKey) {
            this._lastTmKey = tmKey;
            const mode = this.bgmode & 0x07;
            const scBase1 = (this.bg1sc & 0xFC) << 9;
            const charBase1 = (this.bg12nba & 0x0F) << 13;
            let nonZeroChar = 0, nonZeroMap = 0, nonZeroCgram = 0;
            for (let i = 0; i < 256; i++) if (this.vram[(charBase1 + i) & 0xFFFF] !== 0) nonZeroChar++;
            for (let i = 0; i < 64; i++) if (this.vram[(scBase1 + i) & 0xFFFF] !== 0) nonZeroMap++;
            for (let i = 0; i < 512; i++) if (this.cgram[i] !== 0) nonZeroCgram++;
            const cg1 = (this.cgram[3] << 8) | this.cgram[2]; // CGRAM[1] = first non-backdrop color
            const cg16 = (this.cgram[33] << 8) | this.cgram[32]; // CGRAM[16]
            const bright = this.inidisp & 0x0F;
            const charBase3 = (this.bg34nba & 0x0F) << 13;
            const scBase3 = (this.bg3sc & 0xFC) << 9;
            // First entry of BG3 tilemap
            const map3_0 = (this.vram[(scBase3 + 1) & 0xFFFF] << 8) | this.vram[scBase3 & 0xFFFF];
            const map3_tileIdx = map3_0 & 0x3FF;
            const map3_pal = (map3_0 >> 10) & 7;
            // Tile 0 data (first 4 bytes of BG3 charBase)
            const chr3_0 = [this.vram[charBase3 & 0xFFFF], this.vram[(charBase3+1) & 0xFFFF], this.vram[(charBase3+2) & 0xFFFF], this.vram[(charBase3+3) & 0xFFFF]].map(b=>(b||0).toString(16).padStart(2,'0')).join(' ');
            // Tile N (first map entry) data - all 16 bytes
            const tileNByteAddr = (charBase3 + map3_tileIdx * 16) & 0xFFFF;
            const chr3_tileN = [];
            for (let _i = 0; _i < 16; _i++) chr3_tileN.push((this.vram[(tileNByteAddr+_i)&0xFFFF]||0).toString(16).padStart(2,'0'));
            // BG3 palette used by first tile (palIdx=map3_pal, 4 colors)
            const palBase = map3_pal * 4;
            const cg_sky = [];
            for (let _i = 0; _i < 4; _i++) cg_sky.push(((this.cgram[(palBase+_i)*2+1]<<8)|this.cgram[(palBase+_i)*2]).toString(16).padStart(4,'0'));
            // BG3 sub-palettes 0-7 (CGRAM[0..7])
            const cg_bg3 = [];
        }
    }

    if (this.inidisp & 0x80) {
        this.frameBuffer.fill(0xFF000000, outputOffset, outputOffset + 256);
        return;
    }

    const mode = this.bgmode & 0x07;
    const bg3Prio = (this.bgmode & 0x08) !== 0;
    
    // Always evaluate sprites once per line
    if ((this.tm | this.ts) & 0x10) {
        this.evaluateSprites(line);
    }
    
    // Sub Screen pass
    if (!this.subFrameBuffer) this.subFrameBuffer = new Uint32Array(256 * 224);
    if (!this.subLayerBuffer) this.subLayerBuffer = new Uint8Array(256);
    const origFrameBuffer = this.frameBuffer;
    this.frameBuffer = this.subFrameBuffer;
    this.zBuffer.fill(0);
    this.layerBuffer.fill(0);
    this.frameBuffer.fill(backdrop, outputOffset, outputOffset + 256);
    this.renderPass(line, this.ts, mode, bg3Prio, outputOffset);
    this.subLayerBuffer.set(this.layerBuffer);
    
    // Main Screen pass
    this.frameBuffer = origFrameBuffer;
    this.zBuffer.fill(0);
    this.layerBuffer.fill(0);
    this.frameBuffer.fill(backdrop, outputOffset, outputOffset + 256);
    this.renderPass(line, this.tm, mode, bg3Prio, outputOffset);
    
    if (this.cgadsub & 0x3F) {
        this.applyColorMath(line, outputOffset);
    }
    this.applyBrightness(line, outputOffset);
  }

  applyColorMath(line, outputOffset) {
      const isSub = !!(this.cgadsub & 0x80);
      let isHalf = (this.cgadsub & 0x40) !== 0;
      let enables = this.cgadsub & 0x3F;

      let rF = this.coldataR << 3;
      let gF = this.coldataG << 3;
      let bF = this.coldataB << 3;

      const cgwsel = this.cgwsel || 0;
      let mathEnable = (cgwsel & 0x30) >> 4; // Prevent: 0=Never, 1=Outside window, 2=Inside window, 3=Always
      const clipEnable = (cgwsel & 0xC0) >> 6; // Clip: 0=Never, 1=Outside window, 2=Inside window, 3=Always
      // CGWSEL Bit1: Sub Screen BG/OBJ Enable (0=Backdrop/COLDATA only, 1=Backdrop+BG+OBJ)
      // Bit0 is Direct Color mode for 256-color BGs, unrelated to color math source.
      let useSubscreen = (cgwsel & 0x02) !== 0;



      const wobjsel = this.wobjsel || 0;
      const w1Inv = (wobjsel & 0x10) !== 0;
      const w1En = (wobjsel & 0x20) !== 0;
      const w2Inv = (wobjsel & 0x40) !== 0;
      const w2En = (wobjsel & 0x80) !== 0;
      
      const maskLogic = this.wcolmath || 0;
      const mathLogic = (maskLogic & 0x0C) >> 2; // bits 3-2 = color math window logic per $212B

      const w1l = this.w1l || 0;
      const w1r = this.w1r || 0;
      const w2l = this.w2l || 0;
      const w2r = this.w2r || 0;

      for (let x = 0; x < 256; x++) {
          let mathPrevented = false;
          let clipBlack = false;

          let windowValue = false;
          let inW1 = false;
          let inW2 = false;
          if (w1En || w2En) {
              if (w1En) {
                  const _inW1raw = x >= w1l && x <= w1r;
                  inW1 = w1Inv ? !_inW1raw : _inW1raw;
              }
              if (w2En) {
                  const _inW2raw = x >= w2l && x <= w2r;
                  inW2 = w2Inv ? !_inW2raw : _inW2raw;
              }
              if (mathLogic === 0) windowValue = inW1 || inW2;
              else if (mathLogic === 1) windowValue = inW1 && inW2;
              else if (mathLogic === 2) windowValue = (inW1 !== inW2);
              else windowValue = (inW1 === inW2);
          }

          if (mathEnable === 1 && !windowValue) mathPrevented = true;  // 01 = prevent OUTSIDE window
          if (mathEnable === 2 && windowValue) mathPrevented = true;   // 10 = prevent INSIDE window
          if (mathEnable === 3) mathPrevented = true;

          if (clipEnable === 1 && !windowValue) clipBlack = true;  // 01 = clip OUTSIDE window
          if (clipEnable === 2 && windowValue) clipBlack = true;   // 10 = clip INSIDE window
          if (clipEnable === 3) clipBlack = true;

          const layerId = this.layerBuffer[x];
          // CGADSUB bit layout (per fullsnes $2131): bit5=Backdrop, bit4=OBJ/Palette4-7, bit3=BG4, bit2=BG3, bit1=BG2, bit0=BG1
          // OBJ Palette 0-3 is always OFF (hardware spec); Palette 4-7 uses bit4.
          let layerBit = 0;
          if (layerId === 0) layerBit = 0x20;       // Backdrop (bit5)
          else if (layerId === 1) layerBit = 0x01;  // BG1 (bit0)
          else if (layerId === 2) layerBit = 0x02;  // BG2 (bit1)
          else if (layerId === 3) layerBit = 0x04;  // BG3 (bit2)
          else if (layerId === 4) layerBit = 0x08;  // BG4 (bit3)
          else if (layerId === 5) {
              // OBJ: palette 4-7 eligible (bit4); palette 0-3 always OFF
              layerBit = (this.objPalHighBuffer[x]) ? 0x10 : 0;
          }
          


          // When main-screen pixel is backdrop, subscreen (if enabled) shows through via color math.
          // The sub-screen contribution: non-transparent sub pixel → use sub color; transparent sub → use COLDATA.
          // This is handled naturally in the color math section below.
          // (No special addBackdrop case needed)

          if ((enables & layerBit) === 0) mathPrevented = true;

          let mainColor = this.frameBuffer[outputOffset + x];
          let r = clipBlack ? 0 : (mainColor & 0xFF);
          let g = clipBlack ? 0 : ((mainColor >> 8) & 0xFF);
          let b = clipBlack ? 0 : ((mainColor >> 16) & 0xFF);
          
          if (mathPrevented) {
              this.frameBuffer[outputOffset + x] = 0xFF000000 | (b << 16) | (g << 8) | r;
              continue;
          }

          let curRF, curGF, curBF;
          if (useSubscreen && this.subFrameBuffer) {
              // Use sub color only if sub pixel is non-transparent (subLayerBuffer[x] != 0)
              // Otherwise fall back to fixed color (COLDATA)
              if (this.subLayerBuffer && this.subLayerBuffer[x] !== 0) {
                  const subColor = this.subFrameBuffer[outputOffset + x];
                  curRF = subColor & 0xFF;
                  curGF = (subColor >> 8) & 0xFF;
                  curBF = (subColor >> 16) & 0xFF;
              } else {
                  curRF = rF;
                  curGF = gF;
                  curBF = bF;
              }
          } else {
              curRF = rF;
              curGF = gF;
              curBF = bF;
          }
          
          let resR, resG, resB;
          let r5 = Math.floor(r / 8);
          let g5 = Math.floor(g / 8);
          let b5 = Math.floor(b / 8);
          let cr5 = Math.floor(curRF / 8);
          let cg5 = Math.floor(curGF / 8);
          let cb5 = Math.floor(curBF / 8);

          if (isSub) {
              resR = Math.max(0, r5 - cr5);
              resG = Math.max(0, g5 - cg5);
              resB = Math.max(0, b5 - cb5);
          } else {
              resR = Math.min(31, r5 + cr5);
              resG = Math.min(31, g5 + cg5);
              resB = Math.min(31, b5 + cb5);
          }
          
          let applyHalf = isHalf;
          if (isHalf && useSubscreen && this.subLayerBuffer && this.subLayerBuffer[x] === 0) {
              applyHalf = false;
          }
          if (applyHalf) {
               resR >>= 1;
               resG >>= 1;
               resB >>= 1;
          }
          
          resR = (resR << 3) | (resR >> 2);
          resG = (resG << 3) | (resG >> 2);
          resB = (resB << 3) | (resB >> 2);
          

          
          this.frameBuffer[outputOffset + x] = 0xFF000000 | (resB << 16) | (resG << 8) | resR;
      }
  }

  applyBrightness(line, outputOffset) {
      const brightness = this.inidisp & 0x0F;
      if (brightness === 15) return;
      for (let x = 0; x < 256; x++) {
          const color = this.frameBuffer[outputOffset + x];
          let r = color & 0xFF;
          let g = (color >> 8) & 0xFF;
          let b = (color >> 16) & 0xFF;
          r = Math.floor((r * brightness) / 15);
          g = Math.floor((g * brightness) / 15);
          b = Math.floor((b * brightness) / 15);
          this.frameBuffer[outputOffset + x] = 0xFF000000 | (b << 16) | (g << 8) | r;
      }
  }
  
  renderLayer(line, bgIndex, mode, zLow, zHigh) {
      let scBase = 0;
      let charBase = 0;
      let bpp = 2;
      let paletteOffset = 0;
      let hScroll = 0;
      let vScroll = 0;
      let sc = 0;
      
      if (bgIndex === 1) {
          sc = this.bg1sc;
          scBase = (sc & 0xFC) << 9; 
          charBase = (this.bg12nba & 0x0F) << 13;
          bpp = (mode === 0) ? 2 : ((mode === 3 || mode === 4) ? 8 : 4);
          paletteOffset = 0;
          hScroll = this.bg1hofs & 0x3FF;
          vScroll = this.bg1vofs & 0x3FF;
      } else if (bgIndex === 2) {
          sc = this.bg2sc;
          scBase = (sc & 0xFC) << 9;
          charBase = (this.bg12nba & 0xF0) << 9;
          bpp = (mode === 0) ? 2 : 4;
          paletteOffset = (mode === 0) ? 32 : 0; 
          hScroll = this.bg2hofs & 0x3FF;
          vScroll = this.bg2vofs & 0x3FF;
      } else if (bgIndex === 3) {
          sc = this.bg3sc;
          scBase = (sc & 0xFC) << 9;
          charBase = (this.bg34nba & 0x0F) << 13;
          bpp = (mode === 0) ? 2 : ((mode === 1) ? 2 : 4); 
          paletteOffset = (mode === 0) ? 64 : 0;
          hScroll = this.bg3hofs & 0x3FF;
          vScroll = this.bg3vofs & 0x3FF;
      } else if (bgIndex === 4) {
          sc = this.bg4sc;
          scBase = (sc & 0xFC) << 9;
          charBase = (this.bg34nba & 0xF0) << 9;
          bpp = 2;
          paletteOffset = 96;
          hScroll = this.bg4hofs & 0x3FF;
          vScroll = this.bg4vofs & 0x3FF;
      }
      
      const outputOffset = line * 256;
      const screenSize = sc & 3; // 0=32x32, 1=64x32, 2=32x64, 3=64x64
      
      const isSub = this.frameBuffer === this.subFrameBuffer;
      const tmw = isSub ? (this.tsw || 0) : (this.tmw || 0);
      const w12sel = this.wbg12 || 0;
      const w34sel = this.wbg34 || 0;
      const wbglog = this.wbgobj || 0;
      const w1l = this.w1l || 0;
      const w1r = this.w1r || 0;
      const w2l = this.w2l || 0;
      const w2r = this.w2r || 0;
      
      let checkWindow = false;
      let w1E = false, w1I = false, w2E = false, w2I = false, logic = 0;
      // Window field: bit1=Enable, bit0=Invert (00/01=Disable, 10=Inside, 11=Outside)
      if (bgIndex === 1 && (tmw & 0x01)) {
          checkWindow = true; w1E = (w12sel & 0x02)!==0; w1I = (w12sel & 0x01)!==0;
          w2E = (w12sel & 0x08)!==0; w2I = (w12sel & 0x04)!==0; logic = wbglog & 0x03;
      } else if (bgIndex === 2 && (tmw & 0x02)) {
          checkWindow = true; w1E = (w12sel & 0x20)!==0; w1I = (w12sel & 0x10)!==0;
          w2E = (w12sel & 0x80)!==0; w2I = (w12sel & 0x40)!==0; logic = (wbglog & 0x0C)>>2;
      } else if (bgIndex === 3 && (tmw & 0x04)) {
          checkWindow = true; w1E = (w34sel & 0x02)!==0; w1I = (w34sel & 0x01)!==0;
          w2E = (w34sel & 0x08)!==0; w2I = (w34sel & 0x04)!==0; logic = (wbglog & 0x30)>>4;
      } else if (bgIndex === 4 && (tmw & 0x08)) {
          checkWindow = true; w1E = (w34sel & 0x20)!==0; w1I = (w34sel & 0x10)!==0;
          w2E = (w34sel & 0x80)!==0; w2I = (w34sel & 0x40)!==0; logic = (wbglog & 0xC0)>>6;
      }

      // Tile size: bgmode bits 4-7 control tile size per BG (0=8x8, 1=16x16)
      // bit4=BG1, bit5=BG2, bit6=BG3, bit7=BG4
      const large = !!((this.bgmode >> (3 + bgIndex)) & 1);
      const tileShift = large ? 4 : 3;   // 16px or 8px per tile
      const pageShift = large ? 9 : 8;   // 512px or 256px per tilemap page

      // Mode 2/4/6 OPT: per-column H/V scroll overrides from BG3 tilemap.
      // H-entry: bit13=BG1 valid, bit14=BG2 valid. V-entry: same bit layout.
      // When valid bit set: use entry bits[0:8] as scroll. When clear: use layer's global scroll.
      let optH = null;
      let optV = null;
      if (mode === 2 || mode === 4 || mode === 6) {
          const g3sc = this.bg3sc;
          const g3Base = (g3sc & 0xFC) << 9;
          const g3SS = g3sc & 3;
          const g3MCols = (g3SS & 1) ? 64 : 32;
          const g3MRows = (g3SS & 2) ? 64 : 32;
          const g3Hofs = this.bg3hofs & 0x3FF;
          const g3Vofs = this.bg3vofs & 0x3FF;
          const optHRow = (g3Vofs >> 3) % g3MRows;
          const optVRow = (optHRow + 1) % g3MRows;

          const readG3 = (row, col) => {
              col = col % g3MCols;
              row = row % g3MRows;
              let mOff = 0;
              if (g3SS === 1) { mOff = col >= 32 ? 2048 : 0; col &= 31; }
              else if (g3SS === 2) { mOff = row >= 32 ? 2048 : 0; row &= 31; }
              else if (g3SS === 3) { mOff = ((row >= 32 ? 2 : 0) + (col >= 32 ? 1 : 0)) * 2048; row &= 31; col &= 31; }
              const a = g3Base + mOff + (row * 32 + col) * 2;
              return (this.vram[(a + 1) & 0xFFFF] << 8) | this.vram[a & 0xFFFF];
          };

          // bit13 (0x2000) validates BG1; bit14 (0x4000) validates BG2
          const validBit = bgIndex === 1 ? 0x2000 : 0x4000;
          optH = new Int32Array(32);
          optV = new Int32Array(32);
          for (let ci = 0; ci < 32; ci++) {
              const g3c = ((g3Hofs >> 3) + ci + 1) % g3MCols;
              const hEntry = readG3(optHRow, g3c);
              const vEntry = readG3(optVRow, g3c);
              optH[ci] = (hEntry & validBit) ? (hEntry & 0x1FF) : hScroll;
              optV[ci] = (vEntry & validBit) ? (vEntry & 0x1FF) : vScroll;
          }
      }

      for (let x = 0; x < 256; x++) {
          if (checkWindow) {
              let in1 = false, in2 = false;
              if (w1E) { let _w1in = x >= w1l && x <= w1r; in1 = w1I ? !_w1in : _w1in; }
              if (w2E) { let _w2in = x >= w2l && x <= w2r; in2 = w2I ? !_w2in : _w2in; }
              let masked = false;
              if (w1E && !w2E) masked = in1;
              else if (!w1E && w2E) masked = in2;
              else if (w1E && w2E) {
                  if (logic===0) masked = in1 || in2;
                  else if (logic===1) masked = in1 && in2;
                  else if (logic===2) masked = in1 !== in2;
                  else masked = in1 === in2;
              }
              if (masked) continue;
          }
          
          const _col = x >> 3;
          const rX = x + (optH ? optH[_col] : hScroll);
          const rY = line + (optV ? optV[_col] : vScroll);
          
          // Determine which tilemap page (each page = 32×32 tile entries = 2KB)
          const mapX = (rX >> pageShift);
          const mapY = (rY >> pageShift);
          
          let mapOff = 0;
          if (screenSize === 0) {
              mapOff = 0;
          } else if (screenSize === 1) { // 64x32 (two horizontal pages)
              mapOff = (mapX & 1) * 2048;
          } else if (screenSize === 2) { // 32x64 (two vertical pages)
              mapOff = (mapY & 1) * 2048;
          } else { // 64x64 (four pages)
              mapOff = ((mapY & 1) * 2 + (mapX & 1)) * 2048;
          }
          
          // Tile map position (each entry covers tileSize×tileSize pixels)
          const tileX = (rX >> tileShift) & 0x1F;
          const tileY = (rY >> tileShift) & 0x1F;
          
          const mapAddr = scBase + mapOff + (tileY * 32 + tileX) * 2;
          
          const t1 = this.vram[mapAddr & 0xFFFF];
          const t2 = this.vram[(mapAddr + 1) & 0xFFFF];
          const entry = (t2 << 8) | t1;
          
          const tileIdxBase = entry & 0x03FF;
          const palIdx = (entry >> 10) & 0x07;
          const prio = (entry >> 13) & 1; 
          const flipX = (entry >> 14) & 1;
          const flipY = (entry >> 15) & 1;
          
          // For 16x16 tiles, determine which 8x8 sub-tile we're rendering
          let tileIdx = tileIdxBase;
          if (large) {
              let subX = (rX >> 3) & 1;
              let subY = (rY >> 3) & 1;
              if (flipX) subX = 1 - subX;
              if (flipY) subY = 1 - subY;
              tileIdx = (tileIdxBase + subY * 16 + subX) & 0x3FF;
          }

          const z = prio ? zHigh : zLow;
          if (z <= this.zBuffer[x]) continue; 
          
          const localX = flipX ? (7 - (rX & 7)) : (rX & 7);
          const localY = flipY ? (7 - (rY & 7)) : (rY & 7);
          
          const pixelColorIdx = this.getTilePixel(tileIdx, localX, localY, bpp, charBase);


          
          if (pixelColorIdx !== 0) {
              let globalColorIdx = 0;
              if (bpp === 8) {
                  globalColorIdx = pixelColorIdx; // 256 colors
              } else if (bpp === 4) {
                  // For 16-color BGs, palette ranges 0-7, so palIdx * 16 + pixelColor
                  // If mode 0, offset is handled via paletteOffset
                  globalColorIdx = paletteOffset + (palIdx * 16) + pixelColorIdx;
              } else {
                  // For 4-color BGs
                  globalColorIdx = paletteOffset + (palIdx * 4) + pixelColorIdx;
              }
              
              const color = this.getColor(globalColorIdx);
              const outputIdx = outputOffset + x;
              // Write to buffer with Z-check
              if (z > this.zBuffer[x]) {
                  this.frameBuffer[outputIdx] = color;
                  this.zBuffer[x] = z;
                  this.layerBuffer[x] = bgIndex; // 1, 2, 3, 4
              }
          }
      }
  }

  renderMode7(line) {
      // 13-bit signed (sign extend from bit 12)
      const cx = (this.m7x & 0x1FFF) | ((this.m7x & 0x1000) ? ~0x1FFF : 0);
      const cy = (this.m7y & 0x1FFF) | ((this.m7y & 0x1000) ? ~0x1FFF : 0);
      
      const hScroll = (this.m7hofs & 0x1FFF) | ((this.m7hofs & 0x1000) ? ~0x1FFF : 0);
      const vScroll = (this.m7vofs & 0x1FFF) | ((this.m7vofs & 0x1000) ? ~0x1FFF : 0);
      
      // 16-bit signed
      const a = (this.m7a << 16) >> 16;
      const b = (this.m7b << 16) >> 16;
      const c = (this.m7c << 16) >> 16;
      const d = (this.m7d << 16) >> 16;
      
      const flipH = this.m7sel & 0x01;
      const flipV = this.m7sel & 0x02;
      const repeatMode = (this.m7sel >> 6) & 3;

      const sy = line;
      const actualSy = flipV ? (255 - sy) : sy;

      const outputOffset = line * 256;
      const z = 15; // Z depth for Mode 7 BG1 is usually below sprites but above backdrop

      for (let sx = 0; sx < 256; sx++) {
          const actualSx = flipH ? (255 - sx) : sx;

          // Compute matrix transformation
          let xx = ((actualSx + hScroll - cx) * a + (actualSy + vScroll - cy) * b) >> 8;
          xx += cx;
          
          let yy = ((actualSx + hScroll - cx) * c + (actualSy + vScroll - cy) * d) >> 8;
          yy += cy;
          
          // Map wrapping / Screen over
          let isOutOfBounds = (xx < 0 || xx > 1023 || yy < 0 || yy > 1023);
          
          let tx = xx ;
          let ty = yy ;
          let pixelColorIdx = 0;

          if (isOutOfBounds && repeatMode === 2) {
              // Transparent outside
              pixelColorIdx = 0;
          } else {
              let tileCode = 0;
              if (isOutOfBounds && repeatMode === 3) {
                  // Tile 0 outside
                  tileCode = 0;
              } else {
                  let tileX = tx >> 3;
                  let tileY = ty >> 3;
                  let mapIndex = tileY * 128 + tileX;
                  tileCode = this.vram[mapIndex * 2]; // Lower byte is tile map
              }
              
              let px = tx & 7;
              let py = ty & 7;
              let pixelOffset = tileCode * 64 + py * 8 + px;
              
              pixelColorIdx = this.vram[pixelOffset * 2 + 1]; // Upper byte is pixel data
          }
          
          if (pixelColorIdx !== 0) {
              if (z > this.zBuffer[sx]) {
                  this.frameBuffer[outputOffset + sx] = this.getColor(pixelColorIdx);
                  this.zBuffer[sx] = z;
                  this.layerBuffer[sx] = 1; // Mode 7 is BG1
              }
          }
      }
  }

  getTilePixel(tileIdx, x, y, bpp, charBase) {
      const tileAddr = (charBase + tileIdx * 8 * bpp) & 0xFFFF;
      const rowParams01 = tileAddr + y * 2;
      const p0 = this.vram[rowParams01 & 0xFFFF];
      const p1 = this.vram[(rowParams01 + 1) & 0xFFFF];
      
      let pixel = ((p0 >> (7 - x)) & 1) | (((p1 >> (7 - x)) & 1) << 1);
      
      if (bpp >= 4) {
          const rowParams23 = tileAddr + 16 + y * 2;
          const p2 = this.vram[rowParams23 & 0xFFFF];
          const p3 = this.vram[(rowParams23 + 1) & 0xFFFF];
          pixel |= ((p2 >> (7 - x)) & 1) << 2;
          pixel |= ((p3 >> (7 - x)) & 1) << 3;
      }
      if (bpp === 8) {
          const rowParams45 = tileAddr + 32 + y * 2;
          const p4 = this.vram[rowParams45 & 0xFFFF];
          const p5 = this.vram[(rowParams45 + 1) & 0xFFFF];
          pixel |= ((p4 >> (7 - x)) & 1) << 4;
          pixel |= ((p5 >> (7 - x)) & 1) << 5;
          const rowParams67 = tileAddr + 48 + y * 2;
          const p6 = this.vram[rowParams67 & 0xFFFF];
          const p7 = this.vram[(rowParams67 + 1) & 0xFFFF];
          pixel |= ((p6 >> (7 - x)) & 1) << 6;
          pixel |= ((p7 >> (7 - x)) & 1) << 7;
      }
      return pixel;
  }
  
  evaluateSprites(line) {
    if (this.inidisp & 0x80) return;
    
    // OBSEL Logic
    // OBSEL bits 0-2 select the OBJ name-base in 16KB byte steps.
    const nameBase = (this.obsel & 0x07) << 14;
    // OBSEL bits 3-4 select the gap from base name table to the second table.
    // Hardware encoding is (1..4) * 0x2000 bytes.
    const page1Offset = ((((this.obsel >> 3) & 0x03) + 1) << 13);
    
    // Size Logic (matches Snes9x SetupOBJ)
    const sizeSel = (this.obsel >> 5) & 7;
    let smallW = 8, smallH = 8, largeW = 16, largeH = 16;
    switch (sizeSel) {
        case 0: smallW = 8;  smallH = 8;  largeW = 16; largeH = 16; break;
        case 1: smallW = 8;  smallH = 8;  largeW = 32; largeH = 32; break;
        case 2: smallW = 8;  smallH = 8;  largeW = 64; largeH = 64; break;
        case 3: smallW = 16; smallH = 16; largeW = 32; largeH = 32; break;
        case 4: smallW = 16; smallH = 16; largeW = 64; largeH = 64; break;
        case 5: smallW = 32; smallH = 32; largeW = 64; largeH = 64; break;
        case 6: smallW = 16; smallH = 32; largeW = 32; largeH = 64; break;
        case 7: smallW = 16; smallH = 32; largeW = 32; largeH = 32; break;
    }

    // Iterate 127 down to 0 (Back to Front for internal overwrite)
    for (let i = 127; i >= 0; i--) {
        const addr = i * 4;
        const xLo = this.oam[addr];
        const y = this.oam[addr + 1];
        const tile = this.oam[addr + 2];
        const attr = this.oam[addr + 3]; 
        
        const hiByte = this.oam[512 + (i >> 2)];
        const shift = (i & 3) * 2;
        const xHi = (hiByte >> shift) & 1;
        const sizeFlag = (hiByte >> (shift + 1)) & 1;
        
        let x = xLo | (xHi << 8);
        if (x > 255) x -= 512; 
        
        const width = sizeFlag ? largeW : smallW;
        const height = sizeFlag ? largeH : smallH;
        
        const difY = (line - y) & 0xFF;
        
        // Visibility Check
        if (difY >= height) continue;
        
        const flipY = (attr & 0x80) !== 0;
        const flipX = (attr & 0x40) !== 0;
        const paletteBase = 128 + ((attr >> 1) & 7) * 16; // bits 3-1 = palette (0-7)
        const priority = (attr >> 4) & 3;                  // bits 5-4 = priority
        const page = attr & 1;                             // bit 0 = name table select

        // Vertical flip must use sprite height (rectangular OBJ modes have width != height).
        const row = difY;
        const actualRow = flipY ? (row ^ (height - 1)) : row;
        
        const tileRowOffset = (actualRow >> 3); 
        const rowInTile = actualRow & 7;
        
        const name = ((attr & 1) << 8) | tile;
        const rowTileOffset = (actualRow >> 3) << 4;

        for (let col = 0; col < width; col++) {
            const px = x + col;
            
            if (px < 0 || px >= 256) continue;
            
            const actualCol = flipX ? (width - 1 - col) : col;
            const tileColOffset = (actualCol >> 3);
            const colInTile = actualCol & 7;

            // Keep full 9-bit tile arithmetic so nibble overflow carries into page select.
            const tileIndex = (name + rowTileOffset + tileColOffset) & 0x1FF;
            const tableAddr = nameBase + ((tileIndex & 0x100) ? page1Offset : 0);
            const tileAddr = tableAddr + ((tileIndex & 0xFF) * 32);
            
            const p0Addr = (tileAddr + rowInTile * 2) & 0xFFFF;
            const p1Addr = (tileAddr + 16 + rowInTile * 2) & 0xFFFF;
            
            const p0 = this.vram[p0Addr];
            const p1 = this.vram[p0Addr + 1];
            const p2 = this.vram[p1Addr];
            const p3 = this.vram[p1Addr + 1];
            
            const bitShift = 7 - colInTile;
            const bit0 = (p0 >> bitShift) & 1;
            const bit1 = (p1 >> bitShift) & 1;
            const bit2 = (p2 >> bitShift) & 1;
            const bit3 = (p3 >> bitShift) & 1;
            
            const colorIdx = bit0 | (bit1 << 1) | (bit2 << 2) | (bit3 << 3);

            if (colorIdx !== 0) {
                // Populate Line Buffer
                // Since we iterate 127 -> 0, the last write (lowest index) wins.
                // This matches SNES behavior where lower index = higher priority.
                // The priority attribute only controls Z-depth against BG, not Sprite-vs-Sprite.
                
                const finalColor = this.getColor(paletteBase + colorIdx);
                this.objBuffer[px] = finalColor;
                this.objPrioBuffer[px] = priority;
                this.objPalHighBuffer[px] = ((attr >> 1) & 7) >= 4 ? 1 : 0; // palette 4-7 = color math eligible
            }
        }
    }
  }
}
