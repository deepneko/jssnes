import { CPU } from './src/CPU.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeBus() {
  const mem = new Uint8Array(0x1000000);
  return {
    mem,
    read(addr) {
      return mem[addr & 0xFFFFFF];
    },
    write(addr, val) {
      mem[addr & 0xFFFFFF] = val & 0xFF;
    },
  };
}

function makeCpu(bus) {
  const cpu = new CPU(bus);
  cpu.P.E = 0;
  cpu.P.M = 0;
  cpu.P.X = 0;
  cpu.PB = 0x00;
  cpu.DB = 0x00;
  cpu.PC = 0x8000;
  cpu.SP = 0x01FF;
  return cpu;
}

function testDecimal16Arithmetic() {
  const bus = makeBus();
  const cpu = makeCpu(bus);

  cpu.P.D = 1;
  cpu.P.C = 1;
  cpu.A = 0x0001;
  cpu.sbc(0x2003);
  assert(cpu.A === 0x7998, 'SBC 16-bit decimal result mismatch');
  assert(cpu.P.C === 0, 'SBC 16-bit decimal carry mismatch');

  cpu.P.D = 1;
  cpu.P.C = 0;
  cpu.A = 0x4999;
  cpu.adc(0x5001);
  assert(cpu.A === 0x0000, 'ADC 16-bit decimal result mismatch');
  assert(cpu.P.C === 1, 'ADC 16-bit decimal carry mismatch');
}

function testDirectPageWrapOldVsNew() {
  const bus = makeBus();
  const cpu = makeCpu(bus);

  cpu.P.E = 1;
  cpu.P.M = 1;
  cpu.P.X = 1;
  cpu.DP = 0x0000;
  cpu.DB = 0x00;

  // LDA dp (old addressing): in emulation + DL=0, offset 0xFF wraps within page.
  cpu.PC = 0x8000;
  bus.write(0x008000, 0xFF);
  bus.write(0x0000FF, 0x42);
  bus.write(0x000100, 0x99);
  cpu.execute(0xA5, cpu.PC, cpu.PB);
  assert((cpu.A & 0xFF) === 0x42, 'Old direct addressing must wrap at page boundary');

  // LDA [dp] (new addressing): must NOT use emulation direct-page wrap.
  cpu.PC = 0x8001;
  bus.write(0x008001, 0xFF);
  bus.write(0x0000FF, 0x78);
  bus.write(0x000100, 0x56);
  bus.write(0x000101, 0x34);
  bus.write(0x345678, 0x5A);
  cpu.execute(0xA7, cpu.PC, cpu.PB);
  assert((cpu.A & 0xFF) === 0x5A, 'New [dp] addressing must not wrap direct page in emulation');
}

function testWdmConsumesImmediate() {
  const bus = makeBus();
  const cpu = makeCpu(bus);
  cpu.PC = 0x9000;
  bus.write(0x009000, 0xAB);
  cpu.execute(0x42, cpu.PC, cpu.PB);
  assert(cpu.PC === 0x9001, 'WDM must consume one immediate byte');
}

function testXceXbaAndStackPushes() {
  // --- XCE: native → emulation ---
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.E = 0; // native
    cpu.P.C = 1; // carry set → will become emulation flag
    cpu.SP = 0x01A0;
    cpu.PC = 0x8000;
    bus.write(0x008000, 0xFB); // XCE
    const cycles = cpu.step();
    assert(cycles === 2, `XCE expected 2 cycles, got ${cycles}`);
    assert(cpu.P.E === 1, 'XCE: E must become 1 (carry was 1)');
    assert(cpu.P.C === 0, 'XCE: C must become old E (was 0)');
    assert(cpu.P.M === 1, 'XCE: emulation mode forces M=1');
    assert(cpu.P.X === 1, 'XCE: emulation mode forces X=1');
    assert((cpu.SP & 0xFF00) === 0x0100, 'XCE: emulation mode fixes SP high byte to 0x01');
  }

  // --- XCE: emulation → native ---
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.E = 1; // emulation
    cpu.P.M = 1; cpu.P.X = 1;
    cpu.SP = 0x01A0;
    cpu.P.C = 0; // carry clear → will become native
    cpu.PC = 0x8000;
    bus.write(0x008000, 0xFB); // XCE
    cpu.step();
    assert(cpu.P.E === 0, 'XCE: E must become 0 (carry was 0)');
    assert(cpu.P.C === 1, 'XCE: C must become old E (was 1)');
    // M and X remain 1 after switch until explicitly changed with REP
  }

  // --- XBA: swaps B and A bytes; N/Z reflect new low byte ---
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.A = 0x1234; // B=0x12, A=0x34
    cpu.PC = 0x8000;
    bus.write(0x008000, 0xEB); // XBA
    const cycles = cpu.step();
    assert(cycles === 3, `XBA expected 3 cycles, got ${cycles}`);
    assert(cpu.A === 0x3412, `XBA: expected 0x3412, got 0x${cpu.A.toString(16)}`);
    // New low byte is 0x12 (old high); N=0, Z=0
    assert(cpu.P.N === 0, 'XBA: N should reflect new low byte 0x12');
    assert(cpu.P.Z === 0, 'XBA: Z should be 0 for 0x12');
    // Swap with zero HIGH byte: new low byte becomes 0x00 → Z=1
    cpu.A = 0x0055; // high=0x00, low=0x55 → after XBA: high=0x55, low=0x00
    cpu.PC = 0x8000;
    cpu.step(); // XBA
    assert(cpu.A === 0x5500, `XBA: expected 0x5500, got 0x${cpu.A.toString(16)}`);
    assert(cpu.P.Z === 1, 'XBA: Z must be 1 when new low byte is 0x00');
  }

  // --- PEA: pushes 16-bit immediate onto stack ---
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.E = 0; cpu.SP = 0x01FF;
    cpu.PC = 0x8000;
    bus.write(0x008000, 0xF4); // PEA
    bus.write(0x008001, 0xCD); // lo
    bus.write(0x008002, 0xAB); // hi  → push 0xABCD
    const cycles = cpu.step();
    assert(cycles === 5, `PEA expected 5 cycles, got ${cycles}`);
    assert(cpu.SP === 0x01FD, `PEA: SP should be 0x01FD, got 0x${cpu.SP.toString(16)}`);
    // pushWord pushes hi first then lo; SP+2=0x01FF has hi byte, SP+1=0x01FE has lo byte
    const peaVal = (bus.read(cpu.SP + 2) << 8) | bus.read(cpu.SP + 1);
    assert(peaVal === 0xABCD, `PEA: expected 0xABCD on stack, got 0x${peaVal.toString(16)}`);
  }

  // --- PEI: pushes 16-bit value from [DP+d] ---
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.E = 0; cpu.SP = 0x01FF; cpu.DP = 0x0000;
    cpu.PC = 0x8000;
    bus.write(0x000010, 0x34); // DP+0x10 lo
    bus.write(0x000011, 0x12); // DP+0x10 hi  → push 0x1234
    bus.write(0x008000, 0xD4); // PEI
    bus.write(0x008001, 0x10); // d
    const cycles = cpu.step();
    assert(cycles === 6, `PEI expected 6 cycles, got ${cycles}`);
    assert(cpu.SP === 0x01FD, `PEI: SP should be 0x01FD, got 0x${cpu.SP.toString(16)}`);
    const peiVal = (bus.read(cpu.SP + 2) << 8) | bus.read(cpu.SP + 1);
    assert(peiVal === 0x1234, `PEI: expected 0x1234 on stack, got 0x${peiVal.toString(16)}`);
  }

  // --- PER: pushes (PC_after_instr + signed_offset) ---
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.E = 0; cpu.SP = 0x01FF;
    cpu.PC = 0x8000;
    bus.write(0x008000, 0x62); // PER
    bus.write(0x008001, 0x0A); // offset lo = +10
    bus.write(0x008002, 0x00); // offset hi
    // PC after fetch = 0x8003; target = 0x8003 + 10 = 0x800D
    const cycles = cpu.step();
    assert(cycles === 6, `PER expected 6 cycles, got ${cycles}`);
    assert(cpu.SP === 0x01FD, `PER: SP should be 0x01FD, got 0x${cpu.SP.toString(16)}`);
    const perVal = (bus.read(cpu.SP + 2) << 8) | bus.read(cpu.SP + 1);
    assert(perVal === 0x800D, `PER: expected 0x800D on stack, got 0x${perVal.toString(16)}`);
    // Negative offset: -3 (0xFFFD)
    cpu.SP = 0x01FF;
    cpu.PC = 0x8000;
    bus.write(0x008001, 0xFD); bus.write(0x008002, 0xFF); // -3
    // PC after = 0x8003; target = 0x8003 + (-3) = 0x8000
    cpu.step();
    const perVal2 = (bus.read(cpu.SP + 2) << 8) | bus.read(cpu.SP + 1);
    assert(perVal2 === 0x8000, `PER negative: expected 0x8000 on stack, got 0x${perVal2.toString(16)}`);
  }
}

