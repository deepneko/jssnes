import { CPU } from './src/CPU.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeBus() {
  const mem = new Uint8Array(0x10000);
  return {
    mem,
    read(addr) {
      return mem[addr & 0xFFFF];
    },
    write(addr, val) {
      mem[addr & 0xFFFF] = val & 0xFF;
    },
  };
}

function runStep({ opcode, operandBytes = [], pc = 0x8000, flags = {}, setup }) {
  const bus = makeBus();
  const cpu = new CPU(bus);

  cpu.P.E = flags.E ?? 0;
  cpu.P.M = flags.M ?? 1;
  cpu.P.X = flags.X ?? 1;
  cpu.P.Z = flags.Z ?? 0;
  cpu.P.N = flags.N ?? 0;
  cpu.P.V = flags.V ?? 0;
  cpu.P.C = flags.C ?? 0;
  cpu.PB = 0x00;
  cpu.PC = pc;

  if (setup) setup(cpu, bus);

  bus.write(pc, opcode);
  for (let i = 0; i < operandBytes.length; i++) {
    bus.write((pc + 1 + i) & 0xFFFF, operandBytes[i]);
  }

  const used = cpu.step();
  return { cpu, used };
}

function testNopAndWdmCycles() {
  let r = runStep({ opcode: 0xEA });
  assert(r.used === 2, `NOP cycles expected 2, got ${r.used}`);

  r = runStep({ opcode: 0x42, operandBytes: [0x99] });
  assert(r.used === 2, `WDM cycles expected 2, got ${r.used}`);
  assert(r.cpu.PC === 0x8002, `WDM PC expected 0x8002, got 0x${r.cpu.PC.toString(16)}`);
}

function testBranchCycles() {
  // BNE not taken: 2 cycles
  let r = runStep({ opcode: 0xD0, operandBytes: [0x02], flags: { Z: 1, E: 0 } });
  assert(r.used === 2, `BNE not taken expected 2, got ${r.used}`);

  // BNE taken, no page cross (native): 3 cycles
  r = runStep({ opcode: 0xD0, operandBytes: [0x02], flags: { Z: 0, E: 0 } });
  assert(r.used === 3, `BNE taken native expected 3, got ${r.used}`);

  // BNE taken, page cross (emulation): 4 cycles
  r = runStep({ opcode: 0xD0, operandBytes: [0xFF], pc: 0x80FE, flags: { Z: 0, E: 1 } });
  assert(r.used === 4, `BNE taken emu page-cross expected 4, got ${r.used}`);

  // BNE taken, page cross (native): still 3 cycles
  r = runStep({ opcode: 0xD0, operandBytes: [0xFF], pc: 0x80FE, flags: { Z: 0, E: 0 } });
  assert(r.used === 3, `BNE taken native page-cross expected 3, got ${r.used}`);

  // BRA taken no cross: 3 cycles
  r = runStep({ opcode: 0x80, operandBytes: [0x02], flags: { E: 0 } });
  assert(r.used === 3, `BRA native expected 3, got ${r.used}`);

  // BRA taken with page-cross in emulation: 4 cycles
  r = runStep({ opcode: 0x80, operandBytes: [0xFF], pc: 0x80FE, flags: { E: 1 } });
  assert(r.used === 4, `BRA emu page-cross expected 4, got ${r.used}`);

  // BRL fixed 4 cycles
  r = runStep({ opcode: 0x82, operandBytes: [0x02, 0x00], flags: { E: 0 } });
  assert(r.used === 4, `BRL expected 4, got ${r.used}`);
}

function testFlowAndInterruptCycles() {
  // JSR abs: 6 cycles
  let r = runStep({ opcode: 0x20, operandBytes: [0x34, 0x12] });
  assert(r.used === 6, `JSR expected 6, got ${r.used}`);

  // JSL long: 8 cycles
  r = runStep({ opcode: 0x22, operandBytes: [0x78, 0x56, 0x09] });
  assert(r.used === 8, `JSL expected 8, got ${r.used}`);

  // RTS: 6 cycles
  r = runStep({
    opcode: 0x60,
    setup: (cpu, bus) => {
      cpu.SP = 0x01FD;
      bus.write(0x01FE, 0x34);
      bus.write(0x01FF, 0x12);
    },
  });
  assert(r.used === 6, `RTS expected 6, got ${r.used}`);

  // RTL: 6 cycles
  r = runStep({
    opcode: 0x6B,
    setup: (cpu, bus) => {
      cpu.SP = 0x01FC;
      bus.write(0x01FD, 0x78);
      bus.write(0x01FE, 0x56);
      bus.write(0x01FF, 0x09);
    },
  });
  assert(r.used === 6, `RTL expected 6, got ${r.used}`);

  // RTI emulation: 6 cycles
  r = runStep({
    opcode: 0x40,
    flags: { E: 1 },
    setup: (cpu, bus) => {
      cpu.SP = 0x01FC;
      bus.write(0x01FD, 0x24);
      bus.write(0x01FE, 0x34);
      bus.write(0x01FF, 0x12);
    },
  });
  assert(r.used === 6, `RTI emu expected 6, got ${r.used}`);

  // RTI native: 7 cycles
  r = runStep({
    opcode: 0x40,
    flags: { E: 0 },
    setup: (cpu, bus) => {
      cpu.SP = 0x01FB;
      cpu.X = 0xABCD;
      cpu.Y = 0x9876;
      bus.write(0x01FC, 0x24);
      bus.write(0x01FD, 0x34);
      bus.write(0x01FE, 0x12);
      bus.write(0x01FF, 0x09);
    },
  });
  assert(r.used === 7, `RTI native expected 7, got ${r.used}`);

  // Restoring P with X=1 must truncate X/Y to 8-bit.
  r = runStep({
    opcode: 0x40,
    flags: { E: 0 },
    setup: (cpu, bus) => {
      cpu.SP = 0x01FB;
      cpu.X = 0xABCD;
      cpu.Y = 0x9876;
      bus.write(0x01FC, 0x10);
      bus.write(0x01FD, 0x34);
      bus.write(0x01FE, 0x12);
      bus.write(0x01FF, 0x09);
    },
  });
  assert(r.cpu.P.X === 1, 'RTI native must restore X flag');
  assert(r.cpu.X === 0x00CD, `RTI native with X=1 must truncate X high byte, got 0x${r.cpu.X.toString(16)}`);
  assert(r.cpu.Y === 0x0076, `RTI native with X=1 must truncate Y high byte, got 0x${r.cpu.Y.toString(16)}`);

  // BRK emulation: 7 cycles
  r = runStep({
    opcode: 0x00,
    operandBytes: [0xEA],
    flags: { E: 1 },
    setup: (_cpu, bus) => {
      bus.write(0xFFFE, 0x34);
      bus.write(0xFFFF, 0x12);
    },
  });
  assert(r.used === 7, `BRK emu expected 7, got ${r.used}`);

  // COP emulation: 7 cycles
  r = runStep({
    opcode: 0x02,
    operandBytes: [0xEA],
    flags: { E: 1 },
    setup: (_cpu, bus) => {
      bus.write(0xFFF4, 0x78);
      bus.write(0xFFF5, 0x56);
    },
  });
  assert(r.used === 7, `COP emu expected 7, got ${r.used}`);

  // BRK native: 8 cycles
  r = runStep({
    opcode: 0x00,
    operandBytes: [0xEA],
    flags: { E: 0 },
    setup: (_cpu, bus) => {
      bus.write(0xFFE6, 0x34);
      bus.write(0xFFE7, 0x12);
    },
  });
  assert(r.used === 8, `BRK native expected 8, got ${r.used}`);

  // COP native: 8 cycles
  r = runStep({
    opcode: 0x02,
    operandBytes: [0xEA],
    flags: { E: 0 },
    setup: (_cpu, bus) => {
      bus.write(0xFFE4, 0x78);
      bus.write(0xFFE5, 0x56);
    },
  });
  assert(r.used === 8, `COP native expected 8, got ${r.used}`);
}

