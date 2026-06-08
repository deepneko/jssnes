import { CPU } from '../src/CPU.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function makeBus() {
  const mem = new Uint8Array(0x20000);
  return {
    mem,
    read(addr) {
      return mem[addr & 0x1FFFF];
    },
    write(addr, val) {
      mem[addr & 0x1FFFF] = val & 0xFF;
    },
  };
}

function makeCpu() {
  const bus = makeBus();
  const cpu = new CPU(bus);
  cpu.P.E = 0;
  cpu.P.M = 0;
  cpu.P.X = 0;
  cpu.P.I = 0;
  cpu.SP = 0x1FF0;
  cpu.PB = 0x02;
  cpu.PC = 0x4000;
  return { bus, cpu };
}

function testJsrRts() {
  const { bus, cpu } = makeCpu();
  cpu.PC = 0x4001;
  bus.write(0x024001, 0x34);
  bus.write(0x024002, 0x12);

  cpu.execute(0x20, 0x4001, cpu.PB);
  assert(cpu.PC === 0x1234, 'JSR must jump to target address');
  assert(cpu.SP === 0x1FEE, 'JSR must push a 16-bit return address');

  cpu.PB = 0x02;
  cpu.PC = 0x1234;
  cpu.execute(0x60, cpu.PC, cpu.PB);
  assert(cpu.PC === 0x4003, 'RTS must return to the instruction after JSR');
}

function testJslRtl() {
  const { bus, cpu } = makeCpu();
  cpu.PC = 0x4001;
  bus.write(0x024001, 0x78);
  bus.write(0x024002, 0x56);
  bus.write(0x024003, 0x09);

  cpu.execute(0x22, 0x4001, cpu.PB);
  assert(cpu.PC === 0x5678, 'JSL must jump to target address');
  assert(cpu.PB === 0x09, 'JSL must switch program bank');
  assert(cpu.SP === 0x1FED, 'JSL must push bank and return address');

  cpu.execute(0x6B, cpu.PC, cpu.PB);
  assert(cpu.PC === 0x4004, 'RTL must return to the instruction after JSL');
  assert(cpu.PB === 0x02, 'RTL must restore program bank');
}

function testRtiNative() {
  const { bus, cpu } = makeCpu();
  cpu.P.E = 0;
  cpu.SP = 0x1FF0;
  cpu.push(0x56);
  cpu.push(0x34);
  cpu.push(0x12);
  cpu.push(0x04);

  cpu.execute(0x40, cpu.PC, cpu.PB);
  assert(cpu.PC === 0x3412, 'RTI must restore PC from stack in native mode');
  assert(cpu.PB === 0x56, 'RTI must restore PB in native mode');
  assert(cpu.P.I === 1, 'RTI must restore status bits');
}

function testMixedFlowReturnSequence() {
  const { bus, cpu } = makeCpu();
  const initialSP = cpu.SP;

  // 00:4000 JSL 01:5000
  bus.write(0x004000, 0x22);
  bus.write(0x004001, 0x00);
  bus.write(0x004002, 0x50);
  bus.write(0x004003, 0x01);

  // 01:5000 JSR 6000
  bus.write(0x015000, 0x20);
  bus.write(0x015001, 0x00);
  bus.write(0x015002, 0x60);

  // 01:6000 RTS
  bus.write(0x016000, 0x60);

  // 01:5003 RTL
  bus.write(0x015003, 0x6B);

  cpu.PB = 0x00;
  cpu.PC = 0x4000;

  let used = cpu.step();
  assert(used === 8, 'JSL step must use 8 cycles');
  assert(cpu.PB === 0x01 && cpu.PC === 0x5000, 'JSL must transfer to 01:5000');

  used = cpu.step();
  assert(used === 6, 'JSR step must use 6 cycles');
  assert(cpu.PB === 0x01 && cpu.PC === 0x6000, 'JSR must transfer to 01:6000');

  used = cpu.step();
  assert(used === 6, 'RTS step must use 6 cycles');
  assert(cpu.PB === 0x01 && cpu.PC === 0x5003, 'RTS must return to 01:5003');

  used = cpu.step();
  assert(used === 6, 'RTL step must use 6 cycles');
  assert(cpu.PB === 0x00 && cpu.PC === 0x4004, 'RTL must return to 00:4004');
  assert(cpu.SP === initialSP, 'Mixed flow sequence must restore stack pointer');
}

function testEmuModeStackWrap() {
  // In emulation mode the stack is fixed to page 1 (0x0100–0x01FF).
  // Pushing past 0x0100 must wrap to 0x01FF, not escape into page 0.
  const bus = makeBus();
  const mem = bus.mem;
  const cpu = new CPU(bus);
  cpu.P.E = 1;
  cpu.P.M = 1;
  cpu.P.X = 1;
  cpu.SP = 0x0101; // two bytes of room before wrap

  // Push 3 bytes manually — third push wraps SP from 0x0100 to 0x01FF
  cpu.push(0xAA); // SP: 0x0101 → 0x0100; mem[0x0101] = 0xAA
  cpu.push(0xBB); // SP: 0x0100 → 0x01FF; mem[0x0100] = 0xBB
  cpu.push(0xCC); // SP: 0x01FF → 0x01FE; mem[0x01FF] = 0xCC

  assert(cpu.SP === 0x01FE, `Emu stack wrap: SP should be 0x01FE after 3 pushes from 0x0101, got 0x${cpu.SP.toString(16)}`);
  assert(mem[0x0101] === 0xAA, 'Emu stack wrap: mem[0x0101] should be 0xAA (first push)');
  assert(mem[0x0100] === 0xBB, 'Emu stack wrap: mem[0x0100] should be 0xBB (second push)');
  assert(mem[0x01FF] === 0xCC, 'Emu stack wrap: mem[0x01FF] should be 0xCC (third push, wrapped)');
  // SP must never escape page 1
  assert((cpu.SP & 0xFF00) === 0x0100, 'Emu stack: SP must always stay in page 1');

  // Pop back: verify correct round-trip
  const c = cpu.pop(); // 0xCC from 0x01FF; SP 0x01FE → 0x01FF
  const b = cpu.pop(); // 0xBB from 0x0100; SP 0x01FF → 0x0100
  const a = cpu.pop(); // 0xAA from 0x0101; SP 0x0100 → 0x0101
  assert(c === 0xCC && b === 0xBB && a === 0xAA, `Emu stack wrap pop: got ${c.toString(16)},${b.toString(16)},${a.toString(16)}`);
  assert(cpu.SP === 0x0101, `Emu stack wrap: SP must be restored to 0x0101, got 0x${cpu.SP.toString(16)}`);
}