function testDecimalModeMatrix() {
  // 8-bit ADC decimal cases
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1;
    cpu.P.D = 1;

    const adcCases = [
      { a: 0x0009, b: 0x0001, c: 0, out: 0x0010, cout: 0 },
      { a: 0x0049, b: 0x0051, c: 0, out: 0x0000, cout: 1 },
      { a: 0x0099, b: 0x0000, c: 1, out: 0x0000, cout: 1 },
      { a: 0x0050, b: 0x0049, c: 1, out: 0x0000, cout: 1 },
    ];

    for (const tc of adcCases) {
      cpu.A = tc.a;
      cpu.P.C = tc.c;
      cpu.adc(tc.b);
      assert(cpu.A === tc.out, `ADC decimal 8-bit mismatch for A=${tc.a.toString(16)} B=${tc.b.toString(16)} C=${tc.c}`);
      assert(cpu.P.C === tc.cout, `ADC decimal 8-bit carry mismatch for A=${tc.a.toString(16)} B=${tc.b.toString(16)} C=${tc.c}`);
    }
  }

  // 8-bit SBC decimal cases
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1;
    cpu.P.D = 1;

    const sbcCases = [
      // Correct BCD results: lo-nibble borrow → subtract 6 from lo; hi-nibble borrow → subtract 6 from hi
      { a: 0x0010, b: 0x0001, c: 1, out: 0x0009, cout: 1 }, // 10-01 = 09 BCD
      { a: 0x0000, b: 0x0001, c: 1, out: 0x0099, cout: 0 }, // 00-01 = 99 BCD with borrow
      { a: 0x0050, b: 0x0049, c: 1, out: 0x0001, cout: 1 }, // 50-49 = 01 BCD
      { a: 0x0000, b: 0x0000, c: 0, out: 0x0099, cout: 0 }, // 00-00-borrow = 99 BCD
    ];

    for (const tc of sbcCases) {
      cpu.A = tc.a;
      cpu.P.C = tc.c;
      cpu.sbc(tc.b);
      assert(cpu.A === tc.out, `SBC decimal 8-bit mismatch for A=${tc.a.toString(16)} B=${tc.b.toString(16)} C=${tc.c}`);
      assert(cpu.P.C === tc.cout, `SBC decimal 8-bit carry mismatch for A=${tc.a.toString(16)} B=${tc.b.toString(16)} C=${tc.c}`);
    }
  }

  // 16-bit ADC/SBC decimal boundaries
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 0;
    cpu.P.D = 1;

    const adcCases16 = [
      { a: 0x0009, b: 0x0001, c: 0, out: 0x0010, cout: 0 },
      { a: 0x4999, b: 0x5001, c: 0, out: 0x0000, cout: 1 },
      { a: 0x9999, b: 0x0000, c: 1, out: 0x0000, cout: 1 },
    ];

    for (const tc of adcCases16) {
      cpu.A = tc.a;
      cpu.P.C = tc.c;
      cpu.adc(tc.b);
      assert(cpu.A === tc.out, `ADC decimal 16-bit mismatch for A=${tc.a.toString(16)} B=${tc.b.toString(16)} C=${tc.c}`);
      assert(cpu.P.C === tc.cout, `ADC decimal 16-bit carry mismatch for A=${tc.a.toString(16)} B=${tc.b.toString(16)} C=${tc.c}`);
    }

    const sbcCases16 = [
      { a: 0x0010, b: 0x0001, c: 1, out: 0x0009, cout: 1 },
      { a: 0x0000, b: 0x0001, c: 1, out: 0x9999, cout: 0 },
      { a: 0x8000, b: 0x0001, c: 1, out: 0x7999, cout: 1 },
    ];

    for (const tc of sbcCases16) {
      cpu.A = tc.a;
      cpu.P.C = tc.c;
      cpu.sbc(tc.b);
      assert(cpu.A === tc.out, `SBC decimal 16-bit mismatch for A=${tc.a.toString(16)} B=${tc.b.toString(16)} C=${tc.c}`);
      assert(cpu.P.C === tc.cout, `SBC decimal 16-bit carry mismatch for A=${tc.a.toString(16)} B=${tc.b.toString(16)} C=${tc.c}`);
    }
  }
}