function testHardwareInterruptMethodCycles() {
  const bus = makeBus();
  const cpu = new CPU(bus);

  // NMI emulation: +7
  cpu.P.E = 1;
  cpu.PC = 0x8000;
  cpu.SP = 0x01FF;
  bus.write(0xFFFA, 0x34);
  bus.write(0xFFFB, 0x12);
  cpu.cycles = 0;
  cpu.nmi();
  assert(cpu.cycles === 7, `NMI emu expected +7, got ${cpu.cycles}`);

  // NMI native: +8
  cpu.P.E = 0;
  cpu.PC = 0x8000;
  cpu.SP = 0x01FF;
  bus.write(0xFFEA, 0x78);
  bus.write(0xFFEB, 0x56);
  cpu.cycles = 0;
  cpu.nmi();
  assert(cpu.cycles === 8, `NMI native expected +8, got ${cpu.cycles}`);

  // IRQ emulation: +7
  cpu.P.E = 1;
  cpu.PC = 0x8000;
  cpu.SP = 0x01FF;
  bus.write(0xFFFE, 0xAB);
  bus.write(0xFFFF, 0xCD);
  cpu.cycles = 0;
  cpu.irq();
  assert(cpu.cycles === 7, `IRQ emu expected +7, got ${cpu.cycles}`);

  // IRQ native: +8
  cpu.P.E = 0;
  cpu.PC = 0x8000;
  cpu.SP = 0x01FF;
  bus.write(0xFFEE, 0x21);
  bus.write(0xFFEF, 0x43);
  cpu.cycles = 0;
  cpu.irq();
  assert(cpu.cycles === 8, `IRQ native expected +8, got ${cpu.cycles}`);
}

function testLoadStoreIndexedCycles() {
  // LDA abs,X 8-bit index/no-cross: 4 cycles
  let r = runStep({
    opcode: 0xBD,
    operandBytes: [0x00, 0x12],
    flags: { E: 0, M: 1, X: 1 },
    setup: (cpu, bus) => {
      cpu.X = 0x0001;
      bus.write(0x001201, 0x7A);
    },
  });
  assert(r.used === 4, `LDA abs,X no-cross expected 4, got ${r.used}`);

  // LDA abs,X 8-bit index/cross: 5 cycles
  r = runStep({
    opcode: 0xBD,
    operandBytes: [0xFF, 0x12],
    flags: { E: 0, M: 1, X: 1 },
    setup: (cpu, bus) => {
      cpu.X = 0x0001;
      bus.write(0x001300, 0x7A);
    },
  });
  assert(r.used === 5, `LDA abs,X cross expected 5, got ${r.used}`);

  // LDA abs,X 16-bit index mode (X=0) ignores page-cross penalty: 6 cycles
  r = runStep({
    opcode: 0xBD,
    operandBytes: [0xFF, 0x12],
    flags: { E: 0, M: 0, X: 0 },
    setup: (cpu, bus) => {
      cpu.X = 0x0001;
      bus.write(0x001300, 0x12);
      bus.write(0x001301, 0x34);
    },
  });
  assert(r.used === 6, `LDA abs,X 16-bit index expected 6, got ${r.used}`);

  // LDX abs,Y 8-bit index/cross: 5 cycles
  r = runStep({
    opcode: 0xBE,
    operandBytes: [0xFF, 0x12],
    flags: { E: 0, X: 1 },
    setup: (cpu, bus) => {
      cpu.Y = 0x0001;
      bus.write(0x001300, 0x66);
    },
  });
  assert(r.used === 5, `LDX abs,Y cross expected 5, got ${r.used}`);

  // LDY abs,X 8-bit index/no-cross: 4 cycles
  r = runStep({
    opcode: 0xBC,
    operandBytes: [0x00, 0x12],
    flags: { E: 0, X: 1 },
    setup: (cpu, bus) => {
      cpu.X = 0x0001;
      bus.write(0x001201, 0x55);
    },
  });
  assert(r.used === 4, `LDY abs,X no-cross expected 4, got ${r.used}`);

  // STA abs: 4 cycles (8-bit A)
  r = runStep({ opcode: 0x8D, operandBytes: [0x00, 0x12], flags: { E: 0, M: 1 } });
  assert(r.used === 4, `STA abs expected 4, got ${r.used}`);

  // STA abs,X: 5 cycles (8-bit A)
  r = runStep({ opcode: 0x9D, operandBytes: [0x00, 0x12], flags: { E: 0, M: 1 }, setup: (cpu) => { cpu.X = 1; } });
  assert(r.used === 5, `STA abs,X expected 5, got ${r.used}`);

  // ORA abs,X cross 8-bit index: 5 cycles
  r = runStep({
    opcode: 0x1D,
    operandBytes: [0xFF, 0x12],
    flags: { E: 0, M: 1, X: 1 },
    setup: (cpu, bus) => {
      cpu.X = 1;
      cpu.A = 0x00;
      bus.write(0x001300, 0x0F);
    },
  });
  assert(r.used === 5, `ORA abs,X cross expected 5, got ${r.used}`);

  // ADC (dp),Y no-cross 8-bit index, DP low=0: 5 cycles
  r = runStep({
    opcode: 0x71,
    operandBytes: [0x10],
    flags: { E: 0, M: 1, X: 1, C: 0 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0000;
      cpu.Y = 0x0001;
      cpu.A = 0x00;
      bus.write(0x000010, 0x00);
      bus.write(0x000011, 0x12);
      bus.write(0x001201, 0x05);
    },
  });
  assert(r.used === 5, `ADC (dp),Y no-cross expected 5, got ${r.used}`);

  // ADC (dp),Y cross 8-bit index with DP low!=0 (w=1): 7 cycles
  r = runStep({
    opcode: 0x71,
    operandBytes: [0x10],
    flags: { E: 0, M: 1, X: 1, C: 0 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0101;
      cpu.Y = 0x0001;
      cpu.A = 0x00;
      bus.write(0x000111, 0xFF);
      bus.write(0x000112, 0x12);
      bus.write(0x001300, 0x05);
    },
  });
  assert(r.used === 7, `ADC (dp),Y cross+w expected 7, got ${r.used}`);

  // CMP abs,Y no-cross 16-bit index mode: 6 cycles
  r = runStep({
    opcode: 0xD9,
    operandBytes: [0x00, 0x12],
    flags: { E: 0, M: 0, X: 0 },
    setup: (cpu, bus) => {
      cpu.Y = 0x0001;
      cpu.A = 0x1234;
      bus.write(0x001201, 0x34);
      bus.write(0x001202, 0x12);
    },
  });
  assert(r.used === 6, `CMP abs,Y 16-bit index expected 6, got ${r.used}`);
}