function testRtiEmuMode() {
  // Emulation-mode RTI must NOT pop PB from stack
  const { bus, cpu } = makeCpu();
  cpu.P.E = 1;
  cpu.P.M = 1;
  cpu.P.X = 1;
  // SP must be in page 1 in emu mode
  cpu.SP = 0x01F0;

  // Interrupt pushes PCH, PCL, P (no PB in emu mode)
  cpu.push(0xAB); // PCH → 0x01F0
  cpu.push(0xCD); // PCL → 0x01EF
  cpu.push(0x45); // P   → 0x01EE  (N=0,V=1,M=1,X=0,D=0,I=1,Z=0,C=1)

  const savedPB = cpu.PB;
  cpu.execute(0x40, cpu.PC, cpu.PB); // RTI
  assert(cpu.PC === 0xABCD, `RTI emu: expected PC=0xABCD, got 0x${cpu.PC.toString(16)}`);
  assert(cpu.PB === savedPB, `RTI emu: PB must not change (no PB on stack), expected 0x${savedPB.toString(16)}`);
  // 0x45 = 0b01000101 → V=1, D=0, I=1, C=1 (emu forces M=1 X=1)
  assert(cpu.P.V === 1 && cpu.P.I === 1 && cpu.P.C === 1 && cpu.P.D === 0,
    `RTI emu: P.V/I/C/D wrong after restoring 0x45`);
  assert(cpu.P.N === 0, `RTI emu: N should be 0`);
}

function testJmpIndirectJml() {
  // JMP (abs) 0x6C: reads 16-bit ptr from abs addr, jumps to target in same bank
  {
    const { bus, cpu } = makeCpu(); // PB=0x02, PC=0x4000
    // Operand at PB:PC (0x024000): indirect pointer address = 0x0200
    bus.write(0x024000, 0x00); // ptr lo
    bus.write(0x024001, 0x02); // ptr hi → ptr = 0x0200
    // Indirect target at 0x0200–0x0201 = 0x5678
    bus.write(0x0200, 0x78);
    bus.write(0x0201, 0x56);
    cpu.execute(0x6C, 0x4000, cpu.PB);
    assert(cpu.PC === 0x5678, `JMP(abs): expected PC=0x5678, got 0x${cpu.PC.toString(16)}`);
    assert(cpu.PB === 0x02, `JMP(abs): PB must not change`);
  }

  // JML [abs] 0xDC: reads 3-byte pointer from abs addr in bank 0, changes PC and PB
  {
    const { bus, cpu } = makeCpu(); // PB=0x02, PC=0x4000
    // Operand at 0x024000: ptr = 0x0300
    bus.write(0x024000, 0x00); // ptr lo
    bus.write(0x024001, 0x03); // ptr hi → ptr = 0x0300
    // 24-bit target at 0x0300–0x0302
    bus.write(0x0300, 0x78); // lo
    bus.write(0x0301, 0x56); // hi
    bus.write(0x0302, 0x07); // bank → target = 0x07:0x5678
    cpu.execute(0xDC, 0x4000, cpu.PB);
    assert(cpu.PC === 0x5678, `JML[abs]: expected PC=0x5678, got 0x${cpu.PC.toString(16)}`);
    assert(cpu.PB === 0x07, `JML[abs]: expected PB=0x07, got 0x${cpu.PB.toString(16)}`);
  }

  // JMP (abs,X) 0x7C: ptr = base + X (in current PB)
  {
    const { bus, cpu } = makeCpu(); // PB=0x02
    cpu.P.X = 1; cpu.X = 0x04;
    // Operand at 0x024000: base = 0x0300
    bus.write(0x024000, 0x00); // base lo
    bus.write(0x024001, 0x03); // base hi → base = 0x0300; ptr = 0x0300 + 4 = 0x0304
    // Target at 0x020304 (PB=0x02): target PC = 0x9ABC
    bus.write(0x020304, 0xBC);
    bus.write(0x020305, 0x9A);
    cpu.execute(0x7C, 0x4000, cpu.PB);
    assert(cpu.PC === 0x9ABC, `JMP(abs,X): expected PC=0x9ABC, got 0x${cpu.PC.toString(16)}`);
    assert(cpu.PB === 0x02, `JMP(abs,X): PB unchanged`);
  }
}

testJslRtl();
testRtiNative();
testRtiEmuMode();
testJmpIndirectJml();
testMixedFlowReturnSequence();
testEmuModeStackWrap();

console.log('PASS: CPU flow/stack checks');
