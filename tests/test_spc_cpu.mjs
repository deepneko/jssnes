// test_spc_cpu.mjs — SPC700 (APU) CPU instruction unit tests
// Covers: MOV/load, ADC/SBC/CMP flags, branches, PUSH/POP/CALL/RET,
//         flag ops, INC/DEC, ASL/LSR, word ops, timers, CPU↔APU ports,
//         direct page, MOVW, XCN, MUL.
import { APU } from '../src/APU.js';

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

// PSW flag masks
const F_N = 0x80; const F_V = 0x40; const F_P = 0x20; const F_B = 0x10;
const F_H = 0x08; const F_I = 0x04; const F_Z = 0x02; const F_C = 0x01;

function makeAPU() {
  const apu = new APU();
  // Leave control=0x80 (boot ROM visible); we work at 0x0200 which is normal RAM.
  apu.PC = 0x0200; apu.A = 0; apu.X = 0; apu.Y = 0;
  apu.SP = 0xFF; apu.PSW = 0x00; // all flags clear
  return apu;
}

// Write bytes at addr and set PC to addr
function prog(apu, ...bytes) {
  const addr = 0x0200;
  for (let i = 0; i < bytes.length; i++) apu.ram[addr + i] = bytes[i];
  apu.PC = addr;
}

// ─── 1. MOV A,#imm — load immediate, N/Z flags ───────────────────────────────
function testMovImmFlags() {
  const apu = makeAPU();

  // MOV A,#42 → A=42, Z=0, N=0
  prog(apu, 0xE8, 42);
  apu.step();
  assert(apu.A === 42, 'MOV A,#42 → A=42');
  assert((apu.PSW & F_Z) === 0, 'MOV A,#42 → Z=0');
  assert((apu.PSW & F_N) === 0, 'MOV A,#42 → N=0');

  // MOV A,#0 → A=0, Z=1, N=0
  prog(apu, 0xE8, 0);
  apu.step();
  assert(apu.A === 0, 'MOV A,#0 → A=0');
  assert((apu.PSW & F_Z) !== 0, 'MOV A,#0 → Z=1');

  // MOV A,#0x80 → A=128, N=1
  prog(apu, 0xE8, 0x80);
  apu.step();
  assert(apu.A === 0x80, 'MOV A,#0x80 → A=0x80');
  assert((apu.PSW & F_N) !== 0, 'MOV A,#0x80 → N=1');
  assert((apu.PSW & F_Z) === 0, 'MOV A,#0x80 → Z=0');
}

// ─── 2. ADC — add with carry, all flags ──────────────────────────────────────
function testAdc() {
  const apu = makeAPU();

  // Basic add: 5 + 3, no carry-in → A=8, C=0, Z=0, N=0, V=0, H=0
  prog(apu, 0xE8, 5);   // MOV A,#5
  apu.step();
  apu.PSW &= ~F_C;       // ensure C=0
  prog(apu, 0x88, 3);   // ADC A,#3
  apu.step();
  assert(apu.A === 8, 'ADC 5+3=8');
  assert((apu.PSW & F_C) === 0, 'ADC 5+3: C=0');
  assert((apu.PSW & F_V) === 0, 'ADC 5+3: V=0');
  assert((apu.PSW & F_Z) === 0, 'ADC 5+3: Z=0');

  // Carry out: 0xFF + 1 → A=0, C=1, Z=1
  apu.A = 0xFF; apu.PSW &= ~F_C;
  prog(apu, 0x88, 1);   // ADC A,#1
  apu.step();
  assert(apu.A === 0, 'ADC 0xFF+1=0');
  assert((apu.PSW & F_C) !== 0, 'ADC 0xFF+1: C=1');
  assert((apu.PSW & F_Z) !== 0, 'ADC 0xFF+1: Z=1');

  // Overflow: 0x7F + 1 → A=0x80, V=1, N=1, H=1
  apu.A = 0x7F; apu.PSW &= ~F_C;
  prog(apu, 0x88, 1);   // ADC A,#1
  apu.step();
  assert(apu.A === 0x80, 'ADC 0x7F+1=0x80');
  assert((apu.PSW & F_V) !== 0, 'ADC 0x7F+1: V=1 (overflow)');
  assert((apu.PSW & F_N) !== 0, 'ADC 0x7F+1: N=1');
  assert((apu.PSW & F_H) !== 0, 'ADC 0x7F+1: H=1 (nibble carry)');

  // Carry-in: A=1 + 1, C=1 → A=3
  apu.A = 1; apu.PSW |= F_C;
  prog(apu, 0x88, 1);   // ADC A,#1 with C=1
  apu.step();
  assert(apu.A === 3, 'ADC 1+1+Cin=3');
}