function testLoadStoreGeneralCycles() {
  let r;

  // LDA #imm 16-bit accumulator: 3 cycles
  r = runStep({ opcode: 0xA9, operandBytes: [0x34, 0x12], flags: { E: 0, M: 0 } });
  assert(r.used === 3, `LDA #imm 16-bit expected 3, got ${r.used}`);

  // LDA dp with DP low!=0, 8-bit accumulator: 4 cycles
  r = runStep({
    opcode: 0xA5,
    operandBytes: [0x20],
    flags: { E: 0, M: 1 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0101;
      bus.write(0x0121, 0x7A);
    },
  });
  assert(r.used === 4, `LDA dp +w expected 4, got ${r.used}`);

  // LDA (dp),Y with cross, DP low!=0, X=1, M=1: 7 cycles
  r = runStep({
    opcode: 0xB1,
    operandBytes: [0x10],
    flags: { E: 0, M: 1, X: 1 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0101;
      cpu.Y = 0x0001;
      bus.write(0x0111, 0xFF);
      bus.write(0x0112, 0x12);
      bus.write(0x1300, 0x55);
    },
  });
  assert(r.used === 7, `LDA (dp),Y cross+w expected 7, got ${r.used}`);

  // LDX #imm 16-bit index: 3 cycles
  r = runStep({ opcode: 0xA2, operandBytes: [0x78, 0x56], flags: { E: 0, X: 0 } });
  assert(r.used === 3, `LDX #imm 16-bit expected 3, got ${r.used}`);

  // LDY dp,X with DP low!=0 and 8-bit index: 5 cycles
  r = runStep({
    opcode: 0xB4,
    operandBytes: [0x20],
    flags: { E: 0, X: 1 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0101;
      cpu.X = 0x0001;
      bus.write(0x0122, 0x66);
    },
  });
  assert(r.used === 5, `LDY dp,X +w expected 5, got ${r.used}`);

  // STA (dp),Y with DP low!=0, 8-bit accumulator: 8 cycles
  r = runStep({
    opcode: 0x91,
    operandBytes: [0x10],
    flags: { E: 0, M: 1 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0101;
      cpu.Y = 0x0002;
      cpu.A = 0x00AA;
      bus.write(0x0111, 0x00);
      bus.write(0x0112, 0x20);
    },
  });
  assert(r.used === 8, `STA (dp),Y +w expected 8, got ${r.used}`);

  // STX dp,Y with DP low!=0 and 16-bit index: 7 cycles
  r = runStep({
    opcode: 0x96,
    operandBytes: [0x20],
    flags: { E: 0, X: 0 },
    setup: (cpu) => {
      cpu.DP = 0x0101;
      cpu.Y = 0x0001;
      cpu.X = 0x1234;
    },
  });
  assert(r.used === 7, `STX dp,Y 16-bit +w expected 7, got ${r.used}`);

  // STZ abs,X 16-bit accumulator: 7 cycles
  r = runStep({
    opcode: 0x9E,
    operandBytes: [0x00, 0x20],
    flags: { E: 0, M: 0 },
    setup: (cpu) => {
      cpu.X = 0x0001;
    },
  });
  assert(r.used === 7, `STZ abs,X 16-bit expected 7, got ${r.used}`);
}

function testTrbTsbCycles() {
  let r;

  // TRB dp with DP low!=0: 8-bit=6 cycles, 16-bit=7 cycles
  r = runStep({
    opcode: 0x14,
    operandBytes: [0x20],
    flags: { E: 0, M: 1 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0101;
      cpu.A = 0x000F;
      bus.write(0x0121, 0xFF);
    },
  });
  assert(r.used === 6, `TRB dp 8-bit +w expected 6, got ${r.used}`);

  r = runStep({
    opcode: 0x14,
    operandBytes: [0x20],
    flags: { E: 0, M: 0 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0101;
      cpu.A = 0x00FF;
      bus.write(0x0121, 0xFF);
      bus.write(0x0122, 0x00);
    },
  });
  assert(r.used === 7, `TRB dp 16-bit +w expected 7, got ${r.used}`);

  // TSB abs: 8-bit=6 cycles, 16-bit=7 cycles
  r = runStep({
    opcode: 0x0C,
    operandBytes: [0x00, 0x20],
    flags: { E: 0, M: 1 },
    setup: (cpu, bus) => {
      cpu.A = 0x000F;
      bus.write(0x2000, 0xF0);
    },
  });
  assert(r.used === 6, `TSB abs 8-bit expected 6, got ${r.used}`);

  r = runStep({
    opcode: 0x0C,
    operandBytes: [0x00, 0x20],
    flags: { E: 0, M: 0 },
    setup: (cpu, bus) => {
      cpu.A = 0x00FF;
      bus.write(0x2000, 0xF0);
      bus.write(0x2001, 0x00);
    },
  });
  assert(r.used === 7, `TSB abs 16-bit expected 7, got ${r.used}`);
}