function testStackRelativeAddressing() {
  // LDA (d,S): reads from SP+d; result into A
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1; // 8-bit A
    cpu.SP = 0x01F0;
    // Place value at SP+0x08 = 0x01F8
    bus.mem[0x01F8] = 0x5C;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0xA3; // LDA d,S
    bus.mem[0x8001] = 0x08; // d
    const cycles = cpu.step();
    assert(cycles === 4, `LDA d,S 8-bit expected 4 cycles, got ${cycles}`);
    assert((cpu.A & 0xFF) === 0x5C, `LDA d,S: expected A=0x5C, got 0x${(cpu.A&0xFF).toString(16)}`);
  }

  // LDA (d,S),Y: pointer from SP+d, then DB:ptr+Y
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.DB = 0x00;
    cpu.SP = 0x01F0;
    cpu.Y = 0x0005;
    // Pointer at SP+0x04 = 0x01F4 → lo=0x00, hi=0x30 → addr 0x3000
    bus.mem[0x01F4] = 0x00; // lo
    bus.mem[0x01F5] = 0x30; // hi  → pointer = 0x3000
    // Value at 0x3000 + Y(5) = 0x3005
    bus.mem[0x3005] = 0xAB;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0xB3; // LDA (d,S),Y
    bus.mem[0x8001] = 0x04; // d
    const cycles = cpu.step();
    assert(cycles === 7, `LDA (d,S),Y 8-bit expected 7 cycles, got ${cycles}`);
    assert((cpu.A & 0xFF) === 0xAB, `LDA (d,S),Y: expected A=0xAB, got 0x${(cpu.A&0xFF).toString(16)}`);
  }

  // STA (d,S),Y: store A into computed address
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.DB = 0x00;
    cpu.SP = 0x0200;
    cpu.A = 0x00CC;
    cpu.Y = 0x0003;
    bus.mem[0x0202] = 0x00; bus.mem[0x0203] = 0x40; // pointer = 0x4000
    // Expected write to 0x4000+3 = 0x4003
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x93; // STA (d,S),Y
    bus.mem[0x8001] = 0x02;
    cpu.step();
    assert(bus.mem[0x4003] === 0xCC, `STA (d,S),Y: expected 0xCC at 0x4003, got 0x${bus.mem[0x4003].toString(16)}`);
  }
}

function testTrbTsb() {
  // TRB dp: mem[addr] &= ~A; Z = (A & mem[addr_before]) === 0
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1; // 8-bit
    cpu.A = 0x00F0; // mask = 0xF0
    cpu.DP = 0x0000;
    bus.mem[0x0010] = 0xFF; // value at DP+0x10
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x14; // TRB dp
    bus.mem[0x8001] = 0x10;
    const cycles = cpu.step();
    assert(cycles === 5, `TRB dp 8-bit expected 5 cycles, got ${cycles}`);
    assert(bus.mem[0x0010] === 0x0F, `TRB dp: expected 0x0F, got 0x${bus.mem[0x0010].toString(16)}`);
    assert(cpu.P.Z === 0, 'TRB dp: Z must be 0 because A & mem was non-zero');
  }
  {
    // TRB with Z=1: A and mem share no bits
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1;
    cpu.A = 0x00F0;
    cpu.DP = 0x0000;
    bus.mem[0x0020] = 0x0F; // no overlap with A(=0xF0)
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x14;
    bus.mem[0x8001] = 0x20;
    cpu.step();
    assert(bus.mem[0x0020] === 0x0F, 'TRB dp Z: mem unchanged (no overlap)');
    assert(cpu.P.Z === 1, 'TRB dp: Z must be 1 when A & mem == 0');
  }

  // TSB abs: mem[addr] |= A; Z = (A & mem[addr_before]) === 0
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1;
    cpu.A = 0x000F;
    bus.mem[0x5000] = 0xF0;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x0C; // TSB abs
    bus.mem[0x8001] = 0x00; bus.mem[0x8002] = 0x50; // addr 0x5000
    const cycles = cpu.step();
    assert(cycles === 6, `TSB abs 8-bit expected 6 cycles, got ${cycles}`);
    assert(bus.mem[0x5000] === 0xFF, `TSB abs: expected 0xFF, got 0x${bus.mem[0x5000].toString(16)}`);
    assert(cpu.P.Z === 1, 'TSB abs: Z must be 1 when A & mem_before == 0');
  }
  {
    // TSB where A and mem overlap: Z=0
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1;
    cpu.A = 0x001F;
    bus.mem[0x5000] = 0xF0;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x0C;
    bus.mem[0x8001] = 0x00; bus.mem[0x8002] = 0x50;
    cpu.step();
    assert(bus.mem[0x5000] === 0xFF, 'TSB: expected 0xFF after set');
    assert(cpu.P.Z === 0, 'TSB: Z must be 0 when A & mem_before != 0');
  }

  // TRB abs 16-bit: tests both bytes of a 16-bit memory value
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 0; // 16-bit
    cpu.A = 0xFF00;
    bus.mem[0x6000] = 0x55; bus.mem[0x6001] = 0xAA; // 16-bit value = 0xAA55
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x1C; // TRB abs
    bus.mem[0x8001] = 0x00; bus.mem[0x8002] = 0x60;
    const cycles = cpu.step();
    assert(cycles === 7, `TRB abs 16-bit expected 7 cycles, got ${cycles}`);
    // Result = 0xAA55 & ~0xFF00 = 0xAA55 & 0x00FF = 0x0055
    assert(bus.mem[0x6000] === 0x55, `TRB abs 16-bit: lo byte should be 0x55`);
    assert(bus.mem[0x6001] === 0x00, `TRB abs 16-bit: hi byte should be 0x00`);
    // Z = (A & old_mem) != 0 → (0xFF00 & 0xAA55) = 0xAA00 != 0 → Z=0
    assert(cpu.P.Z === 0, 'TRB abs 16-bit: Z must be 0 (A & mem_before != 0)');
  }
}

