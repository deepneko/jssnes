import { DSP } from './DSP.js';

export class APU {
  constructor() {
    this.ram = new Uint8Array(64 * 1024);
    // SPC700 RAM is uninitialized on real hardware. Fill with RET ($6F) so that
    // any N-SPC handler area that isn't explicitly written will safely return
    // instead of creating NOP sleds that run into unexpected TCALL instructions.
    this.ram.fill(0x6F, 0x0000, 0x0800);
    this.dsp = new DSP();
    this.dsp.setApuRam(this.ram);
    this.bootRom = new Uint8Array([ // IPL ROM
        0xcd, 0xef, 0xbd, 0xe8, 0x00, 0xc6, 0x1d, 0xd0, 0xfc, 0x8f, 0xaa, 0xf4, 0x8f, 0xbb, 0xf5, 0x78,
        0xcc, 0xf4, 0xd0, 0xfb, 0x2f, 0x19, 0xeb, 0xf4, 0xd0, 0xfc, 0x7e, 0xf4, 0xd0, 0x0b, 0xe4, 0xf5,
        0xcb, 0xf4, 0xd7, 0x00, 0xfc, 0xd0, 0xf3, 0xab, 0x01, 0x10, 0xef, 0x7e, 0xf4, 0x10, 0xeb, 0xba,
        0xf6, 0xda, 0x00, 0xba, 0xf4, 0xc4, 0xf4, 0xdd, 0x5d, 0xd0, 0xdb, 0x1f, 0x00, 0x00, 0xc0, 0xff
    ]);

    this.PC = 0xFFC0;
    this.A = 0; this.X = 0; this.Y = 0; this.SP = 0xEF; this.PSW = 0;
    
    this.cpuPorts = new Uint8Array(4);
    this.apuPorts = new Uint8Array(4);
    
    this.timers = [ {ticks:0, counter:0}, {ticks:0, counter:0}, {ticks:0, counter:0} ];
    this.timerTargets = new Uint8Array(3);
    this.timersEnabled = 0;
    this.counter0 = 0; this.counter1 = 0; this.counter2 = 0;
    this.control = 0x80; this.dspAddr = 0; this.dspData = 0; this.testReg = 0;
    this.cycles = 0;
    
    this.initOpcodes();
  }
  
  reset() {
      this.apuPorts.fill(0); this.cpuPorts.fill(0);
      this.PC = 0xFFC0; this.A = 0; this.X = 0; this.Y = 0; this.SP = 0xEF; this.PSW = 0;
      this.control = 0x80; this.timersEnabled = 0; this.timerTargets.fill(0xFF);
      this.timers = [ {ticks:0, counter:0}, {ticks:0, counter:0}, {ticks:0, counter:0} ]; this.counter0 = 0; this.counter1 = 0; this.counter2 = 0;
      this.dsp.reset();
      this.dsp.reset();
      this.dspAddr = 0; this.dspData = 0; this.cycles = 0;
  }

  readCPU(port) { return this.apuPorts[port & 3]; }
  writeCPU(port, val) { this.cpuPorts[port & 3] = val; }

  read(addr) {
      if (addr >= 0x00F0 && addr <= 0x00FF) {
          const port = addr & 0xFF;
          switch (port) {
              case 0xF0: return 0; // TEST (write-only, reads 0)
              case 0xF1: return 0; // CONTROL (write-only, reads 0)
              case 0xF2: return this.dspAddr;
              case 0xF3: return this.dsp.read(this.dspAddr & 0x7F);
              case 0xF4: case 0xF5: case 0xF6: case 0xF7: return this.cpuPorts[port - 0xF4];
              case 0xF8: case 0xF9: return this.ram[port];
              case 0xFA: case 0xFB: case 0xFC: return 0; // Timer targets (write-only)
              case 0xFD: { let r = this.counter0; this.counter0 = 0; return r; }
              case 0xFE: { let r = this.counter1; this.counter1 = 0; return r; }
              case 0xFF: { let r = this.counter2; this.counter2 = 0; return r; }
          }
      }
      if (addr >= 0xFFC0 && (this.control & 0x80)) { return this.bootRom[addr - 0xFFC0]; }
      return this.ram[addr];
  }
  
  write(addr, val) {
      if (addr >= 0x00F0 && addr <= 0x00FF) {
          const port = addr & 0xFF;
          switch (port) {
              case 0xF0: this.testReg = val; break;
              case 0xF1: 
                  let newEnabled = val & 0x07;
                  for (let i = 0; i < 3; i++) {
                      if ((newEnabled & (1 << i)) && !(this.timersEnabled & (1 << i))) {
                          this.timers[i].ticks = 0;
                          this.timers[i].counter = 0;
                          if (i === 0) this.counter0 = 0;
                          if (i === 1) this.counter1 = 0;
                          if (i === 2) this.counter2 = 0;
                      }
                  }
                  this.timersEnabled = newEnabled;
                  this.control = val;
                  if (val & 0x10) { this.cpuPorts[0] = 0; this.cpuPorts[1] = 0; }
                  if (val & 0x20) { this.cpuPorts[2] = 0; this.cpuPorts[3] = 0; }
                  break;
              case 0xF2: this.dspAddr = val; break;
              case 0xF3:
                  this.dspData = val;
                  // Detailed logging for DSP VOL writes
                  if ((this.dspAddr & 0x7F) === 0x0C || (this.dspAddr & 0x7F) === 0x0D || (this.dspAddr & 0x7F) === 0x1C || (this.dspAddr & 0x7F) === 0x1D || (this.dspAddr & 0x7F) === 0x2C || (this.dspAddr & 0x7F) === 0x2D || (this.dspAddr & 0x7F) === 0x3C || (this.dspAddr & 0x7F) === 0x3D) {
                      const stack = (new Error()).stack.split('\n').slice(2, 7).join(' | ');
                      const pc = (typeof this.PC === 'number') ? this.PC.toString(16).padStart(4, '0') : '????';
                      console.log(`[APU] DSP VOL write: addr=0x${(this.dspAddr & 0x7F).toString(16)} value=0x${val.toString(16)} PC=0x${pc} stack=${stack}`);
                  }
                  this.dsp.write(this.dspAddr & 0x7F, val);
                  break;
              case 0xF4: case 0xF5: case 0xF6: case 0xF7:
                  this.apuPorts[port - 0xF4] = val;
                  // N-SPC ready handshake: when SPC (non-IPL) writes 0xBB to port1
                  // while port0 is already 0xAA, it signals "N-SPC initialized".
                  // CPU must respond with 0xCC to cpuPorts[0] to unblock the SPC.
                  // On real hardware the timing ensures cpuPorts[0] still has 0xCC
                  // from the upload sequence; in emulation we auto-respond here.
                  if (port === 0xF5 && val === 0xBB && this.apuPorts[0] === 0xAA && this.PC < 0xFFC0) {
                      this.cpuPorts[0] = 0xCC;
                  }
                  break;
              case 0xF8: case 0xF9: this.ram[port] = val; break;
              case 0xFA: this.timerTargets[0] = val; break;
              case 0xFB: this.timerTargets[1] = val; break;
              case 0xFC: this.timerTargets[2] = val; break;
          }
          return;
      }
      this.ram[addr] = val;
  }