function testAluGeneralCycles() {
  let r;

  // ORA dp 8-bit, DP low=0 -> 3 cycles
  r = runStep({
    opcode: 0x05,
    operandBytes: [0x20],
    flags: { E: 0, M: 1 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0000;
      cpu.A = 0x0001;
      bus.write(0x0020, 0x02);
    },
  });
  assert(r.used === 3, `ORA dp expected 3, got ${r.used}`);

  // AND (dp) 16-bit with DP low!=0 -> 7 cycles
  r = runStep({
    opcode: 0x32,
    operandBytes: [0x20],
    flags: { E: 0, M: 0 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0101;
      cpu.A = 0x1234;
      bus.write(0x0121, 0x00);
      bus.write(0x0122, 0x20);
      bus.write(0x2000, 0x34);
      bus.write(0x2001, 0x12);
    },
  });
  assert(r.used === 7, `AND (dp) 16-bit +w expected 7, got ${r.used}`);

  // EOR abs long 8-bit -> 5 cycles
  r = runStep({
    opcode: 0x4F,
    operandBytes: [0x00, 0x20, 0x00],
    flags: { E: 0, M: 1 },
    setup: (cpu, bus) => {
      cpu.A = 0x00AA;
      bus.write(0x2000, 0x0F);
    },
  });
  assert(r.used === 5, `EOR abs long expected 5, got ${r.used}`);

  // ADC dp,X 8-bit with DP low!=0 -> 5 cycles
  r = runStep({
    opcode: 0x75,
    operandBytes: [0x20],
    flags: { E: 0, M: 1, C: 0 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0101;
      cpu.X = 0x0001;
      cpu.A = 0x0001;
      bus.write(0x0122, 0x01);
    },
  });
  assert(r.used === 5, `ADC dp,X +w expected 5, got ${r.used}`);

  // SBC [dp],Y 16-bit with DP low=0 -> 7 cycles
  r = runStep({
    opcode: 0xF7,
    operandBytes: [0x20],
    flags: { E: 0, M: 0, C: 1 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0000;
      cpu.Y = 0x0001;
      cpu.A = 0x1234;
      bus.write(0x0020, 0x00);
      bus.write(0x0021, 0x20);
      bus.write(0x0022, 0x00);
      bus.write(0x2001, 0x34);
      bus.write(0x2002, 0x12);
    },
  });
  assert(r.used === 7, `SBC [dp],Y 16-bit expected 7, got ${r.used}`);

  // CMP sr,S 8-bit -> 4 cycles
  r = runStep({
    opcode: 0xC3,
    operandBytes: [0x02],
    flags: { E: 0, M: 1 },
    setup: (cpu, bus) => {
      cpu.SP = 0x01F0;
      cpu.A = 0x0077;
      bus.write(0x01F2, 0x77);
    },
  });
  assert(r.used === 4, `CMP sr,S expected 4, got ${r.used}`);
}

function testCompareAndBitCycles() {
  let r;

  // CPX #imm: 8-bit index 2 cycles, 16-bit index 3 cycles
  r = runStep({ opcode: 0xE0, operandBytes: [0x10], flags: { E: 0, X: 1 }, setup: (cpu) => { cpu.X = 0x10; } });
  assert(r.used === 2, `CPX #imm 8-bit expected 2, got ${r.used}`);

  r = runStep({ opcode: 0xE0, operandBytes: [0x34, 0x12], flags: { E: 0, X: 0 }, setup: (cpu) => { cpu.X = 0x1234; } });
  assert(r.used === 3, `CPX #imm 16-bit expected 3, got ${r.used}`);

  // CPY abs: 8-bit index 4 cycles, 16-bit index 5 cycles
  r = runStep({
    opcode: 0xCC,
    operandBytes: [0x00, 0x12],
    flags: { E: 0, X: 1 },
    setup: (cpu, bus) => {
      cpu.Y = 0x34;
      bus.write(0x001200, 0x34);
    },
  });
  assert(r.used === 4, `CPY abs 8-bit expected 4, got ${r.used}`);

  r = runStep({
    opcode: 0xCC,
    operandBytes: [0x00, 0x12],
    flags: { E: 0, X: 0 },
    setup: (cpu, bus) => {
      cpu.Y = 0x1234;
      bus.write(0x001200, 0x34);
      bus.write(0x001201, 0x12);
    },
  });
  assert(r.used === 5, `CPY abs 16-bit expected 5, got ${r.used}`);

  // BIT #imm: 8-bit A 2 cycles, 16-bit A 3 cycles
  r = runStep({ opcode: 0x89, operandBytes: [0x0F], flags: { E: 0, M: 1 }, setup: (cpu) => { cpu.A = 0x00FF; } });
  assert(r.used === 2, `BIT #imm 8-bit expected 2, got ${r.used}`);

  r = runStep({ opcode: 0x89, operandBytes: [0xFF, 0x00], flags: { E: 0, M: 0 }, setup: (cpu) => { cpu.A = 0x00FF; } });
  assert(r.used === 3, `BIT #imm 16-bit expected 3, got ${r.used}`);

  // BIT abs,X: no page-cross penalty
  r = runStep({
    opcode: 0x3C,
    operandBytes: [0xFF, 0x12],
    flags: { E: 0, M: 1, X: 1 },
    setup: (cpu, bus) => {
      cpu.X = 1;
      cpu.A = 0x00FF;
      bus.write(0x001300, 0xFF);
    },
  });
  assert(r.used === 4, `BIT abs,X cross 8-bit index expected 4, got ${r.used}`);

  r = runStep({
    opcode: 0x3C,
    operandBytes: [0xFF, 0x12],
    flags: { E: 0, M: 0, X: 0 },
    setup: (cpu, bus) => {
      cpu.X = 1;
      cpu.A = 0x00FF;
      bus.write(0x001300, 0xFF);
      bus.write(0x001301, 0x00);
    },
  });
  assert(r.used === 5, `BIT abs,X 16-bit index expected 5, got ${r.used}`);

  // BIT dp with DP low!=0 adds w cycle
  r = runStep({
    opcode: 0x24,
    operandBytes: [0x20],
    flags: { E: 0, M: 1 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0101;
      cpu.A = 0x0001;
      bus.write(0x0121, 0x01);
    },
  });
  assert(r.used === 4, `BIT dp +w expected 4, got ${r.used}`);

  // CPX/CPY dp with DP low!=0 adds w cycle
  r = runStep({
    opcode: 0xE4,
    operandBytes: [0x20],
    flags: { E: 0, X: 1 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0101;
      cpu.X = 0x34;
      bus.write(0x0121, 0x34);
    },
  });
  assert(r.used === 4, `CPX dp +w expected 4, got ${r.used}`);

  r = runStep({
    opcode: 0xC4,
    operandBytes: [0x20],
    flags: { E: 0, X: 0 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0101;
      cpu.Y = 0x1234;
      bus.write(0x0121, 0x34);
      bus.write(0x0122, 0x12);
    },
  });
  assert(r.used === 5, `CPY dp 16-bit +w expected 5, got ${r.used}`);
}

