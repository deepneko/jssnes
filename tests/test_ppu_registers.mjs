// test_ppu_registers.mjs — PPU register I/O tests
// Covers: VRAM increment, VRAM address translation, VRAM read buffer,
//         CGRAM two-byte write latch, scroll register double-write latch.
import { PPU } from '../src/PPU.js';

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

function makePPU() {
  return new PPU();
}

// ─── 1. VRAM address increment steps ──────────────────────────────────────────
function testVramAddressIncrement() {
  const steps = [1, 32, 128, 128];
  for (let vmain = 0; vmain <= 3; vmain++) {
    const ppu = makePPU();
    ppu.vmain = vmain;
    ppu.vramAddr = 0x0010;
    ppu.incVramAddr();
    assert(ppu.vramAddr === 0x0010 + steps[vmain],
      `vmain=${vmain}: expected ${0x10 + steps[vmain]}, got ${ppu.vramAddr}`);
  }

  // Wrap at 0x7FFF
  const ppu = makePPU();
  ppu.vmain = 0x00;
  ppu.vramAddr = 0x7FFF;
  ppu.incVramAddr();
  assert(ppu.vramAddr === 0, `vramAddr wrap: expected 0, got ${ppu.vramAddr}`);

  // Step-32 wrap
  const ppu2 = makePPU();
  ppu2.vmain = 0x01;
  ppu2.vramAddr = 0x7FE0; // 0x7FE0 + 32 = 0x8000 & 0x7FFF = 0
  ppu2.incVramAddr();
  assert(ppu2.vramAddr === 0, `vmain=1 wrap: expected 0, got ${ppu2.vramAddr}`);
}

// ─── 2. VRAM address translation (vmain bits 3-2) ─────────────────────────────
function testVramAddressTranslation() {
  // mapping 0: identity
  {
    const ppu = makePPU();
    ppu.vmain = 0x00; // bits 3-2 = 0b00
    ppu.vramAddr = 0x1234;
    assert(ppu.getVramTranslatedAddr() === 0x1234, 'mapping=0 identity');
  }

  // mapping 1 (vmain=0x04): (addr & 0xFF00) | ((addr & 0x00E0) >> 5) | ((addr & 0x001F) << 3)
  {
    const ppu = makePPU();
    ppu.vmain = 0x04;
    const addr = 0x007F;
    ppu.vramAddr = addr;
    const expected = (addr & 0xFF00) | ((addr & 0x00E0) >> 5) | ((addr & 0x001F) << 3);
    // = 0x0000 | (0x60>>5=3) | (0x1F<<3=0xF8) = 0xFB
    assert(ppu.getVramTranslatedAddr() === expected,
      `mapping=1 addr=0x7F: expected 0x${expected.toString(16)}, got 0x${ppu.getVramTranslatedAddr().toString(16)}`);
  }

  // mapping 1: high-byte region passes through
  {
    const ppu = makePPU();
    ppu.vmain = 0x04;
    const addr = 0x1200;
    ppu.vramAddr = addr;
    const expected = (addr & 0xFF00) | ((addr & 0x00E0) >> 5) | ((addr & 0x001F) << 3);
    assert(ppu.getVramTranslatedAddr() === expected,
      `mapping=1 addr=0x1200: expected ${expected}, got ${ppu.getVramTranslatedAddr()}`);
  }

  // mapping 2 (vmain=0x08): (addr & 0xFE00) | ((addr & 0x01C0) >> 6) | ((addr & 0x003F) << 3)
  {
    const ppu = makePPU();
    ppu.vmain = 0x08;
    const addr = 0x00FF;
    ppu.vramAddr = addr;
    const expected = (addr & 0xFE00) | ((addr & 0x01C0) >> 6) | ((addr & 0x003F) << 3);
    assert(ppu.getVramTranslatedAddr() === expected,
      `mapping=2 addr=0xFF: expected ${expected}, got ${ppu.getVramTranslatedAddr()}`);
  }

  // mapping 3 (vmain=0x0C): (addr & 0xFC00) | ((addr & 0x0380) >> 7) | ((addr & 0x007F) << 3)
  {
    const ppu = makePPU();
    ppu.vmain = 0x0C;
    const addr = 0x00FF;
    ppu.vramAddr = addr;
    const expected = (addr & 0xFC00) | ((addr & 0x0380) >> 7) | ((addr & 0x007F) << 3);
    assert(ppu.getVramTranslatedAddr() === expected,
      `mapping=3 addr=0xFF: expected ${expected}, got ${ppu.getVramTranslatedAddr()}`);
  }
}