// ─── 3. SBC — subtract with borrow ───────────────────────────────────────────
function testSbc() {
  // SPC700 SBC: C=1 = no borrow (like 65xx SEC then SBC)
  const apu = makeAPU();

  // 10 - 3, C=1 (no borrow) → 7
  apu.A = 10; apu.PSW |= F_C;
  prog(apu, 0xA8, 3);   // SBC A,#3
  apu.step();
  assert(apu.A === 7, 'SBC 10-3=7');
  assert((apu.PSW & F_C) !== 0, 'SBC 10-3: C=1 (no borrow)');

  // 3 - 10, C=1 → underflow
  apu.A = 3; apu.PSW |= F_C;
  prog(apu, 0xA8, 10);  // SBC A,#10
  apu.step();
  assert(apu.A === 0xF9, 'SBC 3-10 wraps');
  assert((apu.PSW & F_C) === 0, 'SBC 3-10: C=0 (borrow)');
  assert((apu.PSW & F_N) !== 0, 'SBC 3-10: N=1');

  // 5 - 5, C=1 → 0, Z=1
  apu.A = 5; apu.PSW |= F_C;
  prog(apu, 0xA8, 5);   // SBC A,#5
  apu.step();
  assert(apu.A === 0, 'SBC 5-5=0');
  assert((apu.PSW & F_Z) !== 0, 'SBC 5-5: Z=1');
}

// ─── 4. CMP — compare without write ─────────────────────────────────────────
function testCmp() {
  const apu = makeAPU();
  apu.A = 10;

  // CMP A,#10 → equal → Z=1, C=1, N=0
  prog(apu, 0x68, 10);  // CMP A,#10
  apu.step();
  assert((apu.PSW & F_Z) !== 0, 'CMP equal: Z=1');
  assert((apu.PSW & F_C) !== 0, 'CMP equal: C=1');
  assert((apu.PSW & F_N) === 0, 'CMP equal: N=0');
  assert(apu.A === 10, 'CMP does not modify A');

  // CMP A,#20 → A<B → C=0, N=1
  apu.A = 10;
  prog(apu, 0x68, 20);  // CMP A,#20
  apu.step();
  assert((apu.PSW & F_C) === 0, 'CMP A<B: C=0');
  assert((apu.PSW & F_N) !== 0, 'CMP A<B: N=1');

  // CMP A,#5 → A>B → C=1, N=0, Z=0
  apu.A = 10;
  prog(apu, 0x68, 5);   // CMP A,#5
  apu.step();
  assert((apu.PSW & F_C) !== 0, 'CMP A>B: C=1');
  assert((apu.PSW & F_Z) === 0, 'CMP A>B: Z=0');
}

// ─── 5. Branch instructions ──────────────────────────────────────────────────
function testBranches() {
  const apu = makeAPU();

  // BEQ taken: Z=1, +2 offset → lands at addr+4
  // Layout: 0x0200: F0 02 (BEQ +2); 0x0202: 00 (NOP = fallthrough); 0x0204: target
  apu.ram[0x0200] = 0xF0; apu.ram[0x0201] = 0x02; // BEQ +2
  apu.ram[0x0202] = 0xE8; apu.ram[0x0203] = 0x99;  // MOV A,#99 (should be skipped)
  apu.PSW |= F_Z;   // Z=1
  apu.PC = 0x0200;
  apu.step(); // BEQ taken
  assert(apu.PC === 0x0204, `BEQ taken: PC=0x${apu.PC.toString(16)}, expected 0x0204`);
  assert(apu.A !== 0x99, 'BEQ skips MOV');

  // BNE not-taken: Z=1 → falls through
  apu.ram[0x0210] = 0xD0; apu.ram[0x0211] = 0x10; // BNE +16
  apu.PSW |= F_Z; // Z=1
  apu.PC = 0x0210;
  apu.step(); // BNE not taken
  assert(apu.PC === 0x0212, 'BNE not-taken: PC advances past opcode');

  // BNE taken: Z=0
  apu.PSW &= ~F_Z;
  apu.PC = 0x0210;
  apu.step();
  assert(apu.PC === 0x0222, `BNE taken: PC=0x${apu.PC.toString(16)}, expected 0x0222`);

  // BCC taken: C=0 → branch
  apu.ram[0x0220] = 0x90; apu.ram[0x0221] = 0x04; // BCC +4
  apu.PSW &= ~F_C;
  apu.PC = 0x0220;
  apu.step();
  assert(apu.PC === 0x0226, 'BCC taken');

  // BCS not-taken: C=0
  apu.ram[0x0230] = 0xB0; apu.ram[0x0231] = 0x04; // BCS +4
  apu.PSW &= ~F_C;
  apu.PC = 0x0230;
  apu.step();
  assert(apu.PC === 0x0232, 'BCS not-taken');
}