function testRmwMemoryCycles() {
  let r;

  // INC dp: 8-bit M=1 -> 5 cycles, 16-bit M=0 -> 7 cycles
  r = runStep({
    opcode: 0xE6,
    operandBytes: [0x20],
    flags: { E: 0, M: 1 },
    setup: (_cpu, bus) => {
      bus.write(0x0020, 0x10);
    },
  });
  assert(r.used === 5, `INC dp 8-bit expected 5, got ${r.used}`);

  r = runStep({
    opcode: 0xE6,
    operandBytes: [0x20],
    flags: { E: 0, M: 0 },
    setup: (_cpu, bus) => {
      bus.write(0x0020, 0x10);
      bus.write(0x0021, 0x00);
    },
  });
  assert(r.used === 7, `INC dp 16-bit expected 7, got ${r.used}`);

  // DEC abs,X: 8-bit 7 cycles, 16-bit 9 cycles
  r = runStep({
    opcode: 0xDE,
    operandBytes: [0x00, 0x12],
    flags: { E: 0, M: 1 },
    setup: (cpu, bus) => {
      cpu.X = 1;
      bus.write(0x1201, 0x10);
    },
  });
  assert(r.used === 7, `DEC abs,X 8-bit expected 7, got ${r.used}`);

  r = runStep({
    opcode: 0xDE,
    operandBytes: [0x00, 0x12],
    flags: { E: 0, M: 0 },
    setup: (cpu, bus) => {
      cpu.X = 1;
      bus.write(0x1201, 0x10);
      bus.write(0x1202, 0x00);
    },
  });
  assert(r.used === 9, `DEC abs,X 16-bit expected 9, got ${r.used}`);

  // ASL abs: 8-bit 6 cycles, 16-bit 8 cycles
  r = runStep({
    opcode: 0x0E,
    operandBytes: [0x00, 0x12],
    flags: { E: 0, M: 1 },
    setup: (_cpu, bus) => {
      bus.write(0x1200, 0x40);
    },
  });
  assert(r.used === 6, `ASL abs 8-bit expected 6, got ${r.used}`);

  r = runStep({
    opcode: 0x0E,
    operandBytes: [0x00, 0x12],
    flags: { E: 0, M: 0 },
    setup: (_cpu, bus) => {
      bus.write(0x1200, 0x40);
      bus.write(0x1201, 0x00);
    },
  });
  assert(r.used === 8, `ASL abs 16-bit expected 8, got ${r.used}`);

  // ROR dp,X: 8-bit 6 cycles, 16-bit 8 cycles
  r = runStep({
    opcode: 0x76,
    operandBytes: [0x20],
    flags: { E: 0, M: 1, C: 1 },
    setup: (cpu, bus) => {
      cpu.X = 1;
      bus.write(0x0021, 0x02);
    },
  });
  assert(r.used === 6, `ROR dp,X 8-bit expected 6, got ${r.used}`);

  r = runStep({
    opcode: 0x76,
    operandBytes: [0x20],
    flags: { E: 0, M: 0, C: 1 },
    setup: (cpu, bus) => {
      cpu.X = 1;
      bus.write(0x0021, 0x02);
      bus.write(0x0022, 0x00);
    },
  });
  assert(r.used === 8, `ROR dp,X 16-bit expected 8, got ${r.used}`);
}

function testSimpleInstructionCycles() {
  let r;

  // Single-byte register/accumulator ops are 2 cycles
  r = runStep({ opcode: 0xE8, flags: { E: 0, X: 1 }, setup: (cpu) => { cpu.X = 0x10; } }); // INX
  assert(r.used === 2, `INX expected 2, got ${r.used}`);

  r = runStep({ opcode: 0xCA, flags: { E: 0, X: 0 }, setup: (cpu) => { cpu.X = 0x1000; } }); // DEX
  assert(r.used === 2, `DEX expected 2, got ${r.used}`);

  r = runStep({ opcode: 0x1A, flags: { E: 0, M: 1 }, setup: (cpu) => { cpu.A = 0x00FF; } }); // INC A
  assert(r.used === 2, `INC A expected 2, got ${r.used}`);

  r = runStep({ opcode: 0x3A, flags: { E: 0, M: 0 }, setup: (cpu) => { cpu.A = 0x0001; } }); // DEC A
  assert(r.used === 2, `DEC A expected 2, got ${r.used}`);

  r = runStep({ opcode: 0x0A, flags: { E: 0, M: 1 }, setup: (cpu) => { cpu.A = 0x0080; } }); // ASL A
  assert(r.used === 2, `ASL A expected 2, got ${r.used}`);

  r = runStep({ opcode: 0x6A, flags: { E: 0, M: 0, C: 1 }, setup: (cpu) => { cpu.A = 0x0002; } }); // ROR A
  assert(r.used === 2, `ROR A expected 2, got ${r.used}`);

  // XBA is 3 cycles
  r = runStep({ opcode: 0xEB, flags: { E: 0, M: 0 }, setup: (cpu) => { cpu.A = 0x1234; } });
  assert(r.used === 3, `XBA expected 3, got ${r.used}`);
}