  // --- Stack ---
  push(val) { this.write(0x0100 | this.SP, val); this.SP = (this.SP - 1) & 0xFF; }
  pop() { this.SP = (this.SP + 1) & 0xFF; return this.read(0x0100 | this.SP); }
  push16(val) { this.push((val >> 8) & 0xFF); this.push(val & 0xFF); }
  pop16() { let lo = this.pop(); let hi = this.pop(); return (hi << 8) | lo; }

  // --- Status Flags ---
  getFlag(flag) { return (this.PSW & flag) !== 0; }
  setFlag(flag, condition) { if (condition) this.PSW |= flag; else this.PSW &= ~flag; }
  setFlags(val) { this.setFlag(0x02, (val & 0xFF) === 0); this.setFlag(0x80, val & 0x80); }

  // --- Fetchers & Addressing ---
  fetch() { const val = this.read(this.PC); this.PC = (this.PC + 1) & 0xFFFF; return val; }
  fetch16() { const lo = this.fetch(); const hi = this.fetch(); return (hi << 8) | lo; }

  getDPBase() { return (this.PSW & 0x20) ? 0x0100 : 0x0000; }

  addr_dp() { return this.fetch() | this.getDPBase(); }
  addr_dp_x() { return ((this.fetch() + this.X) & 0xFF) | this.getDPBase(); }
  addr_dp_y() { return ((this.fetch() + this.Y) & 0xFF) | this.getDPBase(); }
  addr_abs() { return this.fetch16(); }
  addr_abs_x() { return (this.fetch16() + this.X) & 0xFFFF; }
  addr_abs_y() { return (this.fetch16() + this.Y) & 0xFFFF; }
  addr_ind_x() { return this.X | this.getDPBase(); }
  addr_ind_dp_x() { let dp = ((this.fetch() + this.X) & 0xFF) | this.getDPBase(); return this.read(dp) | (this.read((dp & 0xFF00) | ((dp + 1) & 0xFF)) << 8); }
  addr_ind_dp_y() { let dp = this.fetch() | this.getDPBase(); let ptr = this.read(dp) | (this.read((dp & 0xFF00) | ((dp + 1) & 0xFF)) << 8); return (ptr + this.Y) & 0xFFFF; }
  addr_ind_x_inc() { let a = this.X | this.getDPBase(); this.X = (this.X + 1) & 0xFF; return a; }

  step() { 
      let prevCycles = this.cycles;
      const opcode = this.fetch(); 
      this.opcodes[opcode](); 
      
      let delta = this.cycles - prevCycles;
      if (delta <= 0) delta = 2; // fallback
      
      if (!this.dspCycles) this.dspCycles = 0;
      this.dspCycles += delta;
      
      // Step timers (every 1 APU cycle)
      for(let i=0; i<3; i++) {
         if ((this.timersEnabled & (1 << i))) {
             this.timers[i].ticks += delta;
             let limit = (i === 2) ? 16 : 128; // Timer 0,1 run every 128 cycles, Timer 2 runs every 16 cycles
             while (this.timers[i].ticks >= limit) {
                 this.timers[i].ticks -= limit;
                 this.timers[i].counter++;
                 let target = this.timerTargets[i] === 0 ? 256 : this.timerTargets[i];
                 if (this.timers[i].counter >= target) {
                     this.timers[i].counter -= target;
                     if (i === 0) this.counter0 = (this.counter0 + 1) & 0x0F;
                     if (i === 1) this.counter1 = (this.counter1 + 1) & 0x0F;
                     if (i === 2) this.counter2 = (this.counter2 + 1) & 0x0F;
                 }
             }
         }
      }
      
      // Step DSP
      while (this.dspCycles >= 32) {
          this.dspCycles -= 32;
          this.dsp.step();
      }
  }