// ─── 6. PUSH / POP roundtrip ─────────────────────────────────────────────────
function testPushPop() {
  const apu = makeAPU();

  apu.A = 0xAB; apu.PSW = 0x55;

  // PUSH A, PUSH PSW
  prog(apu, 0x2D, 0x0D); // PUSH A, PUSH PSW
  apu.step(); // PUSH A
  apu.step(); // PUSH PSW

  const savedSP = apu.SP;

  // Trash registers, then POP
  apu.A = 0; apu.PSW = 0;

  prog(apu, 0x8E, 0xAE); // POP PSW, POP A
  apu.step(); // POP PSW
  apu.step(); // POP A

  assert(apu.PSW === 0x55, `POP PSW: got 0x${apu.PSW.toString(16)}, expected 0x55`);
  assert(apu.A === 0xAB, `POP A: got 0x${apu.A.toString(16)}, expected 0xAB`);
  assert(apu.SP === 0xFF, 'SP restored after PUSH/POP');
}

// ─── 7. CALL / RET ───────────────────────────────────────────────────────────
function testCallRet() {
  const apu = makeAPU();

  // CALL 0x0300; at 0x0300: MOV A,#0x7E; RET
  // Instruction at 0x0200: 3F 00 03 (CALL abs)
  apu.ram[0x0200] = 0x3F; apu.ram[0x0201] = 0x00; apu.ram[0x0202] = 0x03;
  apu.ram[0x0300] = 0xE8; apu.ram[0x0301] = 0x7E; // MOV A,#0x7E
  apu.ram[0x0302] = 0x6F;                           // RET
  apu.PC = 0x0200; apu.SP = 0xFF;

  apu.step(); // CALL 0x0300
  assert(apu.PC === 0x0300, 'CALL: PC=0x0300');
  assert(apu.SP === 0xFD, 'CALL: SP decremented by 2');

  apu.step(); // MOV A,#0x7E
  assert(apu.A === 0x7E, 'Subroutine MOV A,#0x7E');

  apu.step(); // RET
  assert(apu.PC === 0x0203, `RET: PC=0x${apu.PC.toString(16)}, expected 0x0203`);
  assert(apu.SP === 0xFF, 'RET: SP restored');
}

// ─── 8. Flag operations: CLRC/SETC/NOTC, CLRP/SETP ─────────────────────────
function testFlagOps() {
  const apu = makeAPU();

  apu.PSW = 0x00;
  prog(apu, 0x80);  // SETC
  apu.step();
  assert((apu.PSW & F_C) !== 0, 'SETC: C=1');

  prog(apu, 0x60);  // CLRC
  apu.step();
  assert((apu.PSW & F_C) === 0, 'CLRC: C=0');

  prog(apu, 0xED);  // NOTC (toggle C)
  apu.step();
  assert((apu.PSW & F_C) !== 0, 'NOTC: C flipped to 1');

  prog(apu, 0xED);  // NOTC again
  apu.step();
  assert((apu.PSW & F_C) === 0, 'NOTC: C flipped to 0');

  prog(apu, 0x40);  // SETP
  apu.step();
  assert((apu.PSW & F_P) !== 0, 'SETP: P=1 → DP=0x0100');

  prog(apu, 0x20);  // CLRP
  apu.step();
  assert((apu.PSW & F_P) === 0, 'CLRP: P=0 → DP=0x0000');
}