function testControlAndTransferCycles() {
  let r;

  // Flag ops: 2 cycles
  r = runStep({ opcode: 0x18 }); // CLC
  assert(r.used === 2, `CLC expected 2, got ${r.used}`);

  r = runStep({ opcode: 0xF8 }); // SED
  assert(r.used === 2, `SED expected 2, got ${r.used}`);

  // REP/SEP: 3 cycles
  r = runStep({ opcode: 0xC2, operandBytes: [0x30], flags: { E: 0 } });
  assert(r.used === 3, `REP expected 3, got ${r.used}`);

  r = runStep({ opcode: 0xE2, operandBytes: [0x30], flags: { E: 0 } });
  assert(r.used === 3, `SEP expected 3, got ${r.used}`);

  // XCE: 2 cycles
  r = runStep({ opcode: 0xFB, flags: { E: 0, C: 1 } });
  assert(r.used === 2, `XCE expected 2, got ${r.used}`);

  // JMP/JML family
  r = runStep({ opcode: 0x4C, operandBytes: [0x34, 0x12] });
  assert(r.used === 3, `JMP abs expected 3, got ${r.used}`);

  r = runStep({
    opcode: 0x6C,
    operandBytes: [0x00, 0x20],
    setup: (_cpu, bus) => {
      bus.write(0x2000, 0x34);
      bus.write(0x2001, 0x12);
    },
  });
  assert(r.used === 5, `JMP (abs) expected 5, got ${r.used}`);

  r = runStep({
    opcode: 0x7C,
    operandBytes: [0x00, 0x20],
    setup: (cpu, bus) => {
      cpu.X = 1;
      bus.write(0x2001, 0x34);
      bus.write(0x2002, 0x12);
    },
  });
  assert(r.used === 6, `JMP (abs,X) expected 6, got ${r.used}`);

  r = runStep({ opcode: 0x5C, operandBytes: [0x78, 0x56, 0x09] });
  assert(r.used === 4, `JML long expected 4, got ${r.used}`);

  r = runStep({
    opcode: 0xDC,
    operandBytes: [0x00, 0x20],
    setup: (_cpu, bus) => {
      bus.write(0x2000, 0x78);
      bus.write(0x2001, 0x56);
      bus.write(0x2002, 0x09);
    },
  });
  assert(r.used === 6, `JML [abs] expected 6, got ${r.used}`);

  // Transfer ops: 2 cycles
  r = runStep({ opcode: 0xAA, flags: { E: 0, X: 1, M: 1 }, setup: (cpu) => { cpu.A = 0x0034; } });
  assert(r.used === 2, `TAX expected 2, got ${r.used}`);

  r = runStep({ opcode: 0x9A, flags: { E: 0, X: 0 }, setup: (cpu) => { cpu.X = 0x1234; } });
  assert(r.used === 2, `TXS expected 2, got ${r.used}`);

  r = runStep({ opcode: 0x5B, flags: { E: 0, M: 0 }, setup: (cpu) => { cpu.A = 0x1234; } });
  assert(r.used === 2, `TCD expected 2, got ${r.used}`);

}

function testAbsXIndirectPointerProgramBank() {
  // Use a 24-bit-addressable bus so bank 0 and PB can be distinguished.
  const mem = new Map();
  const bus = {
    read(addr) {
      return mem.get(addr & 0xFFFFFF) ?? 0;
    },
    write(addr, val) {
      mem.set(addr & 0xFFFFFF, val & 0xFF);
    },
  };

  const cpu = new CPU(bus);
  cpu.P.E = 0;
  cpu.P.M = 0;
  cpu.P.X = 0;
  cpu.PB = 0x7E;
  cpu.X = 1;

  // JMP (abs,X): pointer bytes must be fetched from PBR (not bank 0).
  cpu.PC = 0x8000;
  bus.write(0x7E8000, 0x7C);
  bus.write(0x7E8001, 0x00);
  bus.write(0x7E8002, 0x20);
  bus.write(0x002001, 0x34);
  bus.write(0x002002, 0x12);
  bus.write(0x7E2001, 0x78);
  bus.write(0x7E2002, 0x56);

  let used = cpu.step();
  assert(used === 6, `JMP (abs,X) expected 6 cycles, got ${used}`);
  assert(cpu.PC === 0x5678, `JMP (abs,X) pointer must be read from PBR, got PC=0x${cpu.PC.toString(16)}`);

  // JSR (abs,X): same PBR pointer rule.
  cpu.PC = 0x8100;
  cpu.SP = 0x1FF0;
  bus.write(0x7E8100, 0xFC);
  bus.write(0x7E8101, 0x00);
  bus.write(0x7E8102, 0x20);
  bus.write(0x002001, 0x9A);
  bus.write(0x002002, 0xBC);
  bus.write(0x7E2001, 0x00);
  bus.write(0x7E2002, 0x00);

  used = cpu.step();
  assert(used === 8, `JSR (abs,X) expected 8 cycles, got ${used}`);
  assert(cpu.PC === 0x0000, `JSR (abs,X) pointer must be read from PBR, got PC=0x${cpu.PC.toString(16)}`);
}

function testStackAndPushPullCycles() {
  let r;

  // PHP/PLP
  r = runStep({ opcode: 0x08, flags: { E: 1 } });
  assert(r.used === 3, `PHP expected 3, got ${r.used}`);

  r = runStep({
    opcode: 0x28,
    flags: { E: 1 },
    setup: (cpu, bus) => {
      cpu.SP = 0x01FE;
      bus.write(0x01FF, 0x24);
    },
  });
  assert(r.used === 4, `PLP expected 4, got ${r.used}`);

  r = runStep({
    opcode: 0x28,
    flags: { E: 0, X: 0 },
    setup: (cpu, bus) => {
      cpu.SP = 0x01FE;
      cpu.X = 0xBEEF;
      cpu.Y = 0xCAFE;
      bus.write(0x01FF, 0x10);
    },
  });
  assert(r.cpu.P.X === 1, 'PLP native must restore X flag');
  assert(r.cpu.X === 0x00EF, `PLP native with X=1 must truncate X high byte, got 0x${r.cpu.X.toString(16)}`);
  assert(r.cpu.Y === 0x00FE, `PLP native with X=1 must truncate Y high byte, got 0x${r.cpu.Y.toString(16)}`);

  // PHA/PLA 8-bit vs 16-bit
  r = runStep({ opcode: 0x48, flags: { E: 0, M: 1 }, setup: (cpu) => { cpu.A = 0x00AA; } });
  assert(r.used === 3, `PHA 8-bit expected 3, got ${r.used}`);

  r = runStep({ opcode: 0x48, flags: { E: 0, M: 0 }, setup: (cpu) => { cpu.A = 0xBEEF; } });
  assert(r.used === 4, `PHA 16-bit expected 4, got ${r.used}`);

  r = runStep({
    opcode: 0x68,
    flags: { E: 0, M: 1 },
    setup: (cpu, bus) => {
      cpu.SP = 0x01FE;
      bus.write(0x01FF, 0x42);
    },
  });
  assert(r.used === 4, `PLA 8-bit expected 4, got ${r.used}`);

  r = runStep({
    opcode: 0x68,
    flags: { E: 0, M: 0 },
    setup: (cpu, bus) => {
      cpu.SP = 0x01FD;
      bus.write(0x01FE, 0x34);
      bus.write(0x01FF, 0x12);
    },
  });
  assert(r.used === 5, `PLA 16-bit expected 5, got ${r.used}`);

  // PHX/PLX via X width
  r = runStep({ opcode: 0xDA, flags: { E: 0, X: 1 }, setup: (cpu) => { cpu.X = 0x0077; } });
  assert(r.used === 3, `PHX 8-bit expected 3, got ${r.used}`);

  r = runStep({
    opcode: 0xFA,
    flags: { E: 0, X: 0 },
    setup: (cpu, bus) => {
      cpu.SP = 0x01FD;
      bus.write(0x01FE, 0x34);
      bus.write(0x01FF, 0x12);
    },
  });
  assert(r.used === 5, `PLX 16-bit expected 5, got ${r.used}`);

  // Bank and DP push/pull
  r = runStep({ opcode: 0x4B, flags: { E: 0 }, setup: (cpu) => { cpu.PB = 0x12; } });
  assert(r.used === 3, `PHK expected 3, got ${r.used}`);

  r = runStep({
    opcode: 0xAB,
    flags: { E: 0 },
    setup: (cpu, bus) => {
      cpu.SP = 0x01FE;
      bus.write(0x01FF, 0x34);
    },
  });
  assert(r.used === 4, `PLB expected 4, got ${r.used}`);

  // PEA/PEI/PER
  r = runStep({ opcode: 0xF4, operandBytes: [0x34, 0x12], flags: { E: 0 } });
  assert(r.used === 5, `PEA expected 5, got ${r.used}`);

  r = runStep({
    opcode: 0xD4,
    operandBytes: [0x20],
    flags: { E: 0 },
    setup: (cpu, bus) => {
      cpu.DP = 0x0000;
      bus.write(0x0020, 0x78);
      bus.write(0x0021, 0x56);
    },
  });
  assert(r.used === 6, `PEI expected 6, got ${r.used}`);

  r = runStep({ opcode: 0x62, operandBytes: [0x02, 0x00], flags: { E: 0 } });
  assert(r.used === 6, `PER expected 6, got ${r.used}`);
}