// ─── 3. VRAM write + increment timing (vmain bit 7) ──────────────────────────
function testVramWriteIncrementTiming() {
  // vmain.bit7 = 0: increment on write to 0x2118 (VMDATAL)
  {
    const ppu = makePPU();
    ppu.vmain = 0x00; // bit7=0, step=1
    ppu.write(0x2117, 0x00); // VMADDH = 0 (sets vramAddr=0, prefetchVram)
    ppu.write(0x2116, 0x00); // VMADDL = 0
    assert(ppu.vramAddr === 0, 'before write addr=0');
    ppu.write(0x2118, 0xAB); // VMDATAL write → should increment after
    assert(ppu.vramAddr === 1, `after VMDATAL write, vramAddr should be 1, got ${ppu.vramAddr}`);
    assert(ppu.vram[0] === 0xAB, `vram[0] should be 0xAB, got ${ppu.vram[0]}`);
    ppu.write(0x2119, 0xCD); // VMDATAH write → no increment (bit7=0)
    assert(ppu.vramAddr === 1, `VMDATAH no increment when bit7=0, got ${ppu.vramAddr}`);
    assert(ppu.vram[3] === 0xCD, `vram[3] should be 0xCD, got ${ppu.vram[3]}`);
  }

  // vmain.bit7 = 1: increment on write to 0x2119 (VMDATAH)
  {
    const ppu = makePPU();
    ppu.vmain = 0x80; // bit7=1, step=1
    ppu.write(0x2117, 0x00);
    ppu.write(0x2116, 0x00);
    ppu.write(0x2118, 0xEF); // VMDATAL — no increment (bit7=1)
    assert(ppu.vramAddr === 0, `VMDATAL no increment when bit7=1, got ${ppu.vramAddr}`);
    ppu.write(0x2119, 0x12); // VMDATAH — increment after
    assert(ppu.vramAddr === 1, `after VMDATAH write, vramAddr should be 1, got ${ppu.vramAddr}`);
  }
}

// ─── 4. VRAM read buffer prefetch on VMADDH write ────────────────────────────
function testVramReadBuffer() {
  const ppu = makePPU();
  // Manually put data into VRAM at word address 5 → byte offsets 10 (lo) and 11 (hi)
  ppu.vram[10] = 0x34;
  ppu.vram[11] = 0x12;

  // Set VRAM address to 5; writing VMADDH triggers prefetchVram
  ppu.write(0x2116, 0x05); // VMADDL = 5 → vramAddr = 5 (no prefetch)
  ppu.write(0x2117, 0x00); // VMADDH = 0 → vramAddr = 5, prefetchVram called
  assert(ppu.vramReadBuffer === 0x1234,
    `vramReadBuffer should be 0x1234 after VMADDH write, got 0x${ppu.vramReadBuffer.toString(16)}`);

  // Read $2139 (lo byte) with vmain.bit7=0 → returns lo, then increments
  ppu.vmain = 0x00;
  const lo = ppu.read(0x2139);
  assert(lo === 0x34, `VMDATAL read should be 0x34, got 0x${lo.toString(16)}`);
  assert(ppu.vramAddr === 6, `after $2139 read, vramAddr should be 6, got ${ppu.vramAddr}`);

  // Put data at word addr 6
  ppu.vram[12] = 0x78; ppu.vram[13] = 0x56;
  // Read $213A (hi byte) with vmain.bit7=1 → returns hi, then increments
  ppu.vmain = 0x80;
  ppu.write(0x2116, 0x06); ppu.write(0x2117, 0x00); // reset addr to 6, prefetch 0x5678
  const hi = ppu.read(0x213A);
  assert(hi === 0x56, `VMDATAH read should be 0x56, got 0x${hi.toString(16)}`);
  assert(ppu.vramAddr === 7, `after $213A read, vramAddr should be 7, got ${ppu.vramAddr}`);
}

// ─── 5. CGRAM two-byte write latch ───────────────────────────────────────────
function testCgramWriteLatch() {
  const ppu = makePPU();

  // Set address to palette entry 5 (byte address 10)
  ppu.write(0x2121, 0x05); // CGADD = 5
  assert(ppu.cgadd === 5, 'cgadd after $2121 write');
  assert(ppu.cgdata_latch === null, 'latch reset after CGADD write');

  // First write: latched only, cgram unchanged
  ppu.write(0x2122, 0xAB);
  assert(ppu.cgdata_latch === 0xAB, 'latch holds first byte');
  assert(ppu.cgram[10] === 0, 'cgram not written on first byte');

  // Second write: commits both bytes, address increments
  ppu.write(0x2122, 0x1C);
  assert(ppu.cgram[10] === 0xAB, `cgram[10] should be 0xAB, got 0x${ppu.cgram[10].toString(16)}`);
  assert(ppu.cgram[11] === 0x1C, `cgram[11] should be 0x1C, got 0x${ppu.cgram[11].toString(16)}`);
  assert(ppu.cgadd === 6, `cgadd should auto-increment to 6, got ${ppu.cgadd}`);
  assert(ppu.cgdata_latch === null, 'latch cleared after second byte');

  // Single write (no pair) leaves cgram untouched
  ppu.write(0x2121, 0x00); // reset to palette 0
  ppu.write(0x2122, 0x55); // first byte only
  assert(ppu.cgram[0] === 0, 'cgram[0] unchanged after partial write');
  assert(ppu.cgdata_latch === 0x55, 'latch holds unpaired byte');

  // CGADD write resets the latch mid-pair
  ppu.write(0x2121, 0x00); // reset latch
  assert(ppu.cgdata_latch === null, 'latch reset by CGADD mid-pair');
}