  initOpcodes() {
      this.opcodes = new Array(256);
      for (let i = 0; i < 256; i++) {
          this.opcodes[i] = () => { this.cycles += 2; }; // Fallback NOP
      }

      const OP = (code, fn) => { this.opcodes[code] = fn.bind(this); };

      // Helper for relative branches
      const branch = (cond) => {
          let rel = this.fetch();
          if (rel > 127) rel -= 256;
          if (cond) { this.PC = (this.PC + rel) & 0xFFFF; this.cycles += 4; }
          else { this.cycles += 2; }
      };

      // Helper: dp+1 address staying within same DP page
      const dpNext = (dp) => (dp & 0xFF00) | ((dp + 1) & 0xFF);

      // ========================
      // MOV Instructions
      // ========================
      // Load immediate
      OP(0xE8, function() { this.A = this.fetch(); this.setFlags(this.A); this.cycles+=2; }); // MOV A,#imm
      OP(0xCD, function() { this.X = this.fetch(); this.setFlags(this.X); this.cycles+=2; }); // MOV X,#imm
      OP(0x8D, function() { this.Y = this.fetch(); this.setFlags(this.Y); this.cycles+=2; }); // MOV Y,#imm
      // A from memory
      OP(0xE4, function() { this.A = this.read(this.addr_dp()); this.setFlags(this.A); this.cycles+=3; }); // MOV A,dp
      OP(0xF4, function() { this.A = this.read(this.addr_dp_x()); this.setFlags(this.A); this.cycles+=4; }); // MOV A,dp+X
      OP(0xE5, function() { this.A = this.read(this.addr_abs()); this.setFlags(this.A); this.cycles+=4; }); // MOV A,abs
      OP(0xF5, function() { this.A = this.read(this.addr_abs_x()); this.setFlags(this.A); this.cycles+=5; }); // MOV A,abs+X
      OP(0xF6, function() { this.A = this.read(this.addr_abs_y()); this.setFlags(this.A); this.cycles+=5; }); // MOV A,abs+Y
      OP(0xE6, function() { this.A = this.read(this.addr_ind_x()); this.setFlags(this.A); this.cycles+=3; }); // MOV A,(X)
      OP(0xBF, function() { this.A = this.read(this.addr_ind_x_inc()); this.setFlags(this.A); this.cycles+=4; }); // MOV A,(X)+
      OP(0xE7, function() { this.A = this.read(this.addr_ind_dp_x()); this.setFlags(this.A); this.cycles+=6; }); // MOV A,[dp+X]
      OP(0xF7, function() { this.A = this.read(this.addr_ind_dp_y()); this.setFlags(this.A); this.cycles+=6; }); // MOV A,[dp]+Y
      // A to memory
      OP(0xC4, function() { this.write(this.addr_dp(), this.A); this.cycles+=4; }); // MOV dp,A
      OP(0xD4, function() { this.write(this.addr_dp_x(), this.A); this.cycles+=5; }); // MOV dp+X,A
      OP(0xC5, function() { this.write(this.addr_abs(), this.A); this.cycles+=5; }); // MOV abs,A
      OP(0xD5, function() { this.write(this.addr_abs_x(), this.A); this.cycles+=6; }); // MOV abs+X,A
      OP(0xD6, function() { this.write(this.addr_abs_y(), this.A); this.cycles+=6; }); // MOV abs+Y,A
      OP(0xC6, function() { this.write(this.addr_ind_x(), this.A); this.cycles+=4; }); // MOV (X),A
      OP(0xAF, function() { this.write(this.addr_ind_x_inc(), this.A); this.cycles+=4; }); // MOV (X)+,A
      OP(0xC7, function() { this.write(this.addr_ind_dp_x(), this.A); this.cycles+=7; }); // MOV [dp+X],A
      OP(0xD7, function() { this.write(this.addr_ind_dp_y(), this.A); this.cycles+=7; }); // MOV [dp]+Y,A
      // X from/to memory
      OP(0xF8, function() { this.X = this.read(this.addr_dp()); this.setFlags(this.X); this.cycles+=3; }); // MOV X,dp
      OP(0xF9, function() { this.X = this.read(this.addr_dp_y()); this.setFlags(this.X); this.cycles+=4; }); // MOV X,dp+Y
      OP(0xE9, function() { this.X = this.read(this.addr_abs()); this.setFlags(this.X); this.cycles+=4; }); // MOV X,abs
      OP(0xD8, function() { this.write(this.addr_dp(), this.X); this.cycles+=4; }); // MOV dp,X
      OP(0xD9, function() { this.write(this.addr_dp_y(), this.X); this.cycles+=5; }); // MOV dp+Y,X
      OP(0xC9, function() { this.write(this.addr_abs(), this.X); this.cycles+=5; }); // MOV abs,X
      // Y from/to memory
      OP(0xEB, function() { this.Y = this.read(this.addr_dp()); this.setFlags(this.Y); this.cycles+=3; }); // MOV Y,dp
      OP(0xFB, function() { this.Y = this.read(this.addr_dp_x()); this.setFlags(this.Y); this.cycles+=4; }); // MOV Y,dp+X
      OP(0xEC, function() { this.Y = this.read(this.addr_abs()); this.setFlags(this.Y); this.cycles+=4; }); // MOV Y,abs
      OP(0xCB, function() { this.write(this.addr_dp(), this.Y); this.cycles+=4; }); // MOV dp,Y
      OP(0xDB, function() { this.write(this.addr_dp_x(), this.Y); this.cycles+=5; }); // MOV dp+X,Y
      OP(0xCC, function() { this.write(this.addr_abs(), this.Y); this.cycles+=5; }); // MOV abs,Y
      // Register transfers
      OP(0x5D, function() { this.X = this.A; this.setFlags(this.X); this.cycles+=2; }); // MOV X,A
      OP(0x7D, function() { this.A = this.X; this.setFlags(this.A); this.cycles+=2; }); // MOV A,X
      OP(0xDD, function() { this.A = this.Y; this.setFlags(this.A); this.cycles+=2; }); // MOV A,Y
      OP(0xFD, function() { this.Y = this.A; this.setFlags(this.Y); this.cycles+=2; }); // MOV Y,A
      OP(0x9D, function() { this.X = this.SP; this.setFlags(this.X); this.cycles+=2; }); // MOV X,SP
      OP(0xBD, function() { this.SP = this.X; this.cycles+=2; }); // MOV SP,X
      // MOV dp,dp
      OP(0xFA, function() { let s=this.fetch()|this.getDPBase(); let d=this.fetch()|this.getDPBase(); this.write(d, this.read(s)); this.cycles+=5; });
      // MOV dp,#imm
      OP(0x8F, function() { let imm=this.fetch(); let dp=this.addr_dp(); this.write(dp, imm); this.cycles+=5; });

      // ========================
      // Word Operations
      // ========================
      OP(0xBA, function() { let dp=this.addr_dp(); this.A=this.read(dp); this.Y=this.read(dpNext(dp)); let ya=(this.Y<<8)|this.A; this.setFlag(0x02, ya===0); this.setFlag(0x80, this.Y&0x80); this.cycles+=5; }); // MOVW YA,dp
      OP(0xDA, function() { let dp=this.addr_dp(); this.write(dp, this.A); this.write(dpNext(dp), this.Y); this.cycles+=4; }); // MOVW dp,YA
      OP(0x1A, function() { let dp=this.addr_dp(); let val=this.read(dp)|(this.read(dpNext(dp))<<8); val=(val-1)&0xFFFF; this.write(dp,val&0xFF); this.write(dpNext(dp),val>>8); this.setFlag(0x80, val&0x8000); this.setFlag(0x02, val===0); this.cycles+=6; }); // DECW dp
      OP(0x3A, function() { let dp=this.addr_dp(); let val=this.read(dp)|(this.read(dpNext(dp))<<8); val=(val+1)&0xFFFF; this.write(dp,val&0xFF); this.write(dpNext(dp),val>>8); this.setFlag(0x80, val&0x8000); this.setFlag(0x02, val===0); this.cycles+=6; }); // INCW dp
      OP(0x7A, function() { let dp=this.addr_dp(); let val=this.read(dp)|(this.read(dpNext(dp))<<8); let ya=(this.Y<<8)|this.A; let r=ya+val; this.A=r&0xFF; this.Y=(r>>8)&0xFF; this.setFlag(0x80, r&0x8000); this.setFlag(0x02, (r&0xFFFF)===0); this.setFlag(1, r>0xFFFF); this.setFlag(0x40, ~(ya^val)&(ya^r)&0x8000); this.setFlag(8, ((ya&0xFFF)+(val&0xFFF))>0xFFF); this.cycles+=5; }); // ADDW YA,dp
      OP(0x9A, function() { let dp=this.addr_dp(); let val=this.read(dp)|(this.read(dpNext(dp))<<8); let ya=(this.Y<<8)|this.A; let r=ya-val; this.A=r&0xFF; this.Y=(r>>8)&0xFF; this.setFlag(0x80, r&0x8000); this.setFlag(0x02, (r&0xFFFF)===0); this.setFlag(1, r>=0); this.setFlag(0x40, (ya^val)&(ya^r)&0x8000); this.setFlag(8, ((ya&0xFFF)-(val&0xFFF))>=0); this.cycles+=5; }); // SUBW YA,dp
      OP(0x5A, function() { let dp=this.addr_dp(); let val=this.read(dp)|(this.read(dpNext(dp))<<8); let ya=(this.Y<<8)|this.A; let r=ya-val; this.setFlag(0x80, r&0x8000); this.setFlag(0x02, (r&0xFFFF)===0); this.setFlag(1, r>=0); this.cycles+=4; }); // CMPW YA,dp

      // ========================
      // ALU: ADC
      // ========================
      { const adc = (a,b) => { let c=(this.PSW&1)?1:0; let r=a+b+c; this.setFlags(r&0xFF); this.setFlag(1, r>255); this.setFlag(0x40, ~(a^b)&(a^r)&0x80); this.setFlag(8, ((a&0xf)+(b&0xf)+c)>0xf); return r&0xFF; };
        OP(0x88, function() { this.A = adc(this.A, this.fetch()); this.cycles+=2; }); // ADC A,#imm
        OP(0x84, function() { this.A = adc(this.A, this.read(this.addr_dp())); this.cycles+=3; }); // ADC A,dp
        OP(0x94, function() { this.A = adc(this.A, this.read(this.addr_dp_x())); this.cycles+=4; }); // ADC A,dp+X
        OP(0x85, function() { this.A = adc(this.A, this.read(this.addr_abs())); this.cycles+=4; }); // ADC A,abs
        OP(0x95, function() { this.A = adc(this.A, this.read(this.addr_abs_x())); this.cycles+=5; }); // ADC A,abs+X
        OP(0x96, function() { this.A = adc(this.A, this.read(this.addr_abs_y())); this.cycles+=5; }); // ADC A,abs+Y
        OP(0x86, function() { this.A = adc(this.A, this.read(this.addr_ind_x())); this.cycles+=3; }); // ADC A,(X)
        OP(0x87, function() { this.A = adc(this.A, this.read(this.addr_ind_dp_x())); this.cycles+=6; }); // ADC A,[dp+X]
        OP(0x97, function() { this.A = adc(this.A, this.read(this.addr_ind_dp_y())); this.cycles+=6; }); // ADC A,[dp]+Y
        OP(0x98, function() { let imm=this.fetch(); let dp=this.addr_dp(); this.write(dp, adc(this.read(dp), imm)); this.cycles+=5; }); // ADC dp,#imm
        OP(0x89, function() { let s=this.fetch()|this.getDPBase(); let d=this.fetch()|this.getDPBase(); this.write(d, adc(this.read(d), this.read(s))); this.cycles+=6; }); // ADC dp,dp
        OP(0x99, function() { let x=this.X|this.getDPBase(); let y=this.Y|this.getDPBase(); this.write(x, adc(this.read(x), this.read(y))); this.cycles+=5; }); // ADC (X),(Y)
      }

      // ========================
      // ALU: SBC
      // ========================
      { const sbc = (a,b) => { let c=(this.PSW&1)?0:1; let r=a-b-c; this.setFlags(r&0xFF); this.setFlag(1, r>=0); this.setFlag(0x40, (a^b)&(a^r)&0x80); this.setFlag(8, ((a&0xf)-(b&0xf)-c)>=0); return r&0xFF; };
        OP(0xA8, function() { this.A = sbc(this.A, this.fetch()); this.cycles+=2; }); // SBC A,#imm
        OP(0xA4, function() { this.A = sbc(this.A, this.read(this.addr_dp())); this.cycles+=3; }); // SBC A,dp
        OP(0xB4, function() { this.A = sbc(this.A, this.read(this.addr_dp_x())); this.cycles+=4; }); // SBC A,dp+X
        OP(0xA5, function() { this.A = sbc(this.A, this.read(this.addr_abs())); this.cycles+=4; }); // SBC A,abs
        OP(0xB5, function() { this.A = sbc(this.A, this.read(this.addr_abs_x())); this.cycles+=5; }); // SBC A,abs+X
        OP(0xB6, function() { this.A = sbc(this.A, this.read(this.addr_abs_y())); this.cycles+=5; }); // SBC A,abs+Y
        OP(0xA6, function() { this.A = sbc(this.A, this.read(this.addr_ind_x())); this.cycles+=3; }); // SBC A,(X)
        OP(0xA7, function() { this.A = sbc(this.A, this.read(this.addr_ind_dp_x())); this.cycles+=6; }); // SBC A,[dp+X]
        OP(0xB7, function() { this.A = sbc(this.A, this.read(this.addr_ind_dp_y())); this.cycles+=6; }); // SBC A,[dp]+Y
        OP(0xB8, function() { let imm=this.fetch(); let dp=this.addr_dp(); this.write(dp, sbc(this.read(dp), imm)); this.cycles+=5; }); // SBC dp,#imm
        OP(0xA9, function() { let s=this.fetch()|this.getDPBase(); let d=this.fetch()|this.getDPBase(); this.write(d, sbc(this.read(d), this.read(s))); this.cycles+=6; }); // SBC dp,dp
        OP(0xB9, function() { let x=this.X|this.getDPBase(); let y=this.Y|this.getDPBase(); this.write(x, sbc(this.read(x), this.read(y))); this.cycles+=5; }); // SBC (X),(Y)
      }

      // ========================
      // ALU: CMP
      // ========================
      { const cmp = (a,b) => { let r=a-b; this.setFlags(r&0xFF); this.setFlag(1, r>=0); };
        OP(0x68, function() { cmp(this.A, this.fetch()); this.cycles+=2; }); // CMP A,#imm
        OP(0x64, function() { cmp(this.A, this.read(this.addr_dp())); this.cycles+=3; }); // CMP A,dp
        OP(0x74, function() { cmp(this.A, this.read(this.addr_dp_x())); this.cycles+=4; }); // CMP A,dp+X
        OP(0x65, function() { cmp(this.A, this.read(this.addr_abs())); this.cycles+=4; }); // CMP A,abs
        OP(0x75, function() { cmp(this.A, this.read(this.addr_abs_x())); this.cycles+=5; }); // CMP A,abs+X
        OP(0x76, function() { cmp(this.A, this.read(this.addr_abs_y())); this.cycles+=5; }); // CMP A,abs+Y
        OP(0x66, function() { cmp(this.A, this.read(this.addr_ind_x())); this.cycles+=3; }); // CMP A,(X)
        OP(0x67, function() { cmp(this.A, this.read(this.addr_ind_dp_x())); this.cycles+=6; }); // CMP A,[dp+X]
        OP(0x77, function() { cmp(this.A, this.read(this.addr_ind_dp_y())); this.cycles+=6; }); // CMP A,[dp]+Y
        OP(0x78, function() { let imm=this.fetch(); let dp=this.addr_dp(); cmp(this.read(dp), imm); this.cycles+=5; }); // CMP dp,#imm
        OP(0x69, function() { let s=this.fetch()|this.getDPBase(); let d=this.fetch()|this.getDPBase(); cmp(this.read(d), this.read(s)); this.cycles+=6; }); // CMP dp,dp
        OP(0x79, function() { let x=this.X|this.getDPBase(); let y=this.Y|this.getDPBase(); cmp(this.read(x), this.read(y)); this.cycles+=5; }); // CMP (X),(Y)
        OP(0xC8, function() { cmp(this.X, this.fetch()); this.cycles+=2; }); // CMP X,#imm
        OP(0x3E, function() { cmp(this.X, this.read(this.addr_dp())); this.cycles+=3; }); // CMP X,dp
        OP(0x1E, function() { cmp(this.X, this.read(this.addr_abs())); this.cycles+=4; }); // CMP X,abs
        OP(0xAD, function() { cmp(this.Y, this.fetch()); this.cycles+=2; }); // CMP Y,#imm
        OP(0x7E, function() { cmp(this.Y, this.read(this.addr_dp())); this.cycles+=3; }); // CMP Y,dp
        OP(0x5E, function() { cmp(this.Y, this.read(this.addr_abs())); this.cycles+=4; }); // CMP Y,abs
      }

      // ========================
      // ALU: AND
      // ========================
      { const and = (a,b) => { let r=a&b; this.setFlags(r); return r; };
        OP(0x28, function() { this.A = and(this.A, this.fetch()); this.cycles+=2; }); // AND A,#imm
        OP(0x24, function() { this.A = and(this.A, this.read(this.addr_dp())); this.cycles+=3; }); // AND A,dp
        OP(0x34, function() { this.A = and(this.A, this.read(this.addr_dp_x())); this.cycles+=4; }); // AND A,dp+X
        OP(0x25, function() { this.A = and(this.A, this.read(this.addr_abs())); this.cycles+=4; }); // AND A,abs
        OP(0x35, function() { this.A = and(this.A, this.read(this.addr_abs_x())); this.cycles+=5; }); // AND A,abs+X
        OP(0x36, function() { this.A = and(this.A, this.read(this.addr_abs_y())); this.cycles+=5; }); // AND A,abs+Y
        OP(0x26, function() { this.A = and(this.A, this.read(this.addr_ind_x())); this.cycles+=3; }); // AND A,(X)
        OP(0x27, function() { this.A = and(this.A, this.read(this.addr_ind_dp_x())); this.cycles+=6; }); // AND A,[dp+X]
        OP(0x37, function() { this.A = and(this.A, this.read(this.addr_ind_dp_y())); this.cycles+=6; }); // AND A,[dp]+Y
        OP(0x38, function() { let imm=this.fetch(); let dp=this.addr_dp(); this.write(dp, and(this.read(dp), imm)); this.cycles+=5; }); // AND dp,#imm
        OP(0x29, function() { let s=this.fetch()|this.getDPBase(); let d=this.fetch()|this.getDPBase(); this.write(d, and(this.read(d), this.read(s))); this.cycles+=6; }); // AND dp,dp
        OP(0x39, function() { let x=this.X|this.getDPBase(); let y=this.Y|this.getDPBase(); this.write(x, and(this.read(x), this.read(y))); this.cycles+=5; }); // AND (X),(Y)
      }

      // ========================
      // ALU: OR
      // ========================
      { const or = (a,b) => { let r=a|b; this.setFlags(r); return r; };
        OP(0x08, function() { this.A = or(this.A, this.fetch()); this.cycles+=2; }); // OR A,#imm
        OP(0x04, function() { this.A = or(this.A, this.read(this.addr_dp())); this.cycles+=3; }); // OR A,dp
        OP(0x14, function() { this.A = or(this.A, this.read(this.addr_dp_x())); this.cycles+=4; }); // OR A,dp+X
        OP(0x05, function() { this.A = or(this.A, this.read(this.addr_abs())); this.cycles+=4; }); // OR A,abs
        OP(0x15, function() { this.A = or(this.A, this.read(this.addr_abs_x())); this.cycles+=5; }); // OR A,abs+X
        OP(0x16, function() { this.A = or(this.A, this.read(this.addr_abs_y())); this.cycles+=5; }); // OR A,abs+Y
        OP(0x06, function() { this.A = or(this.A, this.read(this.addr_ind_x())); this.cycles+=3; }); // OR A,(X)
        OP(0x07, function() { this.A = or(this.A, this.read(this.addr_ind_dp_x())); this.cycles+=6; }); // OR A,[dp+X]
        OP(0x17, function() { this.A = or(this.A, this.read(this.addr_ind_dp_y())); this.cycles+=6; }); // OR A,[dp]+Y
        OP(0x18, function() { let imm=this.fetch(); let dp=this.addr_dp(); this.write(dp, or(this.read(dp), imm)); this.cycles+=5; }); // OR dp,#imm
        OP(0x09, function() { let s=this.fetch()|this.getDPBase(); let d=this.fetch()|this.getDPBase(); this.write(d, or(this.read(d), this.read(s))); this.cycles+=6; }); // OR dp,dp
        OP(0x19, function() { let x=this.X|this.getDPBase(); let y=this.Y|this.getDPBase(); this.write(x, or(this.read(x), this.read(y))); this.cycles+=5; }); // OR (X),(Y)
      }

      // ========================
      // ALU: EOR
      // ========================
      { const eor = (a,b) => { let r=a^b; this.setFlags(r); return r; };
        OP(0x48, function() { this.A = eor(this.A, this.fetch()); this.cycles+=2; }); // EOR A,#imm
        OP(0x44, function() { this.A = eor(this.A, this.read(this.addr_dp())); this.cycles+=3; }); // EOR A,dp
        OP(0x54, function() { this.A = eor(this.A, this.read(this.addr_dp_x())); this.cycles+=4; }); // EOR A,dp+X
        OP(0x45, function() { this.A = eor(this.A, this.read(this.addr_abs())); this.cycles+=4; }); // EOR A,abs
        OP(0x55, function() { this.A = eor(this.A, this.read(this.addr_abs_x())); this.cycles+=5; }); // EOR A,abs+X
        OP(0x56, function() { this.A = eor(this.A, this.read(this.addr_abs_y())); this.cycles+=5; }); // EOR A,abs+Y
        OP(0x46, function() { this.A = eor(this.A, this.read(this.addr_ind_x())); this.cycles+=3; }); // EOR A,(X)
        OP(0x47, function() { this.A = eor(this.A, this.read(this.addr_ind_dp_x())); this.cycles+=6; }); // EOR A,[dp+X]
        OP(0x57, function() { this.A = eor(this.A, this.read(this.addr_ind_dp_y())); this.cycles+=6; }); // EOR A,[dp]+Y
        OP(0x58, function() { let imm=this.fetch(); let dp=this.addr_dp(); this.write(dp, eor(this.read(dp), imm)); this.cycles+=5; }); // EOR dp,#imm
        OP(0x49, function() { let s=this.fetch()|this.getDPBase(); let d=this.fetch()|this.getDPBase(); this.write(d, eor(this.read(d), this.read(s))); this.cycles+=6; }); // EOR dp,dp
        OP(0x59, function() { let x=this.X|this.getDPBase(); let y=this.Y|this.getDPBase(); this.write(x, eor(this.read(x), this.read(y))); this.cycles+=5; }); // EOR (X),(Y)
      }

      // ========================
      // Shift / Rotate
      // ========================
      const asl = (v) => { this.setFlag(1, v&0x80); let r=(v<<1)&0xFF; this.setFlags(r); return r; };
      const rol = (v) => { let c=this.PSW&1; this.setFlag(1, v&0x80); let r=((v<<1)|c)&0xFF; this.setFlags(r); return r; };
      const lsr = (v) => { this.setFlag(1, v&1); let r=v>>1; this.setFlags(r); return r; };
      const ror = (v) => { let c=this.PSW&1; this.setFlag(1, v&1); let r=(v>>1)|(c?0x80:0); this.setFlags(r); return r; };
      // ASL
      OP(0x1C, function() { this.A = asl(this.A); this.cycles+=2; });
      OP(0x0B, function() { let a=this.addr_dp(); this.write(a, asl(this.read(a))); this.cycles+=4; });
      OP(0x1B, function() { let a=this.addr_dp_x(); this.write(a, asl(this.read(a))); this.cycles+=5; });
      OP(0x0C, function() { let a=this.addr_abs(); this.write(a, asl(this.read(a))); this.cycles+=5; });
      // ROL
      OP(0x3C, function() { this.A = rol(this.A); this.cycles+=2; });
      OP(0x2B, function() { let a=this.addr_dp(); this.write(a, rol(this.read(a))); this.cycles+=4; });
      OP(0x3B, function() { let a=this.addr_dp_x(); this.write(a, rol(this.read(a))); this.cycles+=5; });
      OP(0x2C, function() { let a=this.addr_abs(); this.write(a, rol(this.read(a))); this.cycles+=5; });
      // LSR
      OP(0x5C, function() { this.A = lsr(this.A); this.cycles+=2; });
      OP(0x4B, function() { let a=this.addr_dp(); this.write(a, lsr(this.read(a))); this.cycles+=4; });
      OP(0x5B, function() { let a=this.addr_dp_x(); this.write(a, lsr(this.read(a))); this.cycles+=5; });
      OP(0x4C, function() { let a=this.addr_abs(); this.write(a, lsr(this.read(a))); this.cycles+=5; });
      // ROR
      OP(0x7C, function() { this.A = ror(this.A); this.cycles+=2; });
      OP(0x6B, function() { let a=this.addr_dp(); this.write(a, ror(this.read(a))); this.cycles+=4; });
      OP(0x7B, function() { let a=this.addr_dp_x(); this.write(a, ror(this.read(a))); this.cycles+=5; });
      OP(0x6C, function() { let a=this.addr_abs(); this.write(a, ror(this.read(a))); this.cycles+=5; });

      // ========================
      // Inc / Dec
      // ========================
      OP(0xBC, function() { this.A = (this.A + 1) & 0xFF; this.setFlags(this.A); this.cycles+=2; }); // INC A
      OP(0x3D, function() { this.X = (this.X + 1) & 0xFF; this.setFlags(this.X); this.cycles+=2; }); // INC X
      OP(0xFC, function() { this.Y = (this.Y + 1) & 0xFF; this.setFlags(this.Y); this.cycles+=2; }); // INC Y
      OP(0xAB, function() { let dp=this.addr_dp(); let v=(this.read(dp)+1)&0xFF; this.write(dp,v); this.setFlags(v); this.cycles+=4; }); // INC dp
      OP(0xBB, function() { let dp=this.addr_dp_x(); let v=(this.read(dp)+1)&0xFF; this.write(dp,v); this.setFlags(v); this.cycles+=5; }); // INC dp+X
      OP(0xAC, function() { let a=this.addr_abs(); let v=(this.read(a)+1)&0xFF; this.write(a,v); this.setFlags(v); this.cycles+=5; }); // INC abs
      OP(0x9C, function() { this.A = (this.A - 1) & 0xFF; this.setFlags(this.A); this.cycles+=2; }); // DEC A
      OP(0x1D, function() { this.X = (this.X - 1) & 0xFF; this.setFlags(this.X); this.cycles+=2; }); // DEC X
      OP(0xDC, function() { this.Y = (this.Y - 1) & 0xFF; this.setFlags(this.Y); this.cycles+=2; }); // DEC Y
      OP(0x8B, function() { let dp=this.addr_dp(); let v=(this.read(dp)-1)&0xFF; this.write(dp,v); this.setFlags(v); this.cycles+=4; }); // DEC dp
      OP(0x9B, function() { let dp=this.addr_dp_x(); let v=(this.read(dp)-1)&0xFF; this.write(dp,v); this.setFlags(v); this.cycles+=5; }); // DEC dp+X
      OP(0x8C, function() { let a=this.addr_abs(); let v=(this.read(a)-1)&0xFF; this.write(a,v); this.setFlags(v); this.cycles+=5; }); // DEC abs

      // ========================
      // MUL / DIV
      // ========================
      OP(0xCF, function() { let r=this.Y*this.A; this.A=r&0xFF; this.Y=(r>>8)&0xFF; this.setFlags(this.Y); this.cycles+=9; }); // MUL YA
      OP(0x9E, function() { // DIV YA,X
          let ya=(this.Y<<8)|this.A;
          let x=this.X;
          this.setFlag(0x40, (this.Y & 0x0F) >= (this.X & 0x0F)); // H flag
          if (x === 0) {
              this.setFlag(0x40, true);
              this.A = 0xFF; this.Y = ya & 0xFF;
          } else if (this.Y >= x) {
              this.A = 0xFF; this.Y = 0xFF;
              this.setFlag(0x40, true);
          } else {
              this.A = Math.floor(ya / x) & 0xFF;
              this.Y = (ya % x) & 0xFF;
          }
          this.setFlags(this.A);
          this.cycles+=12;
      });

      // ========================
      // Branches
      // ========================
      OP(0x2F, function() { branch(true); }); // BRA
      OP(0xF0, function() { branch((this.PSW & 0x02) !== 0); }); // BEQ (Z=1)
      OP(0xD0, function() { branch((this.PSW & 0x02) === 0); }); // BNE (Z=0)
      OP(0xB0, function() { branch((this.PSW & 0x01) !== 0); }); // BCS (C=1)
      OP(0x90, function() { branch((this.PSW & 0x01) === 0); }); // BCC (C=0)
      OP(0x70, function() { branch((this.PSW & 0x40) !== 0); }); // BVS (V=1)
      OP(0x50, function() { branch((this.PSW & 0x40) === 0); }); // BVC (V=0)
      OP(0x30, function() { branch((this.PSW & 0x80) !== 0); }); // BMI (N=1)
      OP(0x10, function() { branch((this.PSW & 0x80) === 0); }); // BPL (N=0)
      // CBNE
      OP(0x2E, function() { let dp=this.addr_dp(); let rel=this.fetch(); if(rel>127)rel-=256; if(this.A!==this.read(dp)){this.PC=(this.PC+rel)&0xFFFF;this.cycles+=7;}else{this.cycles+=5;} }); // CBNE dp,rel
      OP(0xDE, function() { let dp=this.addr_dp_x(); let rel=this.fetch(); if(rel>127)rel-=256; if(this.A!==this.read(dp)){this.PC=(this.PC+rel)&0xFFFF;this.cycles+=8;}else{this.cycles+=6;} }); // CBNE dp+X,rel
      // DBNZ
      OP(0x6E, function() { let dp=this.addr_dp(); let rel=this.fetch(); if(rel>127)rel-=256; let v=(this.read(dp)-1)&0xFF; this.write(dp,v); if(v!==0){this.PC=(this.PC+rel)&0xFFFF;this.cycles+=7;}else{this.cycles+=5;} }); // DBNZ dp,rel
      OP(0xFE, function() { let rel=this.fetch(); if(rel>127)rel-=256; this.Y=(this.Y-1)&0xFF; if(this.Y!==0){this.PC=(this.PC+rel)&0xFFFF;this.cycles+=6;}else{this.cycles+=4;} }); // DBNZ Y,rel

      // ========================
      // Bit branches: BBS / BBC (all 8 bits)
      // ========================
      for (let b = 0; b < 8; b++) {
          const bit = 1 << b;
          OP(0x03 | (b * 0x20), function() { let dp = this.addr_dp(); let rel = this.fetch(); if (rel > 127) rel -= 256; if (this.read(dp) & bit) { this.PC = (this.PC + rel) & 0xFFFF; this.cycles += 7; } else { this.cycles += 5; } }); // BBS b
          OP(0x13 | (b * 0x20), function() { let dp = this.addr_dp(); let rel = this.fetch(); if (rel > 127) rel -= 256; if (!(this.read(dp) & bit)) { this.PC = (this.PC + rel) & 0xFFFF; this.cycles += 7; } else { this.cycles += 5; } }); // BBC b
      }

      // ========================
      // Bit SET1 / CLR1 (all 8 bits)
      // ========================
      for (let b = 0; b < 8; b++) {
          const bit = 1 << b;
          OP(0x02 | (b * 0x20), function() { let dp = this.addr_dp(); this.write(dp, this.read(dp) | bit); this.cycles += 4; }); // SET1 b
          OP(0x12 | (b * 0x20), function() { let dp = this.addr_dp(); this.write(dp, this.read(dp) & ~bit); this.cycles += 4; }); // CLR1 b
      }

      // ========================
      // TSET1 / TCLR1
      // ========================
      OP(0x0E, function() { let abs=this.addr_abs(); let v=this.read(abs); this.setFlags(this.A-v); this.write(abs, v | this.A); this.cycles+=6; }); // TSET1 abs
      OP(0x4E, function() { let abs=this.addr_abs(); let v=this.read(abs); this.setFlags(this.A-v); this.write(abs, v & ~this.A); this.cycles+=6; }); // TCLR1 abs

      // ========================
      // Push / Pop
      // ========================
      OP(0x2D, function() { this.push(this.A); this.cycles+=4; }); // PUSH A
      OP(0x4D, function() { this.push(this.X); this.cycles+=4; }); // PUSH X
      OP(0x6D, function() { this.push(this.Y); this.cycles+=4; }); // PUSH Y
      OP(0x0D, function() { this.push(this.PSW); this.cycles+=4; }); // PUSH PSW
      OP(0xAE, function() { this.A = this.pop(); this.cycles+=4; }); // POP A
      OP(0xCE, function() { this.X = this.pop(); this.cycles+=4; }); // POP X
      OP(0xEE, function() { this.Y = this.pop(); this.cycles+=4; }); // POP Y
      OP(0x8E, function() { this.PSW = this.pop(); this.cycles+=4; }); // POP PSW

      // ========================
      // Subroutines / Jumps
      // ========================
      OP(0x3F, function() { let addr=this.fetch16(); this.push16(this.PC); this.PC=addr; this.cycles+=8; }); // CALL abs
      OP(0x4F, function() { let off=this.fetch(); this.push16(this.PC); this.PC=0xFF00|off; this.cycles+=6; }); // PCALL u8
      OP(0x5F, function() { this.PC=this.fetch16(); this.cycles+=3; }); // JMP abs
      OP(0x1F, function() { let addr=this.fetch16(); let lo=this.read((addr+this.X)&0xFFFF); let hi=this.read((addr+this.X+1)&0xFFFF); this.PC=(hi<<8)|lo; this.cycles+=6; }); // JMP [abs+X]
      OP(0x6F, function() { this.PC=this.pop16(); this.cycles+=5; }); // RET
      OP(0x7F, function() { this.PSW=this.pop(); this.PC=this.pop16(); this.cycles+=6; }); // RETI

      // ========================
      // TCALL (Table Call) - 16 vectors at $FFDE down to $FFC0
      // ========================
      for (let n = 0; n < 16; n++) {
          const vecAddr = 0xFFDE - (n * 2);
          OP(0x01 | (n << 4), function() { this.push16(this.PC); this.PC = this.read(vecAddr) | (this.read(vecAddr + 1) << 8); this.cycles += 8; });
      }

      // ========================
      // Flag operations
      // ========================
      OP(0x60, function() { this.PSW &= ~0x01; this.cycles+=2; }); // CLRC
      OP(0x80, function() { this.PSW |= 0x01; this.cycles+=2; });  // SETC
      OP(0xED, function() { this.PSW ^= 0x01; this.cycles+=3; });  // NOTC
      OP(0xE0, function() { this.PSW &= ~(0x40 | 0x08); this.cycles+=2; }); // CLRV (clear V and H flags)
      OP(0x20, function() { this.PSW &= ~0x20; this.cycles+=2; }); // CLRP
      OP(0x40, function() { this.PSW |= 0x20; this.cycles+=2; });  // SETP
      OP(0xA0, function() { this.PSW |= 0x04; this.cycles+=3; });  // EI
      OP(0xC0, function() { this.PSW &= ~0x04; this.cycles+=3; }); // DI

      // ========================
      // Misc
      // ========================
      OP(0x00, function() { this.cycles+=2; }); // NOP
      OP(0xEF, function() { this.PC=(this.PC-1)&0xFFFF; this.cycles+=3; }); // SLEEP (loop in place)
      OP(0xFF, function() { this.PC=(this.PC-1)&0xFFFF; this.cycles+=3; }); // STOP (loop in place)
      OP(0x9F, function() { this.A = ((this.A >> 4) | ((this.A & 0x0F) << 4)) & 0xFF; this.setFlags(this.A); this.cycles+=5; }); // XCN (exchange nibbles)
      OP(0xDF, function() { // DAA
          let a = this.A;
          if (((this.PSW & 0x08) !== 0) || (a & 0x0F) > 9) { a += 6; }
          if (((this.PSW & 0x01) !== 0) || a > 0x9F) { a += 0x60; this.PSW |= 0x01; }
          this.A = a & 0xFF; this.setFlags(this.A); this.cycles += 3;
      });
      OP(0xBE, function() { // DAS
          let a = this.A;
          if (!((this.PSW & 0x08) !== 0) || (a & 0x0F) > 9) { a -= 6; }
          if (!((this.PSW & 0x01) !== 0) || a > 0x9F) { a -= 0x60; this.PSW &= ~0x01; }
          this.A = a & 0xFF; this.setFlags(this.A); this.cycles += 3;
      });

      // ========================
      // Bit manipulation (memory bit operations)
      // ========================
      // MOV1 C, mem.bit  (0xAA)
      OP(0xAA, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; this.setFlag(1, (this.read(abs)>>bit)&1); this.cycles+=4; });
      // MOV1 mem.bit, C  (0xCA)
      OP(0xCA, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; let v=this.read(abs); if(this.PSW&1) v|=(1<<bit); else v&=~(1<<bit); this.write(abs,v); this.cycles+=6; });
      // OR1 C, mem.bit   (0x0A)
      OP(0x0A, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; if((this.read(abs)>>bit)&1) this.PSW|=1; this.cycles+=5; });
      // OR1 C, /mem.bit  (0x2A)
      OP(0x2A, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; if(!((this.read(abs)>>bit)&1)) this.PSW|=1; this.cycles+=5; });
      // AND1 C, mem.bit  (0x4A)
      OP(0x4A, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; if(!((this.read(abs)>>bit)&1)) this.PSW&=~1; this.cycles+=4; });
      // AND1 C, /mem.bit (0x6A)
      OP(0x6A, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; if((this.read(abs)>>bit)&1) this.PSW&=~1; this.cycles+=4; });
      // EOR1 C, mem.bit  (0x8A)
      OP(0x8A, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; if((this.read(abs)>>bit)&1) this.PSW^=1; this.cycles+=5; });
      // NOT1 mem.bit     (0xEA)
      OP(0xEA, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; this.write(abs, this.read(abs)^(1<<bit)); this.cycles+=5; });

  }
}