// ─── 9. INC / DEC with wrap and zero flag ───────────────────────────────────
function testIncDec() {
  const apu = makeAPU();

  apu.A = 0xFE;
  prog(apu, 0xBC);  // INC A → 0xFF, N=1, Z=0
  apu.step();
  assert(apu.A === 0xFF, 'INC A: 0xFE→0xFF');
  assert((apu.PSW & F_N) !== 0, 'INC A: N=1');
  assert((apu.PSW & F_Z) === 0, 'INC A: Z=0');

  prog(apu, 0xBC);  // INC A → 0, Z=1, N=0 (wrap)
  apu.step();
  assert(apu.A === 0, 'INC A: 0xFF→0 (wrap)');
  assert((apu.PSW & F_Z) !== 0, 'INC A wrap: Z=1');
  assert((apu.PSW & F_N) === 0, 'INC A wrap: N=0');

  apu.A = 1;
  prog(apu, 0x9C);  // DEC A → 0, Z=1
  apu.step();
  assert(apu.A === 0, 'DEC A: 1→0');
  assert((apu.PSW & F_Z) !== 0, 'DEC A: Z=1');

  apu.A = 0;
  prog(apu, 0x9C);  // DEC A → 0xFF, N=1
  apu.step();
  assert(apu.A === 0xFF, 'DEC A: 0→0xFF wrap');
  assert((apu.PSW & F_N) !== 0, 'DEC A: N=1');
}

// ─── 10. ASL / LSR with carry ────────────────────────────────────────────────
function testShifts() {
  const apu = makeAPU();

  // ASL A: 0x81 → 0x02, C=1 (high bit shifted out), N=0, Z=0
  apu.A = 0x81;
  prog(apu, 0x1C);  // ASL A
  apu.step();
  assert(apu.A === 0x02, 'ASL 0x81 → 0x02');
  assert((apu.PSW & F_C) !== 0, 'ASL 0x81: C=1');
  assert((apu.PSW & F_N) === 0, 'ASL 0x81: N=0');

  // LSR A: 0x03 → 0x01, C=1 (low bit shifted out), N=0
  apu.A = 0x03;
  prog(apu, 0x5C);  // LSR A
  apu.step();
  assert(apu.A === 0x01, 'LSR 0x03 → 0x01');
  assert((apu.PSW & F_C) !== 0, 'LSR 0x03: C=1');

  // LSR A: 0x02 → 0x01, C=0
  apu.A = 0x02;
  prog(apu, 0x5C);  // LSR A
  apu.step();
  assert(apu.A === 0x01, 'LSR 0x02 → 0x01');
  assert((apu.PSW & F_C) === 0, 'LSR 0x02: C=0');
}

// ─── 11. XCN (exchange nibbles) ──────────────────────────────────────────────
function testXcn() {
  const apu = makeAPU();
  apu.A = 0xAB;
  prog(apu, 0x9F);  // XCN
  apu.step();
  assert(apu.A === 0xBA, `XCN 0xAB → 0xBA, got 0x${apu.A.toString(16)}`);
  assert((apu.PSW & F_N) !== 0, 'XCN 0xAB: N=1 (bit 7 set)');
  assert((apu.PSW & F_Z) === 0, 'XCN 0xAB: Z=0');
}

// ─── 12. MUL YA ──────────────────────────────────────────────────────────────
function testMul() {
  const apu = makeAPU();
  apu.A = 0x12; apu.Y = 0x34;
  prog(apu, 0xCF);  // MUL YA
  apu.step();
  const product = 0x12 * 0x34; // 0x3A8
  assert(apu.A === (product & 0xFF), `MUL: A=0x${apu.A.toString(16)}`);
  assert(apu.Y === (product >> 8) & 0xFF, `MUL: Y=0x${apu.Y.toString(16)}`);

  // MUL 0 → Y=A=0, Z=1
  apu.A = 0; apu.Y = 0xFF;
  prog(apu, 0xCF);
  apu.step();
  assert(apu.A === 0 && apu.Y === 0, 'MUL 0: Y=A=0');
  assert((apu.PSW & F_Z) !== 0, 'MUL 0: Z=1 (from Y)');
}

// ─── 13. MOVW YA,dp — 16-bit load ────────────────────────────────────────────
function testMovwYa() {
  const apu = makeAPU();
  // Write 0x0034 at dp=0x10 (DP page 0)
  apu.ram[0x10] = 0x34; apu.ram[0x11] = 0x56; // lo=0x34, hi=0x56
  prog(apu, 0xBA, 0x10); // MOVW YA,dp=0x10
  apu.step();
  assert(apu.A === 0x34, `MOVW: A=0x${apu.A.toString(16)}`);
  assert(apu.Y === 0x56, `MOVW: Y=0x${apu.Y.toString(16)}`);
  assert((apu.PSW & F_Z) === 0, 'MOVW non-zero: Z=0');
  assert((apu.PSW & F_N) === 0, 'MOVW 0x5634: N from Y.bit7=0');

  // MOVW 0: Z=1
  apu.ram[0x20] = 0; apu.ram[0x21] = 0;
  prog(apu, 0xBA, 0x20);
  apu.step();
  assert((apu.PSW & F_Z) !== 0, 'MOVW 0: Z=1');
}

