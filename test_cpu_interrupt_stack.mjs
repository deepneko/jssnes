import { CPU } from './src/CPU.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

function setupEmuCpu(bus) {
  const cpu = new CPU(bus);
  cpu.P.E = 1;
  cpu.P.M = 1;
  cpu.P.X = 1;
  cpu.P.I = 0;
  cpu.P.N = 1;
  cpu.P.V = 1;
  cpu.P.D = 1;
  cpu.P.Z = 1;
  cpu.P.C = 1;
  cpu.SP = 0x01FF;
  cpu.PC = 0xABCD;
  cpu.PB = 0x00;
  return cpu;
}

function testHardwareInterruptPush(kind) {
  const bus = makeBus();
  const cpu = setupEmuCpu(bus);
  const vector = 0x1234;

  if (kind === 'irq') {
    bus.mem[0xFFFE] = vector & 0xFF;
    bus.mem[0xFFFF] = (vector >> 8) & 0xFF;
    cpu.irq();
  } else {
    bus.mem[0xFFFA] = vector & 0xFF;
    bus.mem[0xFFFB] = (vector >> 8) & 0xFF;
    cpu.nmi();
  }

  const pushedStatus = bus.mem[0x01FD];
  assert(cpu.PC === vector, `${kind}: vector not loaded`);
  assert(cpu.SP === 0x01FC, `${kind}: stack pointer not decremented correctly`);
  assert((pushedStatus & 0x10) === 0, `${kind}: B flag must be clear for hardware interrupts`);
  assert((pushedStatus & 0x20) === 0x20, `${kind}: bit 5 must remain set`);
}

function testPhpSetsBreakFlag() {
  const bus = makeBus();
  const cpu = setupEmuCpu(bus);
  cpu.execute(0x08, cpu.PC, cpu.PB);

  const pushedStatus = bus.mem[0x01FF];
  assert((pushedStatus & 0x10) === 0x10, 'PHP: B flag must be set');
  assert((pushedStatus & 0x20) === 0x20, 'PHP: bit 5 must remain set');
}

function testRepCannotClearMxInEmulationMode() {
  const bus = makeBus();
  const cpu = setupEmuCpu(bus);
  cpu.PC = 0x8000;
  bus.mem[0x8000] = 0x30;

  cpu.execute(0xC2, cpu.PC, cpu.PB);

  assert(cpu.P.M === 1, 'REP in emulation mode must not clear M');
  assert(cpu.P.X === 1, 'REP in emulation mode must not clear X');
}

function testBrkCopStackBits() {
  const brkBus = makeBus();
  const brkCpu = setupEmuCpu(brkBus);
  brkCpu.PC = 0x8001;
  brkBus.mem[0x8001] = 0x7A;
  brkBus.mem[0xFFFE] = 0x34;
  brkBus.mem[0xFFFF] = 0x12;
  brkCpu.execute(0x00, brkCpu.PC, brkCpu.PB);
  const brkStatus = brkBus.mem[0x01FD];
  assert((brkStatus & 0x10) === 0x10, 'BRK must set B when pushing status');
  assert(brkCpu.PC === 0x1234, 'BRK must jump to the BRK vector');

  const copBus = makeBus();
  const copCpu = setupEmuCpu(copBus);
  copCpu.PC = 0x8001;
  copBus.mem[0x8001] = 0x7A;
  copBus.mem[0xFFF4] = 0x78;
  copBus.mem[0xFFF5] = 0x56;
  copCpu.execute(0x02, copCpu.PC, copCpu.PB);
  const copStatus = copBus.mem[0x01FD];
  assert((copStatus & 0x10) === 0x00, 'COP must keep B clear when pushing status');
  assert(copCpu.PC === 0x5678, 'COP must jump to the COP vector');
}

function setupNativeCpu(bus) {
  const cpu = new CPU(bus);
  cpu.P.E = 0;
  cpu.P.M = 0;
  cpu.P.X = 0;
  cpu.P.I = 0;
  cpu.P.N = 1;
  cpu.P.V = 0;
  cpu.P.D = 1;
  cpu.P.Z = 0;
  cpu.P.C = 1;
  cpu.SP = 0x1FF0;
  cpu.PC = 0xABCD;
  cpu.PB = 0x3A;
  return cpu;
}