function testAdcSbcVFlag() {
  // ADC 8-bit overflow cases
  // V=1: positive + positive = negative (sign changed)
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.P.D = 0;
    cpu.A = 0x0050; cpu.P.C = 0;
    cpu.adc(0x50); // 0x50+0x50=0xA0 → both positive, result negative
    assert(cpu.P.V === 1, `ADC V: 0x50+0x50 expected V=1, got ${cpu.P.V}`);
    assert((cpu.A & 0xFF) === 0xA0, `ADC V: result should be 0xA0`);
    assert(cpu.P.C === 0, `ADC V: no carry`);
  }
  // V=1: negative + negative = positive
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.P.D = 0;
    cpu.A = 0x00C0; cpu.P.C = 0;
    cpu.adc(0xB0); // 0xC0+0xB0=0x70 (overflow: neg+neg=pos)
    assert(cpu.P.V === 1, `ADC V: 0xC0+0xB0 expected V=1, got ${cpu.P.V}`);
    assert((cpu.A & 0xFF) === 0x70, `ADC V: result should be 0x70`);
    assert(cpu.P.C === 1, `ADC V: carry must be set`);
  }
  // V=0: positive + negative (no overflow possible)
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.P.D = 0;
    cpu.A = 0x0050; cpu.P.C = 0;
    cpu.adc(0xD0); // 0x50+0xD0=0x20, carry=1; mixed sign → V=0
    assert(cpu.P.V === 0, `ADC V: 0x50+0xD0 expected V=0, got ${cpu.P.V}`);
  }

  // SBC 8-bit overflow: pos - neg = neg
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.P.D = 0;
    cpu.A = 0x0050; cpu.P.C = 1; // borrow=0
    cpu.sbc(0xB0); // 0x50-0xB0 = 0xA0 → positive minus negative gave negative → overflow
    assert(cpu.P.V === 1, `SBC V: 0x50-0xB0 expected V=1, got ${cpu.P.V}`);
    assert((cpu.A & 0xFF) === 0xA0, `SBC V: result should be 0xA0`);
    assert(cpu.P.C === 0, `SBC V: borrow should be set (C=0)`);
  }
  // SBC 8-bit overflow: neg - pos = pos
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.P.D = 0;
    cpu.A = 0x00D0; cpu.P.C = 1;
    cpu.sbc(0x70); // 0xD0-0x70 = 0x60 → negative minus positive gave positive → overflow
    assert(cpu.P.V === 1, `SBC V: 0xD0-0x70 expected V=1, got ${cpu.P.V}`);
    assert((cpu.A & 0xFF) === 0x60, `SBC V: result should be 0x60`);
  }
  // SBC 8-bit no overflow: same sign subtraction
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.P.D = 0;
    cpu.A = 0x0050; cpu.P.C = 1;
    cpu.sbc(0x30); // 0x50-0x30=0x20, no overflow
    assert(cpu.P.V === 0, `SBC V: 0x50-0x30 expected V=0, got ${cpu.P.V}`);
    assert((cpu.A & 0xFF) === 0x20, `SBC V: result should be 0x20`);
    assert(cpu.P.C === 1, `SBC V: no borrow`);
  }

  // ADC 16-bit overflow
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 0; cpu.P.D = 0;
    cpu.A = 0x4000; cpu.P.C = 0;
    cpu.adc(0x4000); // 0x4000+0x4000=0x8000 → pos+pos=neg → V=1
    assert(cpu.P.V === 1, `ADC V 16-bit: 0x4000+0x4000 expected V=1, got ${cpu.P.V}`);
    assert(cpu.A === 0x8000, `ADC V 16-bit: result should be 0x8000`);
  }
}

function testBranchConditions() {
  // All 7 conditional branch opcodes: verify taken vs not-taken and correct destination PC
  const cases = [
    { name: 'BPL', op: 0x10, flag: 'N', valTaken: 0, valNotTaken: 1 },
    { name: 'BMI', op: 0x30, flag: 'N', valTaken: 1, valNotTaken: 0 },
    { name: 'BVC', op: 0x50, flag: 'V', valTaken: 0, valNotTaken: 1 },
    { name: 'BVS', op: 0x70, flag: 'V', valTaken: 1, valNotTaken: 0 },
    { name: 'BCC', op: 0x90, flag: 'C', valTaken: 0, valNotTaken: 1 },
    { name: 'BCS', op: 0xB0, flag: 'C', valTaken: 1, valNotTaken: 0 },
    { name: 'BEQ', op: 0xF0, flag: 'Z', valTaken: 1, valNotTaken: 0 },
  ];

  for (const tc of cases) {
    // Taken: instruction at 0x8000, offset +0x10 → target 0x8012
    {
      const bus = makeBus();
      const cpu = makeCpu(bus);
      cpu.P[tc.flag] = tc.valTaken;
      cpu.PC = 0x8000;
      bus.mem[0x8000] = tc.op;
      bus.mem[0x8001] = 0x10;
      cpu.step();
      assert(cpu.PC === 0x8012, `${tc.name} taken: expected PC=0x8012, got 0x${cpu.PC.toString(16)}`);
    }
    // Not taken: PC should advance past opcode+operand = 0x8002
    {
      const bus = makeBus();
      const cpu = makeCpu(bus);
      cpu.P[tc.flag] = tc.valNotTaken;
      cpu.PC = 0x8000;
      bus.mem[0x8000] = tc.op;
      bus.mem[0x8001] = 0x10;
      cpu.step();
      assert(cpu.PC === 0x8002, `${tc.name} not taken: expected PC=0x8002, got 0x${cpu.PC.toString(16)}`);
    }
  }

  // Backward branch: BEQ at 0x8010 with offset 0xF0 (-16) → target 0x8002
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.Z = 1;
    cpu.PC = 0x8010;
    bus.mem[0x8010] = 0xF0; // BEQ
    bus.mem[0x8011] = 0xF0; // signed -16
    cpu.step();
    assert(cpu.PC === 0x8002, `BEQ backward: expected PC=0x8002, got 0x${cpu.PC.toString(16)}`);
  }

  // BNE backward (negative, cross-page into previous page: 0x8100 → 0x8000 area)
  // At 0x8100, offset=0x7E (+126): target = 0x8102 + 126 = 0x8180
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.Z = 0; // BNE taken
    cpu.PC = 0x8100;
    bus.mem[0x8100] = 0xD0; // BNE
    bus.mem[0x8101] = 0x7E; // +126
    cpu.step();
    assert(cpu.PC === 0x8180, `BNE forward large: expected PC=0x8180, got 0x${cpu.PC.toString(16)}`);
  }
}

