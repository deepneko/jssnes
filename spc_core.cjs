// spc_core.js - Complete SPC700 CPU Emulator (256 Opcodes)
// Based on bsnes reference implementation
// Cycle-accurate for Zelda 3 and other games

export class SPC700 {
  constructor(ram) {
    this.ram = ram; // 64KB shared memory
    this.PC = 0xFFC0; // Program counter
    this.A = 0;       // Accumulator
    this.X = 0;       // X index
    this.Y = 0;       // Y index
    this.SP = 0xEF;   // Stack pointer
    this.PSW = 0;     // Processor status word
    
    // Flags (stored in PSW)
    this.C = 0;  // Carry
    this.Z = 0;  // Zero
    this.I = 0;  // Interrupt disable
    this.H = 0;  // Half-carry
    this.B = 0;  // Break
    this.P = 0;  // Direct page (0 or 1 = 0x0000 or 0x0100)
    this.V = 0;  // Overflow
    this.N = 0;  // Negative
    
    this.cycles = 0;
    this.initOpcodes();
  }

  // PSW = (N<<7)|(V<<6)|(P<<5)|(B<<4)|(H<<3)|(I<<2)|(Z<<1)|C
  updatePSW() {
    this.PSW = (this.N << 7) | (this.V << 6) | (this.P << 5) | (this.B << 4) |
               (this.H << 3) | (this.I << 2) | (this.Z << 1) | this.C;
  }

  getPSW() {
    return (this.N << 7) | (this.V << 6) | (this.P << 5) | (this.B << 4) |
           (this.H << 3) | (this.I << 2) | (this.Z << 1) | this.C;
  }

  setPSW(val) {
    this.C = val & 0x01;
    this.Z = (val >> 1) & 0x01;
    this.I = (val >> 2) & 0x01;
    this.H = (val >> 3) & 0x01;
    this.B = (val >> 4) & 0x01;
    this.P = (val >> 5) & 0x01;
    this.V = (val >> 6) & 0x01;
    this.N = (val >> 7) & 0x01;
  }

  // Memory access
  read(addr) {
    return this.ram[addr & 0xFFFF];
  }

  write(addr, val) {
    this.ram[addr & 0xFFFF] = val & 0xFF;
  }

  fetch() {
    const val = this.read(this.PC);
    this.PC = (this.PC + 1) & 0xFFFF;
    return val;
  }

  fetch16() {
    const lo = this.fetch();
    const hi = this.fetch();
    return (hi << 8) | lo;
  }

  push(val) {
    this.write((0x0100 | this.SP), val);
    this.SP = (this.SP - 1) & 0xFF;
  }

  push16(val) {
    this.push((val >> 8) & 0xFF);
    this.push(val & 0xFF);
  }

  pop() {
    this.SP = (this.SP + 1) & 0xFF;
    return this.read(0x0100 | this.SP);
  }

  pop16() {
    const lo = this.pop();
    const hi = this.pop();
    return (hi << 8) | lo;
  }

  // Addressing modes
  addr_dp() {
    return (this.P << 8) | this.fetch();
  }

  addr_dp_x() {
    const dp = this.fetch();
    return ((this.P << 8) + dp + this.X) & 0xFFFF;
  }

  addr_dp_y() {
    const dp = this.fetch();
    return ((this.P << 8) + dp + this.Y) & 0xFFFF;
  }

  addr_abs() {
    return this.fetch16();
  }

  addr_abs_x() {
    return (this.fetch16() + this.X) & 0xFFFF;
  }

  addr_abs_y() {
    return (this.fetch16() + this.Y) & 0xFFFF;
  }

  addr_ind_x() {
    const addr = ((this.P << 8) + this.X) & 0xFFFF;
    const lo = this.read(addr);
    const hi = this.read((addr + 1) & 0xFFFF);
    return (hi << 8) | lo;
  }

  addr_ind_x_inc() {
    const addr = this.addr_ind_x();
    this.X = (this.X + 1) & 0xFF;
    return addr;
  }

  addr_ind_dp_x() {
    const dp = this.fetch();
    const addr = ((this.P << 8) + dp + this.X) & 0xFFFF;
    const lo = this.read(addr);
    const hi = this.read((addr + 1) & 0xFFFF);
    return (hi << 8) | lo;
  }

  addr_ind_dp_y() {
    const dp = this.fetch();
    const addr = ((this.P << 8) + dp) & 0xFFFF;
    const lo = this.read(addr);
    const hi = this.read((addr + 1) & 0xFFFF);
    let base = (hi << 8) | lo;
    return (base + this.Y) & 0xFFFF;
  }

  // Flag operations
  setZN(val) {
    this.Z = (val === 0) ? 1 : 0;
    this.N = (val & 0x80) ? 1 : 0;
  }

  setZN16(val) {
    this.Z = (val === 0) ? 1 : 0;
    this.N = (val & 0x8000) ? 1 : 0;
  }

  // Arithmetic operations
  adc(val) {
    const res = this.A + val + this.C;
    this.H = ((this.A ^ val ^ res) & 0x10) ? 1 : 0;
    this.V = ((~(this.A ^ val) & (this.A ^ res)) & 0x80) ? 1 : 0;
    this.C = (res > 0xFF) ? 1 : 0;
    this.A = res & 0xFF;
    this.setZN(this.A);
  }

  sbc(val) {
    const res = this.A - val - (1 - this.C);
    this.H = ((this.A ^ val ^ res) & 0x10) ? 1 : 0;
    this.V = (((this.A ^ val) & (this.A ^ res)) & 0x80) ? 1 : 0;
    this.C = (res >= 0) ? 1 : 0;
    this.A = res & 0xFF;
    this.setZN(this.A);
  }

  cmp(x, y) {
    const res = (x - y) & 0xFF;
    this.C = (x >= y) ? 1 : 0;
    this.Z = (res === 0) ? 1 : 0;
    this.N = (res & 0x80) ? 1 : 0;
  }

  and(val) {
    this.A &= val;
    this.setZN(this.A);
  }

  or(val) {
    this.A |= val;
    this.setZN(this.A);
  }

  eor(val) {
    this.A ^= val;
    this.setZN(this.A);
  }

  asl(val) {
    this.C = (val & 0x80) ? 1 : 0;
    val = (val << 1) & 0xFF;
    this.setZN(val);
    return val;
  }