function testInterruptAndSoftwareStackFramesExact() {
  // IRQ (emu): PCH, PCL, P(with D cleared, B clear)
  {
    const bus = makeBus();
    const cpu = setupEmuCpu(bus);
    cpu.PC = 0x2468;
    bus.mem[0xFFFE] = 0x34;
    bus.mem[0xFFFF] = 0x12;
    cpu.irq();
    assert(bus.mem[0x01FF] === 0x24, 'IRQ emu must push PCH first');
    assert(bus.mem[0x01FE] === 0x68, 'IRQ emu must push PCL second');
    assert(bus.mem[0x01FD] === 0xE3, 'IRQ emu must push status byte with D=0 and B=0');
    assert(cpu.SP === 0x01FC, 'IRQ emu must decrement SP by 3');
  }

  // NMI (native): PB, PCH, PCL, P(with D cleared)
  {
    const bus = makeBus();
    const cpu = setupNativeCpu(bus);
    cpu.PC = 0x1357;
    cpu.PB = 0x9C;
    bus.mem[0xFFEA] = 0x78;
    bus.mem[0xFFEB] = 0x56;
    cpu.nmi();
    assert(bus.mem[0x1FF0] === 0x9C, 'NMI native must push PB first');
    assert(bus.mem[0x1FEF] === 0x13, 'NMI native must push PCH second');
    assert(bus.mem[0x1FEE] === 0x57, 'NMI native must push PCL third');
    assert(bus.mem[0x1FED] === 0x81, 'NMI native must push status byte with D=0');
    assert(cpu.SP === 0x1FEC, 'NMI native must decrement SP by 4');
  }

  // BRK (emu): pushes PC after signature fetch and sets B in pushed status
  {
    const bus = makeBus();
    const cpu = setupEmuCpu(bus);
    cpu.PC = 0x9001;
    bus.mem[0x9001] = 0x42;
    bus.mem[0xFFFE] = 0x34;
    bus.mem[0xFFFF] = 0x12;
    cpu.execute(0x00, cpu.PC, cpu.PB);
    assert(bus.mem[0x01FF] === 0x90, 'BRK emu must push PCH');
    assert(bus.mem[0x01FE] === 0x02, 'BRK emu must push PCL after signature fetch');
    assert(bus.mem[0x01FD] === 0xFB, 'BRK emu must push status with B=1 and bit5=1');
    assert(cpu.SP === 0x01FC, 'BRK emu must decrement SP by 3');
  }

  // COP (native): pushes PB/PCH/PCL/P with B clear
  {
    const bus = makeBus();
    const cpu = setupNativeCpu(bus);
    cpu.PC = 0x9001;
    cpu.PB = 0x11;
    bus.mem[0x9001] = 0x77;
    bus.mem[0xFFE4] = 0xAD;
    bus.mem[0xFFE5] = 0xDE;
    cpu.execute(0x02, cpu.PC, cpu.PB);
    assert(bus.mem[0x1FF0] === 0x11, 'COP native must push PB first');
    assert(bus.mem[0x1FEF] === 0x90, 'COP native must push PCH second');
    assert(bus.mem[0x1FEE] === 0x02, 'COP native must push PCL after signature fetch');
    assert(bus.mem[0x1FED] === 0x89, 'COP native must push status with D still set before clear');
    assert(cpu.SP === 0x1FEC, 'COP native must decrement SP by 4');
  }
}