function testDpIndirectLongAddressing() {
  // LDA [dp]  (0xA7) – reads 24-bit pointer from DP+d, loads from that 24-bit address
  // Bank crossing: pointer → bank 1
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1; // 8-bit accumulator
    cpu.DP = 0x0000;
    cpu.PC = 0x8000;
    // Opcode + operand at 0x8000
    bus.mem[0x8000] = 0xA7; // LDA [dp]
    bus.mem[0x8001] = 0x10; // dp offset = 0x10 → pointer at DP+0x10 = 0x0010
    // 24-bit pointer stored at 0x0010..0x0012
    bus.mem[0x0010] = 0x00; // lo
    bus.mem[0x0011] = 0x30; // hi → addr = 0x013000
    bus.mem[0x0012] = 0x01; // bank
    // Value at 24-bit address 0x013000
    bus.mem[0x013000] = 0x42;
    cpu.step();
    assert((cpu.A & 0xFF) === 0x42, `LDA [dp]: expected A=0x42, got 0x${(cpu.A & 0xFF).toString(16)}`);
    assert(cpu.PC === 0x8002, `LDA [dp]: expected PC=0x8002, got 0x${cpu.PC.toString(16)}`);
  }

  // LDA [dp],Y (0xB7) – same pointer + Y added to 24-bit address
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.P.X = 1; // 8-bit acc and index
    cpu.DP = 0x0000;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0xB7; // LDA [dp],Y
    bus.mem[0x8001] = 0x10; // dp offset = 0x10
    // 24-bit pointer at 0x0010: 0x013000
    bus.mem[0x0010] = 0x00;
    bus.mem[0x0011] = 0x30;
    bus.mem[0x0012] = 0x01;
    cpu.Y = 0x05; // Y = 5
    // Value at 0x013000 + 5 = 0x013005
    bus.mem[0x013005] = 0x77;
    cpu.step();
    assert((cpu.A & 0xFF) === 0x77, `LDA [dp],Y: expected A=0x77, got 0x${(cpu.A & 0xFF).toString(16)}`);
  }

  // LDA [dp],Y with 16-bit Y that advances into next bank (Y spans across bank boundary)
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.P.X = 0; // 8-bit acc, 16-bit Y
    cpu.DP = 0x0000;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0xB7; // LDA [dp],Y
    bus.mem[0x8001] = 0x20; // dp offset = 0x20
    // 24-bit pointer at 0x0020: 0x01FFFC
    bus.mem[0x0020] = 0xFC;
    bus.mem[0x0021] = 0xFF;
    bus.mem[0x0022] = 0x01;
    cpu.Y = 0x0004; // 0x01FFFC + 4 = 0x020000 (wraps into bank 2)
    bus.mem[0x020000] = 0x55;
    cpu.step();
    assert((cpu.A & 0xFF) === 0x55, `LDA [dp],Y bank wrap: expected A=0x55, got 0x${(cpu.A & 0xFF).toString(16)}`);
  }

  // LDA [dp] in 16-bit accumulator mode
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 0; // 16-bit accumulator
    cpu.DP = 0x0000;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0xA7; // LDA [dp]
    bus.mem[0x8001] = 0x10;
    bus.mem[0x0010] = 0x00;
    bus.mem[0x0011] = 0x50;
    bus.mem[0x0012] = 0x02; // pointer = 0x025000
    bus.mem[0x025000] = 0xAB;
    bus.mem[0x025001] = 0xCD;
    cpu.step();
    assert(cpu.A === 0xCDAB, `LDA [dp] 16-bit: expected A=0xCDAB, got 0x${cpu.A.toString(16)}`);
  }
}

function testCompareFlags() {
  // CMP #imm (0xC9) 8-bit: equal, greater (unsigned), less (unsigned)
  const runCmp = (a, imm) => {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1; // 8-bit
    cpu.A = a;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0xC9; // CMP #imm
    bus.mem[0x8001] = imm;
    cpu.step();
    return { C: cpu.P.C, Z: cpu.P.Z, N: cpu.P.N };
  };
  // Equal: A=B → C=1, Z=1, N=0
  let f = runCmp(0x42, 0x42);
  assert(f.C === 1 && f.Z === 1 && f.N === 0, `CMP equal: expected C=1 Z=1 N=0, got C=${f.C} Z=${f.Z} N=${f.N}`);
  // Greater unsigned: A=0x80 > 0x01 → C=1, Z=0, N=0 (0x80-0x01=0x7F, bit7=0)
  f = runCmp(0x80, 0x01);
  assert(f.C === 1 && f.Z === 0 && f.N === 0, `CMP greater: expected C=1 Z=0 N=0, got C=${f.C} Z=${f.Z} N=${f.N}`);
  // Less unsigned: A=0x01 < 0x80 → C=0, Z=0, N=1 (0x01-0x80=0x81, bit7=1)
  f = runCmp(0x01, 0x80);
  assert(f.C === 0 && f.Z === 0 && f.N === 1, `CMP less: expected C=0 Z=0 N=1, got C=${f.C} Z=${f.Z} N=${f.N}`);

  // CPX #imm (0xE0) 8-bit
  const runCpx = (x, imm) => {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.X = 1; // 8-bit
    cpu.X = x;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0xE0; // CPX #imm
    bus.mem[0x8001] = imm;
    cpu.step();
    return { C: cpu.P.C, Z: cpu.P.Z };
  };
  let fx = runCpx(0x10, 0x10);
  assert(fx.C === 1 && fx.Z === 1, `CPX equal: expected C=1 Z=1, got C=${fx.C} Z=${fx.Z}`);
  fx = runCpx(0x20, 0x10);
  assert(fx.C === 1 && fx.Z === 0, `CPX greater: expected C=1 Z=0, got C=${fx.C} Z=${fx.Z}`);
  fx = runCpx(0x05, 0x10);
  assert(fx.C === 0 && fx.Z === 0, `CPX less: expected C=0 Z=0, got C=${fx.C} Z=${fx.Z}`);

  // CPY #imm (0xC0) 8-bit
  const runCpy = (y, imm) => {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.X = 1; // 8-bit
    cpu.Y = y;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0xC0; // CPY #imm
    bus.mem[0x8001] = imm;
    cpu.step();
    return { C: cpu.P.C, Z: cpu.P.Z };
  };
  let fy = runCpy(0xFF, 0xFF);
  assert(fy.C === 1 && fy.Z === 1, `CPY equal 0xFF: expected C=1 Z=1, got C=${fy.C} Z=${fy.Z}`);
  fy = runCpy(0x00, 0x01);
  assert(fy.C === 0 && fy.Z === 0, `CPY less: expected C=0 Z=0, got C=${fy.C} Z=${fy.Z}`);

  // CMP 16-bit (0xC9 with M=0)
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 0; // 16-bit
    cpu.A = 0x1234;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0xC9;
    bus.mem[0x8001] = 0x34;
    bus.mem[0x8002] = 0x12; // imm = 0x1234
    cpu.step();
    assert(cpu.P.C === 1 && cpu.P.Z === 1, `CMP 16-bit equal: expected C=1 Z=1, got C=${cpu.P.C} Z=${cpu.P.Z}`);
  }
}