function testBlockMoveCyclesAndSemantics() {
  const bus = makeBus();
  const cpu = new CPU(bus);

  cpu.P.E = 0;
  cpu.P.M = 0;
  cpu.P.X = 0;
  cpu.PB = 0x00;
  cpu.PC = 0x8000;

  // MVN $00,$00 with A=1 should move exactly 2 bytes over 2 executions.
  // First execution must rewind PC to opcode for internal loop continuation.
  cpu.A = 0x0001;
  cpu.X = 0x0010;
  cpu.Y = 0x0020;

  bus.write(0x8000, 0x54);
  bus.write(0x8001, 0x00);
  bus.write(0x8002, 0x00);
  bus.write(0x0010, 0xAA);
  bus.write(0x0011, 0xBB);

  let used = cpu.step();
  assert(used === 7, `MVN first step expected 7 cycles, got ${used}`);
  assert(bus.read(0x0020) === 0xAA, `MVN first step expected dst byte 0xAA, got 0x${bus.read(0x0020).toString(16)}`);
  assert(cpu.A === 0x0000, `MVN first step expected A=0x0000, got 0x${cpu.A.toString(16)}`);
  assert(cpu.X === 0x0011 && cpu.Y === 0x0021, `MVN first step expected X/Y increment, got X=0x${cpu.X.toString(16)} Y=0x${cpu.Y.toString(16)}`);
  assert(cpu.PC === 0x8000, `MVN first step expected PC rewind to 0x8000, got 0x${cpu.PC.toString(16)}`);

  used = cpu.step();
  assert(used === 7, `MVN second step expected 7 cycles, got ${used}`);
  assert(bus.read(0x0021) === 0xBB, `MVN second step expected dst byte 0xBB, got 0x${bus.read(0x0021).toString(16)}`);
  assert(cpu.A === 0xFFFF, `MVN second step expected A=0xFFFF, got 0x${cpu.A.toString(16)}`);
  assert(cpu.X === 0x0012 && cpu.Y === 0x0022, `MVN second step expected X/Y increment, got X=0x${cpu.X.toString(16)} Y=0x${cpu.Y.toString(16)}`);
  assert(cpu.PC === 0x8003, `MVN second step expected PC advance to 0x8003, got 0x${cpu.PC.toString(16)}`);

  // MVP $00,$00 with A=0 should move exactly 1 byte and decrement X/Y.
  cpu.PC = 0x8100;
  cpu.A = 0x0000;
  cpu.X = 0x0030;
  cpu.Y = 0x0040;
  bus.write(0x8100, 0x44);
  bus.write(0x8101, 0x00);
  bus.write(0x8102, 0x00);
  bus.write(0x0030, 0x5A);

  used = cpu.step();
  assert(used === 7, `MVP single step expected 7 cycles, got ${used}`);
  assert(bus.read(0x0040) === 0x5A, `MVP expected dst byte 0x5A, got 0x${bus.read(0x0040).toString(16)}`);
  assert(cpu.A === 0xFFFF, `MVP expected A=0xFFFF after single byte, got 0x${cpu.A.toString(16)}`);
  assert(cpu.X === 0x002F && cpu.Y === 0x003F, `MVP expected X/Y decrement, got X=0x${cpu.X.toString(16)} Y=0x${cpu.Y.toString(16)}`);
  assert(cpu.PC === 0x8103, `MVP expected PC advance to 0x8103, got 0x${cpu.PC.toString(16)}`);
}

function testBlockMoveBoundaryWraps() {
  const bus = makeBus();
  const cpu = new CPU(bus);

  cpu.P.E = 0;
  cpu.P.M = 0;
  cpu.P.X = 0;

  // MVN with X/Y near wrap boundary.
  cpu.PC = 0x8200;
  cpu.PB = 0x00;
  cpu.A = 0x0000;
  cpu.X = 0xFFFF;
  cpu.Y = 0xFFFF;
  bus.write(0x8200, 0x54);
  bus.write(0x8201, 0x00);
  bus.write(0x8202, 0x00);
  bus.write(0xFFFF, 0xA5);

  let used = cpu.step();
  assert(used === 7, `MVN boundary expected 7 cycles, got ${used}`);
  assert(bus.read(0xFFFF) === 0xA5, `MVN boundary expected write to 0xFFFF`);
  assert(cpu.X === 0x0000 && cpu.Y === 0x0000, `MVN boundary must wrap X/Y to 0x0000`);
  assert(cpu.PC === 0x8203, `MVN boundary with A=0 must finish and advance PC, got 0x${cpu.PC.toString(16)}`);

  // MVP with X/Y at zero must wrap downward to 0xFFFF.
  cpu.PC = 0x8300;
  cpu.A = 0x0000;
  cpu.X = 0x0000;
  cpu.Y = 0x0000;
  bus.write(0x8300, 0x44);
  bus.write(0x8301, 0x00);
  bus.write(0x8302, 0x00);
  bus.write(0x0000, 0x3C);

  used = cpu.step();
  assert(used === 7, `MVP boundary expected 7 cycles, got ${used}`);
  assert(bus.read(0x0000) === 0x3C, `MVP boundary expected write to 0x0000`);
  assert(cpu.X === 0xFFFF && cpu.Y === 0xFFFF, `MVP boundary must wrap X/Y to 0xFFFF`);
  assert(cpu.PC === 0x8303, `MVP boundary with A=0 must finish and advance PC, got 0x${cpu.PC.toString(16)}`);
}