function testRepSepNativeWidthSwitch() {
  const bus = makeBus();
  // Start native mode with 8-bit A and X
  const cpu = new CPU(bus);
  cpu.P.E = 0; cpu.P.M = 1; cpu.P.X = 1;
  cpu.A = 0x0055; // B byte = 0x00
  cpu.X = 0x0077;
  cpu.Y = 0x0099;
  cpu.SP = 0x01FF;

  // REP #$30 — clear M and X, widening A and X/Y to 16-bit
  cpu.PC = 0x8000;
  bus.mem[0x8000] = 0xC2; // REP
  bus.mem[0x8001] = 0x30; // bits: M=0x20, X=0x10
  const repCycles = cpu.step();
  assert(repCycles === 3, `REP expected 3 cycles, got ${repCycles}`);
  assert(cpu.P.M === 0, 'REP #$30 must clear M');
  assert(cpu.P.X === 0, 'REP #$30 must clear X');
  // After X widens, high bytes of X/Y were forced to 0 by earlier 8-bit mode
  // The 16-bit X/Y are now valid 16-bit (high byte was 0x00)
  assert(cpu.X === 0x0077, `REP: X should still be 0x0077 (high was 0x00)`);
  assert(cpu.Y === 0x0099, `REP: Y should still be 0x0099 (high was 0x00)`);
  // 16-bit A: B byte preserved
  assert((cpu.A & 0xFF) === 0x55, 'REP: A low byte should be 0x55');

  // SEP #$30 — set M and X, returning to 8-bit; X/Y high bytes forced to 0x00
  cpu.PC = 0x8000;
  cpu.X = 0x1234; cpu.Y = 0x5678; // give them non-zero highs
  bus.mem[0x8000] = 0xE2; // SEP
  bus.mem[0x8001] = 0x30;
  const sepCycles = cpu.step();
  assert(sepCycles === 3, `SEP expected 3 cycles, got ${sepCycles}`);
  assert(cpu.P.M === 1, 'SEP #$30 must set M');
  assert(cpu.P.X === 1, 'SEP #$30 must set X');
  // When X=1 is set, X/Y high bytes must be zeroed
  assert(cpu.X === 0x0034, `SEP: X high byte must be cleared → 0x0034, got 0x${cpu.X.toString(16)}`);
  assert(cpu.Y === 0x0078, `SEP: Y high byte must be cleared → 0x0078, got 0x${cpu.Y.toString(16)}`);

  // REP #$08 — clear D (decimal flag)
  cpu.PC = 0x8000;
  cpu.P.D = 1;
  bus.mem[0x8000] = 0xC2; // REP
  bus.mem[0x8001] = 0x08;
  cpu.step();
  assert(cpu.P.D === 0, 'REP #$08 must clear D flag');

  // SEP #$01 — set C (carry)
  cpu.PC = 0x8000;
  cpu.P.C = 0;
  bus.mem[0x8000] = 0xE2; bus.mem[0x8001] = 0x01;
  cpu.step();
  assert(cpu.P.C === 1, 'SEP #$01 must set C flag');
}

function testPhpPlpRoundtrip() {
  // native mode: PHP then PLP must restore all flags identically
  {
    const bus = makeBus();
    const cpu = new CPU(bus);
    cpu.P.E = 0;
    cpu.P.M = 1; cpu.P.X = 1;
    cpu.P.N = 1; cpu.P.V = 1; cpu.P.D = 1;
    cpu.P.I = 1; cpu.P.Z = 0; cpu.P.C = 0;
    cpu.SP = 0x01FF;

    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x08; // PHP
    const originalSP = cpu.SP;
    cpu.step();

    // Trash flags
    cpu.P.N = 0; cpu.P.V = 0; cpu.P.D = 0; cpu.P.I = 0; cpu.P.Z = 1; cpu.P.C = 1;

    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x28; // PLP
    cpu.step();

    assert(cpu.P.N === 1, 'PLP roundtrip: N must be restored');
    assert(cpu.P.V === 1, 'PLP roundtrip: V must be restored');
    assert(cpu.P.D === 1, 'PLP roundtrip: D must be restored');
    assert(cpu.P.I === 1, 'PLP roundtrip: I must be restored');
    assert(cpu.P.Z === 0, 'PLP roundtrip: Z must be restored');
    assert(cpu.P.C === 0, 'PLP roundtrip: C must be restored');
    assert(cpu.P.M === 1, 'PLP roundtrip: M must be restored');
    assert(cpu.SP === originalSP, `PLP roundtrip: SP must match original after PHP+PLP`);
  }

  // emulation mode: PHP/PLP roundtrip — M/X bits are not stored meaningfully but B is forced
  {
    const bus = makeBus();
    const cpu = new CPU(bus);
    cpu.P.E = 1; cpu.P.M = 1; cpu.P.X = 1;
    cpu.P.N = 0; cpu.P.V = 1; cpu.P.D = 0; cpu.P.I = 0; cpu.P.Z = 1; cpu.P.C = 1;
    cpu.SP = 0x01FF;

    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x08; // PHP
    cpu.step();

    cpu.P.N = 1; cpu.P.V = 0; cpu.P.Z = 0; cpu.P.C = 0;

    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x28; // PLP
    cpu.step();

    assert(cpu.P.N === 0, 'PLP emu: N must be restored');
    assert(cpu.P.V === 1, 'PLP emu: V must be restored');
    assert(cpu.P.Z === 1, 'PLP emu: Z must be restored');
    assert(cpu.P.C === 1, 'PLP emu: C must be restored');
  }
}

testHardwareInterruptPush('nmi');
testPhpSetsBreakFlag();
testRepCannotClearMxInEmulationMode();
testBrkCopStackBits();
testInterruptAndSoftwareStackFramesExact();
testRepSepNativeWidthSwitch();
testPhpPlpRoundtrip();

console.log('PASS: CPU interrupt/status stack checks');