function testShiftRotate() {
  // ASL A (0x0A): 8-bit, old bit7→C, new bit0=0
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1; // 8-bit
    cpu.A = 0x85; // 0b10000101
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x0A; // ASL A
    cpu.step();
    assert((cpu.A & 0xFF) === 0x0A, `ASL A: expected 0x0A, got 0x${(cpu.A & 0xFF).toString(16)}`);
    assert(cpu.P.C === 1, `ASL A: expected C=1`);
    assert(cpu.P.N === 0, `ASL A: expected N=0`);
    assert(cpu.P.Z === 0, `ASL A: expected Z=0`);
  }
  // ASL A: result = 0 sets Z
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1;
    cpu.A = 0x80; // 0b10000000
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x0A;
    cpu.step();
    assert((cpu.A & 0xFF) === 0x00, `ASL A zero: expected 0x00`);
    assert(cpu.P.C === 1 && cpu.P.Z === 1, `ASL A zero: expected C=1 Z=1`);
  }

  // LSR A (0x4A): 8-bit, old bit0→C, new bit7=0
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1;
    cpu.A = 0x85; // 0b10000101
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x4A; // LSR A
    cpu.step();
    assert((cpu.A & 0xFF) === 0x42, `LSR A: expected 0x42, got 0x${(cpu.A & 0xFF).toString(16)}`);
    assert(cpu.P.C === 1, `LSR A: expected C=1`);
    assert(cpu.P.N === 0, `LSR A: N always 0 after LSR`);
  }

  // ROL A (0x2A): 8-bit rotate left through carry
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1;
    cpu.A = 0x40; // 0b01000000
    cpu.P.C = 1;  // old carry → bit0
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x2A; // ROL A
    cpu.step();
    // 0x40 << 1 | C(1) = 0x81; old bit7=0 → new C=0
    assert((cpu.A & 0xFF) === 0x81, `ROL A: expected 0x81, got 0x${(cpu.A & 0xFF).toString(16)}`);
    assert(cpu.P.C === 0, `ROL A: expected C=0 (old bit7 was 0)`);
    assert(cpu.P.N === 1, `ROL A: expected N=1 (bit7 set)`);
  }
  // ROL A: C=0 → shifts in 0
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1;
    cpu.A = 0x81; // 0b10000001
    cpu.P.C = 0;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x2A;
    cpu.step();
    // 0x81 << 1 | 0 = 0x02; old bit7=1 → new C=1
    assert((cpu.A & 0xFF) === 0x02, `ROL A C=0: expected 0x02, got 0x${(cpu.A & 0xFF).toString(16)}`);
    assert(cpu.P.C === 1, `ROL A C=0: expected new C=1`);
  }

  // ROR A (0x6A): 8-bit rotate right through carry
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1;
    cpu.A = 0x81; // 0b10000001
    cpu.P.C = 0;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x6A; // ROR A
    cpu.step();
    // C(0) → bit7; old bit0=1 → new C=1; result = 0x40
    assert((cpu.A & 0xFF) === 0x40, `ROR A: expected 0x40, got 0x${(cpu.A & 0xFF).toString(16)}`);
    assert(cpu.P.C === 1, `ROR A: expected new C=1`);
    assert(cpu.P.N === 0, `ROR A: expected N=0`);
  }
  // ROR A: carry=1 rotated in at bit7
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 1;
    cpu.A = 0x00;
    cpu.P.C = 1;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x6A;
    cpu.step();
    // C(1) → bit7; old bit0=0 → new C=0; result = 0x80
    assert((cpu.A & 0xFF) === 0x80, `ROR A C=1: expected 0x80, got 0x${(cpu.A & 0xFF).toString(16)}`);
    assert(cpu.P.C === 0, `ROR A C=1: expected new C=0`);
    assert(cpu.P.N === 1, `ROR A C=1: expected N=1`);
  }

  // ASL 16-bit (0x0A with M=0)
  {
    const bus = makeBus();
    const cpu = makeCpu(bus);
    cpu.P.M = 0; // 16-bit
    cpu.A = 0x8001;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x0A; // ASL A
    cpu.step();
    assert(cpu.A === 0x0002, `ASL 16-bit: expected 0x0002, got 0x${cpu.A.toString(16)}`);
    assert(cpu.P.C === 1, `ASL 16-bit: expected C=1`);
  }
}

function testBitInstruction() {
  // BIT #imm (0x89): Z = (A & imm) == 0; N and V must NOT be modified
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.A = 0x55;
    cpu.P.N = 1; cpu.P.V = 1; // pre-set to verify they are NOT cleared
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x89; bus.mem[0x8001] = 0xAA; // 0x55 & 0xAA = 0 → Z=1
    cpu.step();
    assert(cpu.P.Z === 1, `BIT #imm: Z must be 1 when A&imm=0`);
    assert(cpu.P.N === 1, `BIT #imm: N must NOT be affected (was 1)`);
    assert(cpu.P.V === 1, `BIT #imm: V must NOT be affected (was 1)`);
  }
  // BIT #imm non-zero: Z=0, N/V still untouched
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.A = 0xFF;
    cpu.P.N = 0; cpu.P.V = 0;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x89; bus.mem[0x8001] = 0x01; // 0xFF & 0x01 = 1 → Z=0
    cpu.step();
    assert(cpu.P.Z === 0, `BIT #imm non-zero: Z must be 0`);
    assert(cpu.P.N === 0, `BIT #imm non-zero: N unchanged`);
    assert(cpu.P.V === 0, `BIT #imm non-zero: V unchanged`);
  }

  // BIT dp (0x24): Z from A&mem, N from mem bit7, V from mem bit6
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.A = 0xFF; cpu.DP = 0x0000;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x24; bus.mem[0x8001] = 0x10; // dp offset = 0x10
    bus.mem[0x0010] = 0xC0; // 0b11000000 → N=1, V=1; A&0xC0=0xC0 → Z=0
    cpu.step();
    assert(cpu.P.Z === 0, `BIT dp: Z must be 0 (A&mem != 0)`);
    assert(cpu.P.N === 1, `BIT dp: N must be mem bit7=1`);
    assert(cpu.P.V === 1, `BIT dp: V must be mem bit6=1`);
  }
  // BIT dp: all-zero result → Z=1
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.A = 0x00; cpu.DP = 0x0000;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x24; bus.mem[0x8001] = 0x20;
    bus.mem[0x0020] = 0xFF; // N=1, V=1; A=0 & 0xFF = 0 → Z=1
    cpu.step();
    assert(cpu.P.Z === 1, `BIT dp zero: Z must be 1`);
    assert(cpu.P.N === 1, `BIT dp zero: N from mem bit7`);
    assert(cpu.P.V === 1, `BIT dp zero: V from mem bit6`);
  }

  // BIT abs (0x2C): N/V from mem bits
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.A = 0x01; cpu.DB = 0x00;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x2C; bus.mem[0x8001] = 0x00; bus.mem[0x8002] = 0x02; // abs = 0x0200
    bus.mem[0x0200] = 0xFE; // 0b11111110; N=1, V=1; 0x01 & 0xFE = 0 → Z=1
    cpu.step();
    assert(cpu.P.Z === 1, `BIT abs: Z=1 (A&mem=0)`);
    assert(cpu.P.N === 1, `BIT abs: N=1 (mem bit7)`);
    assert(cpu.P.V === 1, `BIT abs: V=1 (mem bit6)`);
  }

  // BIT abs 16-bit (M=0): N from mem bit15, V from mem bit14
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.P.M = 0; cpu.A = 0x0001; cpu.DB = 0x00;
    cpu.PC = 0x8000;
    bus.mem[0x8000] = 0x2C; bus.mem[0x8001] = 0x00; bus.mem[0x8002] = 0x02; // abs = 0x0200
    bus.mem[0x0200] = 0xFE; bus.mem[0x0201] = 0xFF; // 16-bit = 0xFFFE; N=1, V=1; 0x0001 & 0xFFFE = 0 → Z=1
    cpu.step();
    assert(cpu.P.Z === 1, `BIT abs 16-bit: Z=1`);
    assert(cpu.P.N === 1, `BIT abs 16-bit: N from bit15`);
    assert(cpu.P.V === 1, `BIT abs 16-bit: V from bit14`);
  }
}