function testBlockMoveWith8bitIndex() {
  // When P.X=1 (8-bit index), MVN/MVP must wrap X and Y within 8-bit range (0x00–0xFF),
  // not within 16-bit range.
  const bus = makeBus();
  const cpu = new CPU(bus);
  cpu.P.E = 0;
  cpu.P.M = 0;
  cpu.P.X = 1; // 8-bit index registers

  // --- MVN with X=Y=0xFF: must wrap to 0x00 ---
  cpu.PC = 0x8400;
  cpu.PB = 0x00;
  cpu.A = 0x0000; // move 1 byte
  cpu.X = 0x00FF;
  cpu.Y = 0x00FF;
  bus.write(0x8400, 0x54); // MVN
  bus.write(0x8401, 0x00); // dest bank
  bus.write(0x8402, 0x00); // src bank
  bus.write(0x00FF, 0xE5); // source byte

  const used = cpu.step();
  assert(used === 7, `MVN 8-bit index expected 7 cycles, got ${used}`);
  assert(bus.read(0x00FF) === 0xE5, `MVN 8-bit: dst[0xFF] must have source value`);
  assert(cpu.X === 0x00, `MVN 8-bit: X must wrap to 0x00 from 0xFF, got 0x${cpu.X.toString(16)}`);
  assert(cpu.Y === 0x00, `MVN 8-bit: Y must wrap to 0x00 from 0xFF, got 0x${cpu.Y.toString(16)}`);
  assert(cpu.PC === 0x8403, `MVN 8-bit: PC must advance after last byte, got 0x${cpu.PC.toString(16)}`);

  // --- MVP with X=Y=0x00: must wrap to 0xFF ---
  cpu.PC = 0x8500;
  cpu.A = 0x0000;
  cpu.X = 0x0000;
  cpu.Y = 0x0000;
  bus.write(0x8500, 0x44); // MVP
  bus.write(0x8501, 0x00);
  bus.write(0x8502, 0x00);
  bus.write(0x0000, 0xD3); // source byte

  cpu.step();
  assert(cpu.X === 0xFF, `MVP 8-bit: X must wrap to 0xFF from 0x00, got 0x${cpu.X.toString(16)}`);
  assert(cpu.Y === 0xFF, `MVP 8-bit: Y must wrap to 0xFF from 0x00, got 0x${cpu.Y.toString(16)}`);
  // High byte must remain 0x00 in 8-bit index mode
  assert((cpu.X & 0xFF00) === 0, `MVP 8-bit: X high byte must stay 0x00`);
  assert((cpu.Y & 0xFF00) === 0, `MVP 8-bit: Y high byte must stay 0x00`);
}

function testStepReturnCycleAccountingAroundWaiInterrupt() {
  const bus = makeBus();
  const cpu = new CPU(bus);

  cpu.P.E = 1;
  cpu.P.M = 1;
  cpu.P.X = 1;
  cpu.P.I = 0;
  cpu.PB = 0x00;
  cpu.PC = 0x8000;

  // WAI at $8000, ISR vector to $1234 containing NOP.
  bus.write(0x8000, 0xCB);
  bus.write(0xFFFA, 0x34);
  bus.write(0xFFFB, 0x12);
  bus.write(0x1234, 0xEA);

  let before = cpu.cycles;
  let used = cpu.step();
  let delta = cpu.cycles - before;
  assert(used === delta, `WAI execute step returned ${used} but advanced ${delta} cycles`);
  assert(cpu.waiting === true, `WAI execute step must enter waiting state`);

  before = cpu.cycles;
  used = cpu.step();
  delta = cpu.cycles - before;
  assert(used === delta, `WAI idle step returned ${used} but advanced ${delta} cycles`);
  assert(cpu.waiting === true, `WAI idle step must remain waiting`);

  cpu.nmiPending = true;
  before = cpu.cycles;
  used = cpu.step();
  delta = cpu.cycles - before;
  assert(used === delta, `WAI wake step returned ${used} but advanced ${delta} cycles`);
  assert(cpu.waiting === false, `WAI wake step must leave waiting state`);
}

function testStepReturnCycleAccountingInStoppedState() {
  const bus = makeBus();
  const cpu = new CPU(bus);

  cpu.P.E = 1;
  cpu.PB = 0x00;
  cpu.PC = 0x8000;
  bus.write(0x8000, 0xDB); // STP

  let before = cpu.cycles;
  let used = cpu.step();
  let delta = cpu.cycles - before;
  assert(used === delta, `STP execute step returned ${used} but advanced ${delta} cycles`);
  assert(cpu.stopped === true, `STP execute step must set stopped state`);

  before = cpu.cycles;
  used = cpu.step();
  delta = cpu.cycles - before;
  assert(used === delta, `STP stopped step returned ${used} but advanced ${delta} cycles`);
  assert(used === 1, `STP stopped step expected 1 cycle, got ${used}`);
}

testNopAndWdmCycles();
testBranchCycles();
testFlowAndInterruptCycles();
testHardwareInterruptMethodCycles();
testLoadStoreIndexedCycles();
testLoadStoreGeneralCycles();
testTrbTsbCycles();
testAluGeneralCycles();
testCompareAndBitCycles();
testRmwMemoryCycles();
testSimpleInstructionCycles();
testControlAndTransferCycles();
testAbsXIndirectPointerProgramBank();
testStackAndPushPullCycles();
testBlockMoveCyclesAndSemantics();
testBlockMoveBoundaryWraps();
testBlockMoveWith8bitIndex();
testStepReturnCycleAccountingAroundWaiInterrupt();
testStepReturnCycleAccountingInStoppedState();

console.log('PASS: CPU cycle checks');