// ─── 14. Direct page addressing (SETP/CLRP) ──────────────────────────────────
function testDirectPage() {
  const apu = makeAPU();

  // P=0: dp=0x50 is at address 0x0050
  apu.PSW &= ~F_P;
  apu.ram[0x0050] = 0xCC;
  prog(apu, 0xE4, 0x50);  // MOV A,dp=0x50
  apu.step();
  assert(apu.A === 0xCC, 'DP P=0: reads from 0x0050');

  // P=1: dp=0x50 is at address 0x0150
  apu.PSW |= F_P;
  apu.ram[0x0150] = 0xDD;
  prog(apu, 0xE4, 0x50);  // MOV A,dp=0x50 (DP offset)
  apu.step();
  assert(apu.A === 0xDD, 'DP P=1: reads from 0x0150');
}

// ─── 15. Timer 2 fires after enough cycles ───────────────────────────────────
function testTimer2() {
  const apu = makeAPU();

  // Enable timer 2, target=2 (fires every 2×16=32 APU cycles)
  apu.timerTargets[2] = 2;
  apu.write(0xF1, 0x04); // enable timer 2

  // Run 16 NOPs (each 2 cycles = 32 cycles total)
  // Timer 2 limit=16: after 16 cycles → first tick; after 32 cycles → second tick
  // Two ticks with target=2: counter2 increments once (resets when counter>=2)
  const NOP = 0x00;
  for (let i = 0; i < 16; i++) apu.ram[0x0200 + i] = NOP;
  apu.PC = 0x0200;
  for (let i = 0; i < 16; i++) apu.step();

  assert(apu.counter2 === 1, `Timer2 fired once: counter2=${apu.counter2}`);

  // Read clears counter
  const r = apu.read(0xFF); // read timer 2 output
  assert(r === 1, `Read timer2: got ${r}`);
  assert(apu.counter2 === 0, 'counter2 cleared after read');
}

// ─── 16. CPU ↔ APU port communication ────────────────────────────────────────
function testCpuApuPorts() {
  const apu = makeAPU();

  // CPU writes to port 0; SPC reads it via $F4
  apu.writeCPU(0, 0x42);
  assert(apu.read(0xF4) === 0x42, 'CPU→APU port 0: SPC reads $42');

  // SPC writes to port 0; CPU reads it
  apu.write(0xF4, 0x37); // apuPorts[0] = 0x37
  assert(apu.readCPU(0) === 0x37, 'APU→CPU port 0: CPU reads $37');

  // Port 3
  apu.writeCPU(3, 0xFF);
  assert(apu.read(0xF7) === 0xFF, 'CPU→APU port 3');
  apu.write(0xF7, 0xAB);
  assert(apu.readCPU(3) === 0xAB, 'APU→CPU port 3');
}

// ─── 17. MOV dp,#imm ────────────────────────────────────────────────────────
function testMovDpImm() {
  const apu = makeAPU();

  // MOV dp,#imm: writes imm to DP address without touching flags
  apu.PSW = 0x55; // keep flags
  prog(apu, 0x8F, 0xBE, 0x30); // MOV dp=$30, #0xBE
  apu.step();
  assert(apu.ram[0x30] === 0xBE, 'MOV dp,#imm: ram[0x30]=0xBE');
  assert(apu.PSW === 0x55, 'MOV dp,#imm: flags unchanged');
}

// ─── 18. Boot ROM visible at 0xFFC0 when control.bit7=1 ─────────────────────
function testBootRomVisible() {
  const apu = makeAPU();
  assert((apu.control & 0x80) !== 0, 'control.bit7=1 by default');
  // First byte of IPL boot ROM is 0xCD (MOV X,#)
  assert(apu.read(0xFFC0) === 0xCD, `Boot ROM[0]=0xCD, got 0x${apu.read(0xFFC0).toString(16)}`);
  // Last byte is 0xFF (STOP)
  assert(apu.read(0xFFFF) === 0xFF, 'Boot ROM[63]=0xFF (STOP)');
}

// ─── run ──────────────────────────────────────────────────────────────────────
testMovImmFlags();
testAdc();
testSbc();
testCmp();
testBranches();
testPushPop();
testCallRet();
testFlagOps();
testIncDec();
testShifts();
testXcn();
testMul();
testMovwYa();
testDirectPage();
testTimer2();
testCpuApuPorts();
testMovDpImm();
testBootRomVisible();

console.log('PASS: SPC700 CPU instruction checks');