// ─── 6. Scroll register double-write latch ────────────────────────────────────
function testScrollRegisterLatch() {
  // VOFS: first write → latch; second write → (second<<8 | first) = full 9-bit scroll
  {
    const ppu = makePPU();
    // bg_latch starts at 0
    ppu.write(0x210E, 0x34); // BG1VOFS write 1: bg1vofs = (0x34<<8)|0 = 0x3400; latch=0x34
    ppu.write(0x210E, 0x02); // BG1VOFS write 2: bg1vofs = (0x02<<8)|0x34 = 0x0234; latch=0x02
    assert(ppu.bg1vofs === 0x0234,
      `bg1vofs two-write: expected 0x0234, got 0x${ppu.bg1vofs.toString(16)}`);
  }

  // Verify bg_latch is shared: a VOFS write affects subsequent BG2VOFS
  {
    const ppu = makePPU();
    ppu.write(0x210E, 0x10); // latch = 0x10
    ppu.write(0x2110, 0x03); // BG2VOFS: bg2vofs = (0x03<<8)|0x10 = 0x0310
    assert(ppu.bg2vofs === 0x0310,
      `bg2vofs uses shared latch: expected 0x0310, got 0x${ppu.bg2vofs.toString(16)}`);
  }

  // BG3 / BG4 VOFS
  {
    const ppu = makePPU();
    ppu.write(0x2112, 0xF0); // BG3VOFS write 1
    ppu.write(0x2112, 0x01); // BG3VOFS write 2
    assert(ppu.bg3vofs === 0x01F0,
      `bg3vofs: expected 0x01F0, got 0x${ppu.bg3vofs.toString(16)}`);

    ppu.write(0x2114, 0x00); // BG4VOFS write 1
    ppu.write(0x2114, 0x00); // BG4VOFS write 2
    assert(ppu.bg4vofs === 0x0000,
      `bg4vofs zero: got 0x${ppu.bg4vofs.toString(16)}`);
  }

  // HOFS formula: (value<<8 | latch&~7 | prev_hofs_hi&7)
  // Write hi then lo to produce a scroll value
  {
    const ppu = makePPU();
    // Set bg_latch by writing to BG1HOFS first (hi byte)
    ppu.write(0x210D, 0x01); // bg1hofs = (0x01<<8)|(0&0xF8)|(0>>8&7) = 0x100; latch=0x01
    // Second write (lo byte in sequence)
    ppu.write(0x210D, 0x00); // bg1hofs = (0<<8)|(0x01&0xF8)|(0x100>>8&7)
                               //         = 0 | 0x00 | (0x01&7) = 0 | 0 | 1 = 1
    assert(ppu.bg1hofs === 1,
      `bg1hofs: expected 1, got ${ppu.bg1hofs}`);
  }
}

// ─── 7. OAM address and auto-increment ────────────────────────────────────────
function testOamAddressWrite() {
  const ppu = makePPU();

  // Set address to OAM word 0x10
  ppu.write(0x2102, 0x10); // OAMADDL
  ppu.write(0x2103, 0x00); // OAMADDH (bit 0 only)
  assert(ppu.oamAddr === 0x10, `oamAddr after OAMADDL: expected 0x10, got ${ppu.oamAddr}`);

  // OAMADDH bit0 sets high bit of OAM address
  ppu.write(0x2103, 0x01);
  assert(ppu.oamAddr === 0x110, `oamAddr with OAMADDH=1: expected 0x110, got ${ppu.oamAddr}`);

  // Write to OAMDATA ($2104) — low area: write two bytes to advance address by 1
  ppu.write(0x2102, 0x00); // reset to word 0
  ppu.write(0x2103, 0x00);
  ppu.write(0x2104, 0xAA); // byte 0 of word 0 (latched)
  assert(ppu.oamFlip === 1, 'flip toggles after first OAMDATA write');
  ppu.write(0x2104, 0xBB); // byte 1 of word 0 → commits; oamAddr advances
  assert(ppu.oamAddr === 1, `oamAddr after word write: expected 1, got ${ppu.oamAddr}`);
  assert(ppu.oam[0] === 0xAA, `oam[0] = 0xAA, got ${ppu.oam[0]}`);
  assert(ppu.oam[1] === 0xBB, `oam[1] = 0xBB, got ${ppu.oam[1]}`);
}

// ─── run ──────────────────────────────────────────────────────────────────────
testVramAddressIncrement();
testVramAddressTranslation();
testVramWriteIncrementTiming();
testVramReadBuffer();
testCgramWriteLatch();
testScrollRegisterLatch();
testOamAddressWrite();

console.log('PASS: PPU register checks');