function testTransferInstructions() {
  let cpu;

  // TAX 8-bit: P.X=1, low byte of A → X
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.P.X = 1; cpu.A = 0x0042;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0xAA; // TAX
    cpu.step();
    assert((cpu.X & 0xFF) === 0x42, `TAX 8-bit: X=${cpu.X.toString(16)}`);
    assert(cpu.P.N === 0 && cpu.P.Z === 0, `TAX 8-bit: N=0 Z=0`);
  }
  // TAX 16-bit: P.X=0, full A (C) → X
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.P.M = 0; cpu.P.X = 0; cpu.A = 0x1234;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0xAA;
    cpu.step();
    assert(cpu.X === 0x1234, `TAX 16-bit: X=${cpu.X.toString(16)}`);
  }
  // TAX with M=1 X=0: transfers B:A (16-bit C) to X even though A is 8-bit mode
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.P.X = 0; cpu.A = 0xAB34; // B=0xAB, A=0x34
    cpu.PC = 0x8000; bus.mem[0x8000] = 0xAA;
    cpu.step();
    assert(cpu.X === 0xAB34, `TAX M=1 X=0: must transfer full 16-bit C. X=${cpu.X.toString(16)}`);
  }

  // TAY 8-bit
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.P.X = 1; cpu.A = 0xFF;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0xA8; // TAY
    cpu.step();
    assert((cpu.Y & 0xFF) === 0xFF, `TAY 8-bit: Y=${cpu.Y.toString(16)}`);
    assert(cpu.P.N === 1, `TAY 8-bit: N=1 (0xFF)`);
  }

  // TXA 16-bit A, 8-bit X: zero-extends X into A
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.P.M = 0; cpu.P.X = 1; cpu.X = 0x42;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x8A; // TXA
    cpu.step();
    assert(cpu.A === 0x0042, `TXA M=0 X=1: A=${cpu.A.toString(16)}`);
    assert(cpu.P.N === 0 && cpu.P.Z === 0, `TXA: N=0 Z=0`);
  }
  // TXA 8-bit A, 8-bit X: transfers only low byte
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.P.X = 1; cpu.X = 0x80;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x8A;
    cpu.step();
    assert((cpu.A & 0xFF) === 0x80, `TXA M=1: A low=${(cpu.A & 0xFF).toString(16)}`);
    assert(cpu.P.N === 1, `TXA M=1 X=0x80: N=1`);
  }

  // TYA: Y → A (8-bit)
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.P.X = 1; cpu.Y = 0x00;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x98; // TYA
    cpu.step();
    assert((cpu.A & 0xFF) === 0x00 && cpu.P.Z === 1, `TYA zero: Z=1`);
  }

  // TXY and TYX 8-bit
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.P.X = 1; cpu.X = 0x77;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x9B; // TXY
    cpu.step();
    assert((cpu.Y & 0xFF) === 0x77, `TXY 8-bit: Y=${(cpu.Y & 0xFF).toString(16)}`);
  }
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.P.X = 1; cpu.Y = 0x88;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0xBB; // TYX
    cpu.step();
    assert((cpu.X & 0xFF) === 0x88, `TYX 8-bit: X=${(cpu.X & 0xFF).toString(16)}`);
    assert(cpu.P.N === 1, `TYX: N=1 (0x88)`);
  }

  // TCD: A (16-bit C) → DP; always 16-bit
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.A = 0x1234;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x5B; // TCD
    cpu.step();
    assert(cpu.DP === 0x1234, `TCD: DP=${cpu.DP.toString(16)}`);
    assert(cpu.P.N === 0 && cpu.P.Z === 0, `TCD: N=0 Z=0`);
  }
  // TDC: DP → A; N flag reflects bit 15
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.DP = 0x8000;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x7B; // TDC
    cpu.step();
    assert(cpu.A === 0x8000, `TDC: A=${cpu.A.toString(16)}`);
    assert(cpu.P.N === 1, `TDC: N=1 (bit15 of 0x8000)`);
  }

  // TCS: A → SP (no flags affected)
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.A = 0x01FE;
    cpu.P.N = 1; // should stay unchanged
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x1B; // TCS
    cpu.step();
    assert(cpu.SP === 0x01FE, `TCS: SP=${cpu.SP.toString(16)}`);
    assert(cpu.P.N === 1, `TCS: N must not change`);
  }
  // TSC: SP → A; N/Z set
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.SP = 0x01FF;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x3B; // TSC
    cpu.step();
    assert(cpu.A === 0x01FF, `TSC: A=${cpu.A.toString(16)}`);
    assert(cpu.P.N === 0 && cpu.P.Z === 0, `TSC: N=0 Z=0`);
  }

  // TXS: X → SP
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.P.X = 0; cpu.X = 0x01F0;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x9A; // TXS
    cpu.step();
    assert(cpu.SP === 0x01F0, `TXS: SP=${cpu.SP.toString(16)}`);
  }
  // TSX: SP → X
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.P.X = 0; cpu.SP = 0x01AB;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0xBA; // TSX
    cpu.step();
    assert(cpu.X === 0x01AB, `TSX 16-bit: X=${cpu.X.toString(16)}`);
  }
  // TSX 8-bit: X gets low byte of SP
  {
    const bus = makeBus(); cpu = makeCpu(bus);
    cpu.P.X = 1; cpu.SP = 0x01EF;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0xBA;
    cpu.step();
    assert((cpu.X & 0xFF) === 0xEF, `TSX 8-bit: X low=${(cpu.X & 0xFF).toString(16)}`);
    assert(cpu.P.N === 1, `TSX 8-bit: N=1 (0xEF)`);
  }
}