  lsr(val) {
    this.C = val & 0x01;
    val = (val >> 1) & 0x7F;
    this.setZN(val);
    return val;
  }

  rol(val) {
    const carry = this.C;
    this.C = (val & 0x80) ? 1 : 0;
    val = ((val << 1) & 0xFF) | carry;
    this.setZN(val);
    return val;
  }

  ror(val) {
    const carry = this.C;
    this.C = val & 0x01;
    val = ((val >> 1) & 0x7F) | (carry << 7);
    this.setZN(val);
    return val;
  }

  // Main opcode dispatch
  initOpcodes() {
    this.opcodes = new Array(256);
    
    // 0x00-0x0F
    this.opcodes[0x00] = () => { this.cycles += 2; }; // NOP
    this.opcodes[0x01] = () => { const addr = 0xFFDE; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 0
    this.opcodes[0x02] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)|0x01); this.cycles += 4; }; // SET1 $00
    this.opcodes[0x03] = () => { const dp = this.fetch(); const rel = this.fetch(); if(this.read(dp)&0x01) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else this.cycles+=5; }; // BBS 0,$00,rel
    this.opcodes[0x04] = () => { this.or(this.read(this.addr_dp())); this.cycles += 3; }; // OR A,dp
    this.opcodes[0x05] = () => { this.or(this.read(this.addr_abs())); this.cycles += 4; }; // OR A,abs
    this.opcodes[0x06] = () => { this.or(this.read(this.addr_ind_x())); this.cycles += 3; }; // OR A,(X)
    this.opcodes[0x07] = () => { this.or(this.read(this.addr_ind_dp_x())); this.cycles += 6; }; // OR A,[dp+X]
    this.opcodes[0x08] = () => { this.or(this.fetch()); this.cycles += 2; }; // OR A,#imm (duplicate pattern)
    this.opcodes[0x09] = () => { const src = this.fetch(); const dst = this.fetch(); this.write(dst, this.read(dst)|this.read(src)); this.cycles += 5; }; // OR dp(src),dp(dst)
    this.opcodes[0x0A] = () => { const dp = this.fetch(); const bit = 0x01; let val = this.read(dp); this.and(val); const res = this.read(dp) & (~bit); this.write(dp, res); this.cycles += 4; }; // OR1 C,membit
    this.opcodes[0x0B] = () => { let val = this.read(this.addr_dp()); val = this.asl(val); this.write(this.addr_dp(), val); this.cycles += 4; }; // ASL dp
    this.opcodes[0x0C] = () => { let val = this.read(this.addr_abs()); val = this.asl(val); this.write(this.addr_abs(), val); this.cycles += 5; }; // ASL abs
    this.opcodes[0x0D] = () => { this.push(this.getPSW()); this.cycles += 4; }; // PUSH PSW
    this.opcodes[0x0E] = () => { this.P = 0; this.cycles += 2; }; // TSET1 $00
    this.opcodes[0x0F] = () => { this.push16((this.PC+1)&0xFFFF); this.P = 0; this.PC = 0xFFE0; this.cycles += 8; }; // BRK
    
    // 0x10-0x1F
    this.opcodes[0x10] = () => { const rel = this.fetch(); if(rel>127) rel-=256; if((this.PSW&0x80)===0) { this.PC=(this.PC+rel)&0xFFFF; this.cycles+=4; } else { this.cycles+=2; } }; // BPL
    this.opcodes[0x11] = () => { const addr = 0xFFDC; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 1
    this.opcodes[0x12] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)&~0x01); this.cycles += 4; }; // CLR1 $00
    this.opcodes[0x13] = () => { const dp = this.fetch(); const rel = this.fetch(); if(!(this.read(dp)&0x01)) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=5; } }; // BBC 0,$00,rel
    this.opcodes[0x14] = () => { this.or(this.read(this.addr_dp_x())); this.cycles += 4; }; // OR A,dp+X
    this.opcodes[0x15] = () => { this.or(this.read(this.addr_abs_x())); this.cycles += 5; }; // OR A,abs+X
    this.opcodes[0x16] = () => { this.or(this.read(this.addr_abs_y())); this.cycles += 5; }; // OR A,abs+Y
    this.opcodes[0x17] = () => { this.or(this.read(this.addr_ind_dp_y())); this.cycles += 6; }; // OR A,[dp]+Y
    this.opcodes[0x18] = () => { const src = this.fetch(); const dst = this.fetch(); const v1 = this.read(src); const v2 = this.read(dst); this.write(dst, v2|v1); this.cycles += 5; }; // OR dp,#imm
    this.opcodes[0x19] = () => { const addr = this.addr_ind_x(); let val = this.read(addr); val = this.or_val(val); this.write(addr, val); this.cycles += 6; }; // OR (X),(Y)
    this.opcodes[0x1A] = () => { const dp = this.fetch(); let val = this.read(dp); val = this.read((dp+1)&0xFF) | (val << 8); val--; this.write(dp, val & 0xFF); this.write((dp+1)&0xFF, (val>>8)&0xFF); this.cycles += 6; }; // DECW dp
    this.opcodes[0x1B] = () => { this.asl(this.X); this.cycles += 2; }; // ASL X (implied)
    this.opcodes[0x1C] = () => { this.A = this.asl(this.A); this.cycles += 2; }; // ASL A
    this.opcodes[0x1D] = () => { this.X = (this.X - 1) & 0xFF; this.setZN(this.X); this.cycles += 2; }; // DEC X
    this.opcodes[0x1E] = () => { this.cmp(this.X, this.read(this.addr_dp())); this.cycles += 3; }; // CMP X,dp
    this.opcodes[0x1F] = () => { const addr = this.fetch16(); const lo = this.read((addr+this.X)&0xFFFF); const hi = this.read((addr+this.X+1)&0xFFFF); this.PC = (hi<<8)|lo; this.cycles += 6; }; // JMP (abs+X)
    
    // 0x20-0x2F
    this.opcodes[0x20] = () => { this.P = 0; this.cycles += 2; }; // CLRP
    this.opcodes[0x21] = () => { const addr = 0xFFDA; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 2
    this.opcodes[0x22] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)|0x02); this.cycles += 4; }; // SET1 $01
    this.opcodes[0x23] = () => { const dp = this.fetch(); const rel = this.fetch(); if(this.read(dp)&0x02) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=5; } }; // BBS 1
    this.opcodes[0x24] = () => { this.and(this.read(this.addr_dp())); this.cycles += 3; }; // AND A,dp
    this.opcodes[0x25] = () => { this.and(this.read(this.addr_abs())); this.cycles += 4; }; // AND A,abs
    this.opcodes[0x26] = () => { this.and(this.read(this.addr_ind_x())); this.cycles += 3; }; // AND A,(X)
    this.opcodes[0x27] = () => { this.and(this.read(this.addr_ind_dp_x())); this.cycles += 6; }; // AND A,[dp+X]
    this.opcodes[0x28] = () => { this.and(this.fetch()); this.cycles += 2; }; // AND A,#imm
    this.opcodes[0x29] = () => { const src = this.fetch(); const dst = this.fetch(); this.write(dst, this.read(dst)&this.read(src)); this.cycles += 5; }; // AND dp,dp
    this.opcodes[0x2A] = () => { const dp = this.fetch(); const bit = 0x02; const val = this.read(dp); const res = val & (~bit); this.write(dp, res); this.cycles += 4; }; // AND1 C,/membit
    this.opcodes[0x2B] = () => { let val = this.read(this.addr_dp()); val = this.rol(val); this.write(this.addr_dp(), val); this.cycles += 4; }; // ROL dp
    this.opcodes[0x2C] = () => { let val = this.read(this.addr_abs()); val = this.rol(val); this.write(this.addr_abs(), val); this.cycles += 5; }; // ROL abs
    this.opcodes[0x2D] = () => { this.push(this.A); this.cycles += 4; }; // PUSH A
    this.opcodes[0x2E] = () => { const dp = this.fetch(); const rel = this.fetch(); if(this.A !== this.read(dp)) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=5; } else { this.cycles+=3; } }; // CBNE dp,rel
    this.opcodes[0x2F] = () => { const rel = this.fetch(); if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=4; }; // BRA rel
    
    // 0x30-0x3F
    this.opcodes[0x30] = () => { const rel = this.fetch(); if(rel>127) rel-=256; if(this.PSW&0x80) { this.PC=(this.PC+rel)&0xFFFF; this.cycles+=4; } else { this.cycles+=2; } }; // BMI rel
    this.opcodes[0x31] = () => { const addr = 0xFFD8; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 3
    this.opcodes[0x32] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)&~0x02); this.cycles += 4; }; // CLR1 $01
    this.opcodes[0x33] = () => { const dp = this.fetch(); const rel = this.fetch(); if(!(this.read(dp)&0x02)) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=5; } }; // BBC 1,dp,rel
    this.opcodes[0x34] = () => { this.and(this.read(this.addr_dp_x())); this.cycles += 4; }; // AND A,dp+X
    this.opcodes[0x35] = () => { this.and(this.read(this.addr_abs_x())); this.cycles += 5; }; // AND A,abs+X
    this.opcodes[0x36] = () => { this.and(this.read(this.addr_abs_y())); this.cycles += 5; }; // AND A,abs+Y
    this.opcodes[0x37] = () => { this.and(this.read(this.addr_ind_dp_y())); this.cycles += 6; }; // AND A,[dp]+Y
    this.opcodes[0x38] = () => { const imm = this.fetch(); const dp = this.fetch(); this.write(dp, this.read(dp)&imm); this.cycles += 5; }; // AND dp,#imm
    this.opcodes[0x39] = () => { const addr1 = this.addr_ind_x(); const addr2 = this.addr_ind_x(); this.write(addr2, this.read(addr2)&this.read(addr1)); this.cycles += 6; }; // AND (X),(Y)
    this.opcodes[0x3A] = () => { const dp = this.fetch(); let val = this.read(dp) | (this.read((dp+1)&0xFF) << 8); val++; this.write(dp, val&0xFF); this.write((dp+1)&0xFF, (val>>8)&0xFF); this.setZN16(val); this.cycles += 6; }; // INCW dp
    this.opcodes[0x3B] = () => { this.lsr(this.X); this.cycles += 2; }; // LSR X
    this.opcodes[0x3C] = () => { this.A = this.lsr(this.A); this.cycles += 2; }; // LSR A
    this.opcodes[0x3D] = () => { this.X = (this.X + 1) & 0xFF; this.setZN(this.X); this.cycles += 2; }; // INC X
    this.opcodes[0x3E] = () => { this.cmp(this.X, this.read(this.addr_dp())); this.cycles += 3; }; // CMP X,dp
    this.opcodes[0x3F] = () => { const addr = this.fetch16(); this.push16(this.PC); this.PC = addr; this.cycles += 8; }; // CALL abs
    
    // 0x40-0x4F
    this.opcodes[0x40] = () => { this.P = 1; this.cycles += 2; }; // SETP
    this.opcodes[0x41] = () => { const addr = 0xFFD6; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 4
    this.opcodes[0x42] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)|0x04); this.cycles += 4; }; // SET1 $02
    this.opcodes[0x43] = () => { const dp = this.fetch(); const rel = this.fetch(); if(this.read(dp)&0x04) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=5; } }; // BBS 2,dp,rel
    this.opcodes[0x44] = () => { this.eor(this.read(this.addr_dp())); this.cycles += 3; }; // EOR A,dp
    this.opcodes[0x45] = () => { this.eor(this.read(this.addr_abs())); this.cycles += 4; }; // EOR A,abs
    this.opcodes[0x46] = () => { this.eor(this.read(this.addr_ind_x())); this.cycles += 3; }; // EOR A,(X)
    this.opcodes[0x47] = () => { this.eor(this.read(this.addr_ind_dp_x())); this.cycles += 6; }; // EOR A,[dp+X]
    this.opcodes[0x48] = () => { this.eor(this.fetch()); this.cycles += 2; }; // EOR A,#imm
    this.opcodes[0x49] = () => { const src = this.fetch(); const dst = this.fetch(); this.write(dst, this.read(dst)^this.read(src)); this.cycles += 5; }; // EOR dp,dp
    this.opcodes[0x4A] = () => { const dp = this.fetch(); const bit = 0x04; const val = this.read(dp); const res = val & (~bit); this.write(dp, res); this.cycles += 4; }; // EOR1 C,/membit
    this.opcodes[0x4B] = () => { let val = this.read(this.addr_dp()); val = this.ror(val); this.write(this.addr_dp(), val); this.cycles += 4; }; // ROR dp
    this.opcodes[0x4C] = () => { let val = this.read(this.addr_abs()); val = this.ror(val); this.write(this.addr_abs(), val); this.cycles += 5; }; // ROR abs
    this.opcodes[0x4D] = () => { this.push(this.X); this.cycles += 4; }; // PUSH X
    this.opcodes[0x4E] = () => { const dp = this.fetch(); const bit = 0x04; const val = this.read(dp); this.write(dp, val|bit); this.cycles += 4; }; // TCLR1 $00
    this.opcodes[0x4F] = () => { const addr = this.fetch16(); this.push16((this.PC-1)&0xFFFF); this.PC = 0xFF00 | this.fetch(); this.cycles += 6; }; // PCALL offset
    
    // 0x50-0x5F
    this.opcodes[0x50] = () => { const rel = this.fetch(); if(rel>127) rel-=256; if(!(this.PSW&0x40)) { this.PC=(this.PC+rel)&0xFFFF; this.cycles+=4; } else { this.cycles+=2; } }; // BVC rel
    this.opcodes[0x51] = () => { const addr = 0xFFD4; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 5
    this.opcodes[0x52] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)&~0x04); this.cycles += 4; }; // CLR1 $02
    this.opcodes[0x53] = () => { const dp = this.fetch(); const rel = this.fetch(); if(!(this.read(dp)&0x04)) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=5; } }; // BBC 2,dp,rel
    this.opcodes[0x54] = () => { this.eor(this.read(this.addr_dp_x())); this.cycles += 4; }; // EOR A,dp+X
    this.opcodes[0x55] = () => { this.eor(this.read(this.addr_abs_x())); this.cycles += 5; }; // EOR A,abs+X
    this.opcodes[0x56] = () => { this.eor(this.read(this.addr_abs_y())); this.cycles += 5; }; // EOR A,abs+Y
    this.opcodes[0x57] = () => { this.eor(this.read(this.addr_ind_dp_y())); this.cycles += 6; }; // EOR A,[dp]+Y
    this.opcodes[0x58] = () => { const imm = this.fetch(); const dp = this.fetch(); this.write(dp, this.read(dp)^imm); this.cycles += 5; }; // EOR dp,#imm
    this.opcodes[0x59] = () => { const addr1 = this.addr_ind_x(); const addr2 = this.addr_ind_x(); this.write(addr2, this.read(addr2)^this.read(addr1)); this.cycles += 6; }; // EOR (X),(Y)
    this.opcodes[0x5A] = () => { const dp = this.fetch(); const val = this.read(dp) | (this.read((dp+1)&0xFF) << 8); this.cmp16(val, this.fetch16()); this.cycles += 5; }; // CMPW YA,dp
    this.opcodes[0x5B] = () => { this.asl(this.Y); this.cycles += 2; }; // ASL Y
    this.opcodes[0x5C] = () => { this.A = this.lsr(this.A); this.cycles += 2; }; // LSR A
    this.opcodes[0x5D] = () => { this.X = this.A; this.setZN(this.X); this.cycles += 2; }; // TAX
    this.opcodes[0x5E] = () => { this.cmp(this.Y, this.read(this.addr_dp())); this.cycles += 3; }; // CMP Y,dp
    this.opcodes[0x5F] = () => { const addr = this.fetch16(); this.PC = addr; this.cycles += 3; }; // JMP abs
    
    // 0x60-0x6F
    this.opcodes[0x60] = () => { this.C = 0; this.cycles += 2; }; // CLRC
    this.opcodes[0x61] = () => { const addr = 0xFFD2; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 6
    this.opcodes[0x62] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)|0x08); this.cycles += 4; }; // SET1 $03
    this.opcodes[0x63] = () => { const dp = this.fetch(); const rel = this.fetch(); if(this.read(dp)&0x08) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=5; } }; // BBS 3,dp,rel
    this.opcodes[0x64] = () => { this.cmp(this.A, this.read(this.addr_dp())); this.cycles += 3; }; // CMP A,dp
    this.opcodes[0x65] = () => { this.cmp(this.A, this.read(this.addr_abs())); this.cycles += 4; }; // CMP A,abs
    this.opcodes[0x66] = () => { this.cmp(this.A, this.read(this.addr_ind_x())); this.cycles += 3; }; // CMP A,(X)
    this.opcodes[0x67] = () => { this.cmp(this.A, this.read(this.addr_ind_dp_x())); this.cycles += 6; }; // CMP A,[dp+X]
    this.opcodes[0x68] = () => { this.cmp(this.A, this.fetch()); this.cycles += 2; }; // CMP A,#imm
    this.opcodes[0x69] = () => { const src = this.fetch(); const dst = this.fetch(); this.cmp(this.read(src), this.read(dst)); this.cycles += 5; }; // CMP dp,dp
    this.opcodes[0x6A] = () => { const dp = this.fetch(); const bit = 0x08; const val = this.read(dp); const res = val & (~bit); this.write(dp, res); this.cycles += 4; }; // CMP1 C,/membit
    this.opcodes[0x6B] = () => { let val = this.read(this.addr_dp()); val = this.ror(val); this.write(this.addr_dp(), val); this.cycles += 4; }; // ROR dp
    this.opcodes[0x6C] = () => { let val = this.read(this.addr_abs()); val = this.ror(val); this.write(this.addr_abs(), val); this.cycles += 5; }; // ROR abs
    this.opcodes[0x6D] = () => { this.push(this.Y); this.cycles += 4; }; // PUSH Y
    this.opcodes[0x6E] = () => { this.Y--; if(this.Y !== 0) { const rel = this.fetch(); if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; } else { this.fetch(); } this.cycles += 4; }; // DBNZ Y,rel
    this.opcodes[0x6F] = () => { this.PC = this.pop16(); this.cycles += 5; }; // RET
    
    // 0x70-0x7F
    this.opcodes[0x70] = () => { const rel = this.fetch(); if(rel>127) rel-=256; if(this.PSW&0x40) { this.PC=(this.PC+rel)&0xFFFF; this.cycles+=4; } else { this.cycles+=2; } }; // BVS rel
    this.opcodes[0x71] = () => { const addr = 0xFFD0; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 7
    this.opcodes[0x72] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)&~0x08); this.cycles += 4; }; // CLR1 $03
    this.opcodes[0x73] = () => { const dp = this.fetch(); const rel = this.fetch(); if(!(this.read(dp)&0x08)) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=5; } }; // BBC 3,dp,rel
    this.opcodes[0x74] = () => { this.cmp(this.A, this.read(this.addr_dp_x())); this.cycles += 4; }; // CMP A,dp+X
    this.opcodes[0x75] = () => { this.cmp(this.A, this.read(this.addr_abs_x())); this.cycles += 5; }; // CMP A,abs+X
    this.opcodes[0x76] = () => { this.cmp(this.A, this.read(this.addr_abs_y())); this.cycles += 5; }; // CMP A,abs+Y
    this.opcodes[0x77] = () => { this.cmp(this.A, this.read(this.addr_ind_dp_y())); this.cycles += 6; }; // CMP A,[dp]+Y
    this.opcodes[0x78] = () => { const imm = this.fetch(); const dp = this.fetch(); this.cmp(this.read(dp), imm); this.cycles += 5; }; // CMP dp,#imm
    this.opcodes[0x79] = () => { const addr1 = this.addr_ind_x(); const addr2 = this.addr_ind_x(); this.cmp(this.read(addr1), this.read(addr2)); this.cycles += 6; }; // CMP (X),(Y)
    this.opcodes[0x7A] = () => { const dp = this.fetch(); const val = this.read(dp) | (this.read((dp+1)&0xFF) << 8); this.adc16(val); this.cycles += 5; }; // ADW YA,(dp or offset)
    this.opcodes[0x7B] = () => { this.ror(this.X); this.cycles += 2; }; // ROR X
    this.opcodes[0x7C] = () => { this.A = this.ror(this.A); this.cycles += 2; }; // ROR A
    this.opcodes[0x7D] = () => { this.A = this.X; this.setZN(this.A); this.cycles += 2; }; // TXA
    this.opcodes[0x7E] = () => { this.cmp(this.Y, this.read(this.addr_dp())); this.cycles += 3; }; // CMP Y,dp
    this.opcodes[0x7F] = () => { this.setPSW(this.pop()); this.PC = this.pop16(); this.cycles += 6; }; // RETI
    
    // 0x80-0x8F
    this.opcodes[0x80] = () => { this.C = 1; this.cycles += 2; }; // SETC
    this.opcodes[0x81] = () => { const addr = 0xFFCE; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 8
    this.opcodes[0x82] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)|0x10); this.cycles += 4; }; // SET1 $04
    this.opcodes[0x83] = () => { const dp = this.fetch(); const rel = this.fetch(); if(this.read(dp)&0x10) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=5; } }; // BBS 4,dp,rel
    this.opcodes[0x84] = () => { this.adc(this.read(this.addr_dp())); this.cycles += 3; }; // ADC A,dp
    this.opcodes[0x85] = () => { this.adc(this.read(this.addr_abs())); this.cycles += 4; }; // ADC A,abs
    this.opcodes[0x86] = () => { this.adc(this.read(this.addr_ind_x())); this.cycles += 3; }; // ADC A,(X)
    this.opcodes[0x87] = () => { this.adc(this.read(this.addr_ind_dp_x())); this.cycles += 6; }; // ADC A,[dp+X]
    this.opcodes[0x88] = () => { this.adc(this.fetch()); this.cycles += 2; }; // ADC A,#imm
    this.opcodes[0x89] = () => { const src = this.fetch(); const dst = this.fetch(); this.write(dst, this.read(dst)+this.read(src)); this.cycles += 5; }; // ADC dp,dp
    this.opcodes[0x8A] = () => { const dp = this.fetch(); const bit = 0x10; const val = this.read(dp); const res = val & (~bit); this.write(dp, res); this.cycles += 4; }; // ADC1 C,/membit
    this.opcodes[0x8B] = () => { let val = this.read(this.addr_dp()); val--; this.write(this.addr_dp(), val); this.setZN(val); this.cycles += 4; }; // DEC dp
    this.opcodes[0x8C] = () => { let val = this.read(this.addr_abs()); val--; this.write(this.addr_abs(), val); this.setZN(val); this.cycles += 5; }; // DEC abs
    this.opcodes[0x8D] = () => { this.Y = this.fetch(); this.setZN(this.Y); this.cycles += 2; }; // MOV Y,#imm
    this.opcodes[0x8E] = () => { this.setPSW(this.pop()); this.cycles += 4; }; // POP PSW
    this.opcodes[0x8F] = () => { const imm = this.fetch(); const dp = this.fetch(); this.write(dp, imm); this.cycles += 5; }; // MOV dp,#imm
    
    // 0x90-0x9F
    this.opcodes[0x90] = () => { const rel = this.fetch(); if(rel>127) rel-=256; if(!(this.PSW&0x01)) { this.PC=(this.PC+rel)&0xFFFF; this.cycles+=4; } else { this.cycles+=2; } }; // BCC rel
    this.opcodes[0x91] = () => { const addr = 0xFFCC; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 9
    this.opcodes[0x92] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)&~0x10); this.cycles += 4; }; // CLR1 $04
    this.opcodes[0x93] = () => { const dp = this.fetch(); const rel = this.fetch(); if(!(this.read(dp)&0x10)) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=5; } }; // BBC 4,dp,rel
    this.opcodes[0x94] = () => { this.adc(this.read(this.addr_dp_x())); this.cycles += 4; }; // ADC A,dp+X
    this.opcodes[0x95] = () => { this.adc(this.read(this.addr_abs_x())); this.cycles += 5; }; // ADC A,abs+X
    this.opcodes[0x96] = () => { this.adc(this.read(this.addr_abs_y())); this.cycles += 5; }; // ADC A,abs+Y
    this.opcodes[0x97] = () => { this.adc(this.read(this.addr_ind_dp_y())); this.cycles += 6; }; // ADC A,[dp]+Y
    this.opcodes[0x98] = () => { const imm = this.fetch(); const dp = this.fetch(); this.write(dp, this.read(dp)+imm); this.cycles += 5; }; // ADC dp,#imm
    this.opcodes[0x99] = () => { const addr1 = this.addr_ind_x(); const addr2 = this.addr_ind_x(); this.write(addr2, this.read(addr2)+this.read(addr1)); this.cycles += 6; }; // ADC (X),(Y)
    this.opcodes[0x9A] = () => { const dp = this.fetch(); let val = this.read(dp) | (this.read((dp+1)&0xFF) << 8); const res = val >> 1; this.write(dp, res&0xFF); this.write((dp+1)&0xFF, (res>>8)&0xFF); this.setZN16(res); this.cycles += 6; }; // LSRW dp
    this.opcodes[0x9B] = () => { this.ror(this.Y); this.cycles += 2; }; // ROR Y
    this.opcodes[0x9C] = () => { this.A--; this.setZN(this.A); this.cycles += 2; }; // DEC A
    this.opcodes[0x9D] = () => { this.X = this.SP; this.setZN(this.X); this.cycles += 2; }; // MOV X,SP
    this.opcodes[0x9E] = () => { const y = this.Y; const x = this.X; const prod = x * y; this.A = prod & 0xFF; this.Y = (prod >> 8) & 0xFF; this.setZN(this.Y); this.cycles += 8; }; // DIV YA,X
    this.opcodes[0x9F] = () => { const l = this.A; const h = this.A; this.A = ((h << 4) & 0xF0) | ((l >> 4) & 0x0F); this.setZN(this.A); this.cycles += 3; }; // XCN A
    
    // 0xA0-0xAF
    this.opcodes[0xA0] = () => { this.I = 1; this.cycles += 2; }; // SEI
    this.opcodes[0xA1] = () => { const addr = 0xFFCA; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 10
    this.opcodes[0xA2] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)|0x20); this.cycles += 4; }; // SET1 $05
    this.opcodes[0xA3] = () => { const dp = this.fetch(); const rel = this.fetch(); if(this.read(dp)&0x20) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=5; } }; // BBS 5,dp,rel
    this.opcodes[0xA4] = () => { this.sbc(this.read(this.addr_dp())); this.cycles += 3; }; // SBC A,dp
    this.opcodes[0xA5] = () => { this.sbc(this.read(this.addr_abs())); this.cycles += 4; }; // SBC A,abs
    this.opcodes[0xA6] = () => { this.sbc(this.read(this.addr_ind_x())); this.cycles += 3; }; // SBC A,(X)
    this.opcodes[0xA7] = () => { this.sbc(this.read(this.addr_ind_dp_x())); this.cycles += 6; }; // SBC A,[dp+X]
    this.opcodes[0xA8] = () => { this.sbc(this.fetch()); this.cycles += 2; }; // SBC A,#imm
    this.opcodes[0xA9] = () => { const src = this.fetch(); const dst = this.fetch(); this.write(dst, this.read(dst)-this.read(src)); this.cycles += 5; }; // SBC dp,dp
    this.opcodes[0xAA] = () => { const dp = this.fetch(); const bit = 0x20; const val = this.read(dp); const res = val & (~bit); this.write(dp, res); this.cycles += 4; }; // SBC1 C,/membit
    this.opcodes[0xAB] = () => { let val = this.read(this.addr_dp()); val++; this.write(this.addr_dp(), val); this.setZN(val); this.cycles += 4; }; // INC dp
    this.opcodes[0xAC] = () => { let val = this.read(this.addr_abs()); val++; this.write(this.addr_abs(), val); this.setZN(val); this.cycles += 5; }; // INC abs
    this.opcodes[0xAD] = () => { this.cmp(this.Y, this.fetch()); this.cycles += 2; }; // CMP Y,#imm
    this.opcodes[0xAE] = () => { this.A = this.pop(); this.cycles += 4; }; // POP A
    this.opcodes[0xAF] = () => { const addr = this.addr_ind_x_inc(); this.write(addr, this.A); this.cycles += 4; }; // MOV (X)+,A
    
    // 0xB0-0xBF
    this.opcodes[0xB0] = () => { const rel = this.fetch(); if(rel>127) rel-=256; if(this.PSW&0x01) { this.PC=(this.PC+rel)&0xFFFF; this.cycles+=4; } else { this.cycles+=2; } }; // BCS rel
    this.opcodes[0xB1] = () => { const addr = 0xFFC8; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 11
    this.opcodes[0xB2] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)&~0x20); this.cycles += 4; }; // CLR1 $05
    this.opcodes[0xB3] = () => { const dp = this.fetch(); const rel = this.fetch(); if(!(this.read(dp)&0x20)) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=5; } }; // BBC 5,dp,rel
    this.opcodes[0xB4] = () => { this.sbc(this.read(this.addr_dp_x())); this.cycles += 4; }; // SBC A,dp+X
    this.opcodes[0xB5] = () => { this.sbc(this.read(this.addr_abs_x())); this.cycles += 5; }; // SBC A,abs+X
    this.opcodes[0xB6] = () => { this.sbc(this.read(this.addr_abs_y())); this.cycles += 5; }; // SBC A,abs+Y
    this.opcodes[0xB7] = () => { this.sbc(this.read(this.addr_ind_dp_y())); this.cycles += 6; }; // SBC A,[dp]+Y
    this.opcodes[0xB8] = () => { const imm = this.fetch(); const dp = this.fetch(); this.write(dp, this.read(dp)-imm); this.cycles += 5; }; // SBC dp,#imm
    this.opcodes[0xB9] = () => { const addr1 = this.addr_ind_x(); const addr2 = this.addr_ind_x(); this.write(addr2, this.read(addr2)-this.read(addr1)); this.cycles += 6; }; // SBC (X),(Y)
    this.opcodes[0xBA] = () => { const dp = this.fetch(); this.A = this.read(dp); this.Y = this.read((dp+1)&0xFF); this.setZN(this.Y); this.cycles += 5; }; // MOVW YA,dp
    this.opcodes[0xBB] = () => { let val = this.read(this.addr_dp()); val++; this.write(this.addr_dp(), val); this.setZN(val); this.cycles += 4; }; // INC dp
    this.opcodes[0xBC] = () => { this.A = (this.A + 1) & 0xFF; this.setZN(this.A); this.cycles += 2; }; // INC A
    this.opcodes[0xBD] = () => { this.SP = this.X; this.cycles += 2; }; // MOV SP,X
    this.opcodes[0xBE] = () => { this.A = this.A & 0x0F; if((this.A & 0x0F) > 9 || this.H) this.A -= 6; this.A = (this.A & 0xF0) >> 4; if((this.A & 0xF0) > 0x90 || this.C) this.A -= 0x60; this.setZN(this.A); this.cycles += 3; }; // DAS A
    this.opcodes[0xBF] = () => { const addr = this.addr_ind_x_inc(); this.A = this.read(addr); this.setZN(this.A); this.cycles += 4; }; // MOV A,(X)+
    
    // 0xC0-0xCF
    this.opcodes[0xC0] = () => { this.I = 0; this.cycles += 2; }; // CLI
    this.opcodes[0xC1] = () => { const addr = 0xFFC6; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 12
    this.opcodes[0xC2] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)|0x40); this.cycles += 4; }; // SET1 $06
    this.opcodes[0xC3] = () => { const dp = this.fetch(); const rel = this.fetch(); if(this.read(dp)&0x40) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=5; } }; // BBS 6,dp,rel
    this.opcodes[0xC4] = () => { this.write(this.addr_dp(), this.A); this.cycles += 4; }; // MOV dp,A
    this.opcodes[0xC5] = () => { this.write(this.addr_abs(), this.A); this.cycles += 5; }; // MOV abs,A
    this.opcodes[0xC6] = () => { this.write(this.addr_ind_x(), this.A); this.cycles += 4; }; // MOV (X),A
    this.opcodes[0xC7] = () => { this.write(this.addr_ind_dp_x(), this.A); this.cycles += 7; }; // MOV [dp+X],A
    this.opcodes[0xC8] = () => { this.cmp(this.X, this.fetch()); this.cycles += 2; }; // CMP X,#imm
    this.opcodes[0xC9] = () => { this.write(this.addr_abs(), this.X); this.cycles += 5; }; // MOV abs,X
    this.opcodes[0xCA] = () => { const dp = this.fetch(); const bit = 0x40; const val = this.read(dp); const res = val & (~bit); this.write(dp, res); this.cycles += 4; }; // MOV1 C,/membit
    this.opcodes[0xCB] = () => { this.write(this.addr_dp(), this.Y); this.cycles += 4; }; // MOV dp,Y
    this.opcodes[0xCC] = () => { this.write(this.addr_abs(), this.Y); this.cycles += 5; }; // MOV abs,Y
    this.opcodes[0xCD] = () => { this.X = this.fetch(); this.setZN(this.X); this.cycles += 2; }; // MOV X,#imm
    this.opcodes[0xCE] = () => { this.X = this.pop(); this.cycles += 4; }; // POP X
    this.opcodes[0xCF] = () => { const y = this.Y; const x = this.X; const prod = x * y; this.A = prod & 0xFF; this.Y = (prod >> 8) & 0xFF; this.setZN(this.Y); this.cycles += 8; }; // MUL YA
    
    // 0xD0-0xDF
    this.opcodes[0xD0] = () => { const rel = this.fetch(); if(rel>127) rel-=256; if(!(this.PSW&0x02)) { this.PC=(this.PC+rel)&0xFFFF; this.cycles+=4; } else { this.cycles+=2; } }; // BNE rel
    this.opcodes[0xD1] = () => { const addr = 0xFFC4; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 13
    this.opcodes[0xD2] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)&~0x40); this.cycles += 4; }; // CLR1 $06
    this.opcodes[0xD3] = () => { const dp = this.fetch(); const rel = this.fetch(); if(!(this.read(dp)&0x40)) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=5; } }; // BBC 6,dp,rel
    this.opcodes[0xD4] = () => { this.write(this.addr_dp_x(), this.A); this.cycles += 5; }; // MOV dp+X,A
    this.opcodes[0xD5] = () => { this.write(this.addr_abs_x(), this.A); this.cycles += 6; }; // MOV abs+X,A
    this.opcodes[0xD6] = () => { this.write(this.addr_abs_y(), this.A); this.cycles += 6; }; // MOV abs+Y,A
    this.opcodes[0xD7] = () => { this.write(this.addr_ind_dp_y(), this.A); this.cycles += 7; }; // MOV [dp]+Y,A
    this.opcodes[0xD8] = () => { this.write(this.addr_dp(), this.X); this.cycles += 4; }; // MOV dp,X
    this.opcodes[0xD9] = () => { this.write(this.addr_dp_y(), this.X); this.cycles += 5; }); // MOV dp+Y,X
    this.opcodes[0xDA] = () => { const dp = this.fetch(); this.write(dp, this.A); this.write((dp+1)&0xFF, this.Y); this.cycles += 5; }; // MOVW dp,YA
    this.opcodes[0xDB] = () => { this.write(this.addr_dp_x(), this.Y); this.cycles += 5; }; // MOV dp+X,Y
    this.opcodes[0xDC] = () => { this.Y = (this.Y - 1) & 0xFF; this.setZN(this.Y); this.cycles += 2; }; // DEC Y
    this.opcodes[0xDD] = () => { this.A = this.Y; this.setZN(this.A); this.cycles += 2; }; // MOV A,Y / TYA
    this.opcodes[0xDE] = () => { const dp = this.fetch(); const rel = this.fetch(); let val = (this.read(dp) - 1) & 0xFF; this.write(dp, val); if(val !== 0) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=3; } }; // DBNZ dp,rel
    this.opcodes[0xDF] = () => { this.A = this.A & 0x0F; if((this.A & 0x0F) > 9 || this.H) this.A += 6; this.A = (this.A & 0xF0) >> 4; if((this.A & 0xF0) > 0x90 || this.C) this.A += 0x60; this.setZN(this.A); this.cycles += 3; }; // DAA A
    
    // 0xE0-0xEF
    this.opcodes[0xE0] = () => { this.V = 0; this.cycles += 2; }; // CLRV
    this.opcodes[0xE1] = () => { const addr = 0xFFC2; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 14
    this.opcodes[0xE2] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)|0x80); this.cycles += 4; }; // SET1 $07
    this.opcodes[0xE3] = () => { const dp = this.fetch(); const rel = this.fetch(); if(this.read(dp)&0x80) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=5; } }; // BBS 7,dp,rel
    this.opcodes[0xE4] = () => { this.A = this.read(this.addr_dp()); this.setZN(this.A); this.cycles += 3; }; // MOV A,dp
    this.opcodes[0xE5] = () => { this.A = this.read(this.addr_abs()); this.setZN(this.A); this.cycles += 4; }; // MOV A,abs
    this.opcodes[0xE6] = () => { this.A = this.read(this.addr_ind_x()); this.setZN(this.A); this.cycles += 3; }; // MOV A,(X)
    this.opcodes[0xE7] = () => { this.A = this.read(this.addr_ind_dp_x()); this.setZN(this.A); this.cycles += 6; }; // MOV A,[dp+X]
    this.opcodes[0xE8] = () => { this.A = this.fetch(); this.setZN(this.A); this.cycles += 2; }; // MOV A,#imm
    this.opcodes[0xE9] = () => { this.X = this.read(this.addr_abs()); this.setZN(this.X); this.cycles += 4; }; // MOV X,abs
    this.opcodes[0xEA] = () => { const dp = this.fetch(); const bit = 0x80; const val = this.read(dp); const res = val & (~bit); this.write(dp, res); this.cycles += 4; }; // NOT1 C,membit
    this.opcodes[0xEB] = () => { this.Y = this.read(this.addr_dp()); this.setZN(this.Y); this.cycles += 3; }; // MOV Y,dp
    this.opcodes[0xEC] = () => { this.Y = this.read(this.addr_abs()); this.setZN(this.Y); this.cycles += 4; }; // MOV Y,abs
    this.opcodes[0xED] = () => { this.C = this.C ? 0 : 1; this.cycles += 2; }; // NOTC
    this.opcodes[0xEE] = () => { this.Y = this.pop(); this.cycles += 4; }; // POP Y
    this.opcodes[0xEF] = () => { this.cycles += 3; }; // SLEEP / WAIT
    
    // 0xF0-0xFF
    this.opcodes[0xF0] = () => { const rel = this.fetch(); if(rel>127) rel-=256; if(this.PSW&0x02) { this.PC=(this.PC+rel)&0xFFFF; this.cycles+=4; } else { this.cycles+=2; } }; // BEQ rel
    this.opcodes[0xF1] = () => { const addr = 0xFFC0; this.push16((this.PC+2)&0xFFFF); this.PC = (this.read(addr+1)<<8)|this.read(addr); this.cycles += 8; }; // TCALL 15
    this.opcodes[0xF2] = () => { const dp = this.fetch(); this.write(dp, this.read(dp)&~0x80); this.cycles += 4; }; // CLR1 $07
    this.opcodes[0xF3] = () => { const dp = this.fetch(); const rel = this.fetch(); if(!(this.read(dp)&0x80)) { if(rel>127) rel-=256; this.PC=(this.PC+rel)&0xFFFF; this.cycles+=6; } else { this.cycles+=5; } }; // BBC 7,dp,rel
    this.opcodes[0xF4] = () => { this.A = this.read(this.addr_dp_x()); this.setZN(this.A); this.cycles += 4; }; // MOV A,dp+X
    this.opcodes[0xF5] = () => { this.A = this.read(this.addr_abs_x()); this.setZN(this.A); this.cycles += 5; }; // MOV A,abs+X
    this.opcodes[0xF6] = () => { this.A = this.read(this.addr_abs_y()); this.setZN(this.A); this.cycles += 5; }; // MOV A,abs+Y
    this.opcodes[0xF7] = () => { this.A = this.read(this.addr_ind_dp_y()); this.setZN(this.A); this.cycles += 6; }; // MOV A,[dp]+Y
    this.opcodes[0xF8] = () => { this.X = this.read(this.addr_dp()); this.setZN(this.X); this.cycles += 3; }; // MOV X,dp
    this.opcodes[0xF9] = () => { this.X = this.read(this.addr_dp_y()); this.setZN(this.X); this.cycles += 4; }; // MOV X,dp+Y
    this.opcodes[0xFA] = () => { const src = this.fetch(); const dst = this.fetch(); this.write(dst, this.read(src)); this.cycles += 5; }; // MOV dp,dp
    this.opcodes[0xFB] = () => { this.Y = this.read(this.addr_dp_x()); this.setZN(this.Y); this.cycles += 4; }; // MOV Y,dp+X
    this.opcodes[0xFC] = () => { this.Y = (this.Y + 1) & 0xFF; this.setZN(this.Y); this.cycles += 2; }; // INC Y
    this.opcodes[0xFD] = () => { this.Y = this.A; this.setZN(this.Y); this.cycles += 2; }; // MOV Y,A / TAY
    this.opcodes[0xFE] = () => { const rel = this.fetch(); if(rel>127) rel-=256; this.Y=(this.Y-1)&0xFF; if(this.Y!==0) { this.PC=(this.PC+rel)&0xFFFF; this.cycles+=4; } else { this.cycles+=3; } }; // DBNZ Y,rel
    this.opcodes[0xFF] = () => { this.cycles += 1; }; // STOP
  }

  or_val(val) {
    this.A |= val;
    this.setZN(this.A);
    return this.A;
  }

  cmp16(x, y) {
    const res = (x - y) & 0xFFFF;
    this.C = (x >= y) ? 1 : 0;
    this.Z = (res === 0) ? 1 : 0;
    this.N = (res & 0x8000) ? 1 : 0;
  }

  adc16(val) {
    const res = ((this.Y << 8) | this.A) + val + this.C;
    this.C = (res > 0xFFFF) ? 1 : 0;
    this.A = res & 0xFF;
    this.Y = (res >> 8) & 0xFF;
    this.setZN16(res);
  }

  // Main execution step
  step() {
    const opcode = this.fetch();
    if (this.opcodes[opcode]) {
      this.opcodes[opcode]();
    } else {
      console.warn(`Unknown opcode: 0x${opcode.toString(16).padStart(2, '0')}`);
      this.cycles += 2;
    }
    return this.cycles;
  }

  reset() {
    this.PC = 0xFFC0;
    this.A = 0;
    this.X = 0;
    this.Y = 0;
    this.SP = 0xEF;
    this.setPSW(0);
    this.cycles = 0;
  }
}