function testBankRegisterStack() {
  // PHD (0x0B): push DP as 16-bit; PLD (0x2B): pop 16-bit into DP + set N/Z
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.DP = 0x1234;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x0B; // PHD
    const spBefore = cpu.SP;
    cpu.step();
    assert(cpu.SP === (spBefore - 2) & 0xFFFF, `PHD: SP not decremented by 2`);
    // Store pointer to popped value
    const spAfter = cpu.SP;

    // PLD roundtrip
    cpu.DP = 0x0000; cpu.P.N = 0; cpu.P.Z = 1;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x2B; // PLD
    cpu.step();
    assert(cpu.DP === 0x1234, `PLD: DP=${cpu.DP.toString(16)}`);
    assert(cpu.P.Z === 0 && cpu.P.N === 0, `PLD: N=0 Z=0 for 0x1234`);
    assert(cpu.SP === spBefore, `PLD: SP restored`);
  }
  // PLD sets N for value with bit15 set
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.DP = 0x8000;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x0B; cpu.step(); // PHD
    cpu.DP = 0; cpu.PC = 0x8000; bus.mem[0x8000] = 0x2B; cpu.step(); // PLD
    assert(cpu.P.N === 1, `PLD: N=1 for DP=0x8000`);
  }

  // PHB (0x8B): push DB byte; PLB (0xAB): pop byte into DB + set N/Z
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.DB = 0x03;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x8B; // PHB
    const spBefore = cpu.SP;
    cpu.step();
    assert(cpu.SP === (spBefore - 1) & 0xFFFF, `PHB: SP not decremented by 1`);

    cpu.DB = 0x00;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0xAB; // PLB
    cpu.step();
    assert(cpu.DB === 0x03, `PLB: DB=${cpu.DB.toString(16)}`);
    assert(cpu.P.N === 0 && cpu.P.Z === 0, `PLB: N=0 Z=0`);
    assert(cpu.SP === spBefore, `PLB: SP restored`);
  }
  // PLB N flag: bank 0x80 → N=1
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.DB = 0x80;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x8B; cpu.step(); // PHB
    cpu.DB = 0; cpu.PC = 0x8000; bus.mem[0x8000] = 0xAB; cpu.step(); // PLB
    assert(cpu.P.N === 1, `PLB: N=1 for DB=0x80`);
  }

  // PHK (0x4B): push PB (program bank) as byte — no corresponding PLK
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.PB = 0x05;
    cpu.PC = 0x8000;
    bus.mem[0x058000] = 0x4B; // PHK — opcode must be in bank 5 since PB=0x05
    const spBefore = cpu.SP;
    cpu.step();
    const pushed = bus.mem[spBefore & 0xFFFFFF];
    assert(pushed === 0x05, `PHK: pushed 0x${pushed.toString(16)}, expected 0x05`);
    assert(cpu.SP === ((spBefore - 1) & 0xFFFF), `PHK: SP decremented`);
  }
}

function testLogicOps() {
  // ORA #imm (0x09) 8-bit: N flag
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.A = 0x0A;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x09; bus.mem[0x8001] = 0xF0;
    cpu.step();
    assert((cpu.A & 0xFF) === 0xFA, `ORA: A=${(cpu.A & 0xFF).toString(16)}`);
    assert(cpu.P.N === 1 && cpu.P.Z === 0, `ORA: N=1 Z=0`);
  }
  // ORA #imm 8-bit: result = 0 → Z=1
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.A = 0x00;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x09; bus.mem[0x8001] = 0x00;
    cpu.step();
    assert((cpu.A & 0xFF) === 0x00 && cpu.P.Z === 1, `ORA zero: Z=1`);
  }
  // ORA #imm 16-bit
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.P.M = 0; cpu.A = 0x1234;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x09; bus.mem[0x8001] = 0x00; bus.mem[0x8002] = 0x80;
    cpu.step();
    assert(cpu.A === 0x9234, `ORA 16-bit: A=${cpu.A.toString(16)}`);
    assert(cpu.P.N === 1, `ORA 16-bit: N=1`);
  }

  // AND #imm (0x29) 8-bit: mask out high nibble
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.A = 0xFF;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x29; bus.mem[0x8001] = 0x0F;
    cpu.step();
    assert((cpu.A & 0xFF) === 0x0F, `AND: A=${(cpu.A & 0xFF).toString(16)}`);
    assert(cpu.P.N === 0 && cpu.P.Z === 0, `AND: N=0 Z=0`);
  }
  // AND #imm 8-bit: no bits in common → Z=1
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.A = 0xAA;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x29; bus.mem[0x8001] = 0x55;
    cpu.step();
    assert((cpu.A & 0xFF) === 0x00 && cpu.P.Z === 1, `AND zero: Z=1`);
  }
  // AND #imm 16-bit
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.P.M = 0; cpu.A = 0xFFFF;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x29; bus.mem[0x8001] = 0x00; bus.mem[0x8002] = 0x80;
    cpu.step();
    assert(cpu.A === 0x8000 && cpu.P.N === 1, `AND 16-bit: A=${cpu.A.toString(16)}`);
  }

  // EOR #imm (0x49) 8-bit: XOR same value → Z=1
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.A = 0xFF;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x49; bus.mem[0x8001] = 0xFF;
    cpu.step();
    assert((cpu.A & 0xFF) === 0x00 && cpu.P.Z === 1, `EOR same: Z=1`);
  }
  // EOR #imm 8-bit: N set
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.P.M = 1; cpu.A = 0x00;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x49; bus.mem[0x8001] = 0x80;
    cpu.step();
    assert((cpu.A & 0xFF) === 0x80 && cpu.P.N === 1, `EOR N: N=1`);
  }
  // EOR #imm 16-bit roundtrip: A XOR mask XOR mask = A
  {
    const bus = makeBus(); const cpu = makeCpu(bus);
    cpu.P.M = 0; cpu.A = 0x5A5A;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x49; bus.mem[0x8001] = 0xFF; bus.mem[0x8002] = 0xFF;
    cpu.step();
    const tmp = cpu.A;
    cpu.PC = 0x8000; bus.mem[0x8000] = 0x49; bus.mem[0x8001] = 0xFF; bus.mem[0x8002] = 0xFF;
    cpu.step();
    assert(cpu.A === 0x5A5A, `EOR 16-bit roundtrip: A=${cpu.A.toString(16)}`);
    assert(tmp === 0xA5A5, `EOR 16-bit first: A=${tmp.toString(16)}`);
  }
}

testDecimal16Arithmetic();
testDecimalModeMatrix();
testDirectPageWrapOldVsNew();
testWdmConsumesImmediate();
testXceXbaAndStackPushes();
testStackRelativeAddressing();
testTrbTsb();
testAdcSbcVFlag();
testBranchConditions();
testDpIndirectLongAddressing();
testCompareFlags();
testShiftRotate();
testBitInstruction();
testTransferInstructions();
testBankRegisterStack();
testLogicOps();

console.log('PASS: CPU accuracy checks');