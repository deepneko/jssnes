// test_ppu_pixel.mjs — PPU pixel/colour tests
// Covers: getColor (BGR555→ABGR), getTilePixel (2bpp/4bpp/8bpp),
//         applyColorMath (add/sub/halve), applyBrightness (0–15 scaling).
import { PPU } from './src/PPU.js';

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

function makePPU() {
  return new PPU();
}

// Helper: write a BGR555 colour to CGRAM palette entry n
function setCgramColor(ppu, n, r5, g5, b5) {
  const val = r5 | (g5 << 5) | (b5 << 10);
  ppu.write(0x2121, n);
  ppu.write(0x2122, val & 0xFF);
  ppu.write(0x2122, (val >> 8) & 0xFF);
}

// ─── 1. getColor — BGR555 → ABGR conversion ──────────────────────────────────
function testGetColor() {
  // Expansion formula: ch8 = (ch5 << 3) | (ch5 >> 2)
  const expand = c => (c << 3) | (c >> 2);

  const ppu = makePPU();

  // Black (0,0,0)
  setCgramColor(ppu, 0, 0, 0, 0);
  assert((ppu.getColor(0) >>> 0) === 0xFF000000,
    `black: expected 0xFF000000, got 0x${(ppu.getColor(0)>>>0).toString(16).toUpperCase()}`);

  // White (31,31,31)
  setCgramColor(ppu, 1, 31, 31, 31);
  const white = ((0xFF << 24) | (expand(31) << 16) | (expand(31) << 8) | expand(31)) >>> 0;
  assert((ppu.getColor(1) >>> 0) === white,
    `white: expected 0x${white.toString(16)}, got 0x${(ppu.getColor(1)>>>0).toString(16)}`);

  // Pure red (31,0,0): ABGR = 0xFF_00_00_RR
  setCgramColor(ppu, 2, 31, 0, 0);
  const red = ((0xFF << 24) | (0 << 16) | (0 << 8) | expand(31)) >>> 0;
  assert((ppu.getColor(2) >>> 0) === red,
    `red: expected 0x${red.toString(16)}, got 0x${(ppu.getColor(2)>>>0).toString(16)}`);

  // Pure green (0,31,0): ABGR = 0xFF_00_GG_00
  setCgramColor(ppu, 3, 0, 31, 0);
  const green = ((0xFF << 24) | (0 << 16) | (expand(31) << 8) | 0) >>> 0;
  assert((ppu.getColor(3) >>> 0) === green,
    `green: expected 0x${green.toString(16)}, got 0x${(ppu.getColor(3)>>>0).toString(16)}`);

  // Pure blue (0,0,31): ABGR = 0xFF_BB_00_00
  setCgramColor(ppu, 4, 0, 0, 31);
  const blue = ((0xFF << 24) | (expand(31) << 16) | (0 << 8) | 0) >>> 0;
  assert((ppu.getColor(4) >>> 0) === blue,
    `blue: expected 0x${blue.toString(16)}, got 0x${(ppu.getColor(4)>>>0).toString(16)}`);

  // Mixed: r5=10 g5=20 b5=5
  setCgramColor(ppu, 5, 10, 20, 5);
  const mix = ((0xFF << 24) | (expand(5) << 16) | (expand(20) << 8) | expand(10)) >>> 0;
  assert((ppu.getColor(5) >>> 0) === mix,
    `mix: expected 0x${mix.toString(16)}, got 0x${(ppu.getColor(5)>>>0).toString(16)}`);
}

// ─── 2. getTilePixel — 2bpp ───────────────────────────────────────────────────
function testGetTilePixel2bpp() {
  const ppu = makePPU();

  // Tile 0 at charBase=0; 2bpp row 0 = vram[0] (plane0) + vram[1] (plane1)
  // All plane0 = 0xFF, plane1 = 0x00  → all pixels = 0b01 = 1
  ppu.vram[0] = 0xFF;
  ppu.vram[1] = 0x00;
  for (let x = 0; x < 8; x++) {
    assert(ppu.getTilePixel(0, x, 0, 2, 0) === 1,
      `2bpp p0=FF p1=00 x=${x}: expected 1`);
  }

  // plane0=0x00, plane1=0xFF → all pixels = 0b10 = 2
  ppu.vram[0] = 0x00;
  ppu.vram[1] = 0xFF;
  for (let x = 0; x < 8; x++) {
    assert(ppu.getTilePixel(0, x, 0, 2, 0) === 2,
      `2bpp p0=00 p1=FF x=${x}: expected 2`);
  }

  // plane0=0xFF, plane1=0xFF → all pixels = 0b11 = 3
  ppu.vram[0] = 0xFF;
  ppu.vram[1] = 0xFF;
  for (let x = 0; x < 8; x++) {
    assert(ppu.getTilePixel(0, x, 0, 2, 0) === 3,
      `2bpp p0=FF p1=FF x=${x}: expected 3`);
  }

  // plane0=0x00, plane1=0x00 → transparent (0)
  ppu.vram[0] = 0x00;
  ppu.vram[1] = 0x00;
  for (let x = 0; x < 8; x++) {
    assert(ppu.getTilePixel(0, x, 0, 2, 0) === 0,
      `2bpp all-zero x=${x}: expected 0`);
  }

  // Bit-level check: plane0=0b10110000, plane1=0x00
  // x=0 → bit7 of p0 = 1 → pixel 1
  // x=1 → bit6 of p0 = 0 → pixel 0
  // x=2 → bit5 of p0 = 1 → pixel 1
  // x=3 → bit4 of p0 = 1 → pixel 1
  ppu.vram[0] = 0b10110000;
  ppu.vram[1] = 0x00;
  assert(ppu.getTilePixel(0, 0, 0, 2, 0) === 1, '2bpp bit x=0');
  assert(ppu.getTilePixel(0, 1, 0, 2, 0) === 0, '2bpp bit x=1');
  assert(ppu.getTilePixel(0, 2, 0, 2, 0) === 1, '2bpp bit x=2');
  assert(ppu.getTilePixel(0, 3, 0, 2, 0) === 1, '2bpp bit x=3');
  assert(ppu.getTilePixel(0, 4, 0, 2, 0) === 0, '2bpp bit x=4');

  // Row 1 uses vram[2]+vram[3]
  ppu.vram[2] = 0xFF; ppu.vram[3] = 0x00;
  assert(ppu.getTilePixel(0, 0, 1, 2, 0) === 1, '2bpp row1 x=0');

  // charBase offset: tileIdx=0, charBase=0x200 → tileAddr=0x200
  ppu.vram[0x200] = 0xFF; ppu.vram[0x201] = 0xFF;
  assert(ppu.getTilePixel(0, 0, 0, 2, 0x200) === 3, '2bpp charBase=0x200');
}

// ─── 3. getTilePixel — 4bpp ───────────────────────────────────────────────────
function testGetTilePixel4bpp() {
  const ppu = makePPU();
  // tileAddr = charBase + tileIdx * 8 * bpp = 0 + 0 * 32 = 0
  // Row 0: planes 0-1 at vram[0..1], planes 2-3 at vram[16..17]

  // All planes 0xFF → pixel = 0b1111 = 15 for all x in row 0
  ppu.vram[0]  = 0xFF; ppu.vram[1]  = 0xFF; // planes 0-1 row 0
  ppu.vram[16] = 0xFF; ppu.vram[17] = 0xFF; // planes 2-3 row 0
  for (let x = 0; x < 8; x++) {
    assert(ppu.getTilePixel(0, x, 0, 4, 0) === 15,
      `4bpp all-FF x=${x}: expected 15`);
  }

  // Only plane2 set (0xFF) → pixel = 0b0100 = 4
  ppu.vram[0]  = 0x00; ppu.vram[1]  = 0x00;
  ppu.vram[16] = 0xFF; ppu.vram[17] = 0x00;
  for (let x = 0; x < 8; x++) {
    assert(ppu.getTilePixel(0, x, 0, 4, 0) === 4,
      `4bpp only plane2 x=${x}: expected 4`);
  }

  // Only plane3 set (0xFF) → pixel = 0b1000 = 8
  ppu.vram[16] = 0x00; ppu.vram[17] = 0xFF;
  for (let x = 0; x < 8; x++) {
    assert(ppu.getTilePixel(0, x, 0, 4, 0) === 8,
      `4bpp only plane3 x=${x}: expected 8`);
  }

  // tileIdx=1 at charBase=0: tileAddr = 1*32 = 32
  ppu.vram[32]  = 0xFF; ppu.vram[33]  = 0xFF;
  ppu.vram[48]  = 0xFF; ppu.vram[49]  = 0xFF;
  for (let x = 0; x < 8; x++) {
    assert(ppu.getTilePixel(1, x, 0, 4, 0) === 15,
      `4bpp tileIdx=1 x=${x}: expected 15`);
  }
}

// ─── 4. getTilePixel — 8bpp ───────────────────────────────────────────────────
function testGetTilePixel8bpp() {
  const ppu = makePPU();
  // 8bpp: tileAddr = 0, tile size = 64 bytes
  // Row 0 planes 0-1: vram[0..1], planes 2-3: vram[16..17]
  //        planes 4-5: vram[32..33], planes 6-7: vram[48..49]

  // All planes 0xFF → pixel = 255 for all x
  for (let plane = 0; plane < 8; plane++) {
    const base = (plane < 4) ? (Math.floor(plane / 2)) * 16 + (plane & 1)
                              : 32 + (Math.floor((plane - 4) / 2)) * 16 + (plane & 1);
    // Simpler: just fill the known byte offsets directly
  }
  // planes 0-1 row 0
  ppu.vram[0]  = 0xFF; ppu.vram[1]  = 0xFF;
  // planes 2-3 row 0 (tileAddr + 16 + y*2)
  ppu.vram[16] = 0xFF; ppu.vram[17] = 0xFF;
  // planes 4-5 row 0 (tileAddr + 32 + y*2)
  ppu.vram[32] = 0xFF; ppu.vram[33] = 0xFF;
  // planes 6-7 row 0 (tileAddr + 48 + y*2)
  ppu.vram[48] = 0xFF; ppu.vram[49] = 0xFF;

  for (let x = 0; x < 8; x++) {
    assert(ppu.getTilePixel(0, x, 0, 8, 0) === 255,
      `8bpp all-FF x=${x}: expected 255`);
  }

  // Only planes 6-7 set (bits 6-7): pixel = 0b11000000 = 0xC0 = 192
  ppu.vram[0]  = 0x00; ppu.vram[1]  = 0x00;
  ppu.vram[16] = 0x00; ppu.vram[17] = 0x00;
  ppu.vram[32] = 0x00; ppu.vram[33] = 0x00;
  ppu.vram[48] = 0xFF; ppu.vram[49] = 0xFF;
  for (let x = 0; x < 8; x++) {
    assert(ppu.getTilePixel(0, x, 0, 8, 0) === 0xC0,
      `8bpp only planes 6-7 x=${x}: expected 0xC0`);
  }

  // Only plane4 set (bit 4): pixel = 0b00010000 = 16
  ppu.vram[48] = 0x00; ppu.vram[49] = 0x00;
  ppu.vram[32] = 0xFF; ppu.vram[33] = 0x00;
  for (let x = 0; x < 8; x++) {
    assert(ppu.getTilePixel(0, x, 0, 8, 0) === 16,
      `8bpp only plane4 x=${x}: expected 16`);
  }
}

// ─── 5. applyColorMath — addition ─────────────────────────────────────────────
function testColorMathAddition() {
  // Setup: BG1 pixel at x=0, COLDATA = R:10,G:0,B:0, add mode, BG1 enabled
  // Main: red=80 (r5=10) + COLDATA: r5=10 → resR=20 → scaled=(20<<3)|(20>>2)=165
  const ppu = makePPU();
  ppu.write(0x2132, 0x20 | 10); // set R channel of COLDATA = 10
  ppu.cgadsub = 0x01;           // bit7=0 (add), bit6=0 (no halve), bit0=1 (BG1 enabled)
  ppu.cgwsel  = 0x00;           // mathEnable=0 → always apply
  ppu.layerBuffer[0] = 1;       // x=0 is BG1
  // ABGR: A=FF, B=00, G=00, R=80
  ppu.frameBuffer[0] = (0xFF << 24) | (0 << 16) | (0 << 8) | 80;

  ppu.applyColorMath(0, 0);

  const result = ppu.frameBuffer[0];
  const r = result & 0xFF;
  assert(r === 165, `color math add: expected r=165, got r=${r}`);
  assert(((result >> 8) & 0xFF) === 0, 'color math add: g should be 0');
  assert(((result >> 16) & 0xFF) === 0, 'color math add: b should be 0');

  // Clamp at 31: r5=30 + cr5=10 = 40 → min(31,40)=31 → scaled=255
  ppu.frameBuffer[1] = (0xFF << 24) | 0 | 0 | (30 * 8); // r = 240 ≈ r5=30
  ppu.layerBuffer[1] = 1;
  ppu.applyColorMath(0, 0);
  const r2 = ppu.frameBuffer[1] & 0xFF;
  assert(r2 === 255, `color math add clamp: expected 255, got ${r2}`);
}

// ─── 6. applyColorMath — subtraction ─────────────────────────────────────────
function testColorMathSubtraction() {
  // cgadsub bit7=1 → subtract; COLDATA R=5 (rF=40), main R=80 (r5=10), cr5=5 → resR=5
  // scaled: (5<<3)|(5>>2) = 40|1 = 41
  const ppu = makePPU();
  ppu.write(0x2132, 0x20 | 5);  // coldataR = 5
  ppu.cgadsub = 0x80 | 0x01;    // bit7=1 (subtract), BG1 enabled
  ppu.cgwsel  = 0x00;
  ppu.layerBuffer[0] = 1;
  ppu.frameBuffer[0] = (0xFF << 24) | 80;

  ppu.applyColorMath(0, 0);

  const r = ppu.frameBuffer[0] & 0xFF;
  assert(r === 41, `color math sub: expected r=41, got r=${r}`);

  // Clamp at 0: r5=3, cr5=10 → max(0,-7)=0 → r=0
  ppu.frameBuffer[1] = (0xFF << 24) | 24; // r=24, r5=3
  ppu.layerBuffer[1] = 1;
  ppu.applyColorMath(0, 0);
  const r2 = ppu.frameBuffer[1] & 0xFF;
  assert(r2 === 0, `color math sub clamp: expected 0, got ${r2}`);
}

// ─── 7. applyColorMath — halve ────────────────────────────────────────────────
function testColorMathHalve() {
  // cgadsub: bit7=0 (add), bit6=1 (halve); COLDATA R=0; main R=80 (r5=10)
  // resR = min(31, 10+0) = 10 → halve → 5 → scaled = (5<<3)|(5>>2) = 41
  const ppu = makePPU();
  ppu.cgadsub = 0x40 | 0x01;    // halve + BG1
  ppu.cgwsel  = 0x00;
  ppu.layerBuffer[0] = 1;
  ppu.frameBuffer[0] = (0xFF << 24) | 80; // r=80, g=0, b=0

  ppu.applyColorMath(0, 0);

  const r = ppu.frameBuffer[0] & 0xFF;
  assert(r === 41, `color math halve: expected r=41, got r=${r}`);
}

// ─── 8. applyColorMath — mathEnable=3 (never apply) ──────────────────────────
function testColorMathNeverApply() {
  // mathEnable=3 (cgwsel bits 5-4 = 0x30) → always prevent → no change
  const ppu = makePPU();
  ppu.write(0x2132, 0x20 | 31); // coldataR = 31 (would change everything if applied)
  ppu.cgadsub = 0x01;            // BG1 enabled
  ppu.cgwsel  = 0x30;            // mathEnable = 3 → never
  ppu.layerBuffer[0] = 1;
  const original = (0xFF << 24) | 80;
  ppu.frameBuffer[0] = original;

  ppu.applyColorMath(0, 0);

  assert((ppu.frameBuffer[0] & 0xFF) === 80,
    `mathEnable=3: pixel should be unchanged, got r=${ppu.frameBuffer[0] & 0xFF}`);
}

// ─── 9. applyColorMath — layer not enabled ────────────────────────────────────
function testColorMathLayerGate() {
  // cgadsub = 0x00 (no layers enabled) → math prevented for all layers
  const ppu = makePPU();
  ppu.write(0x2132, 0x20 | 31);
  ppu.cgadsub = 0x00;            // no layers enabled
  ppu.cgwsel  = 0x00;
  ppu.layerBuffer[0] = 1;        // BG1, but bit0 of enables=0 → prevented
  ppu.frameBuffer[0] = (0xFF << 24) | 80;

  ppu.applyColorMath(0, 0);

  assert((ppu.frameBuffer[0] & 0xFF) === 80,
    `layer not enabled: pixel unchanged, got r=${ppu.frameBuffer[0] & 0xFF}`);
}

// ─── 10. applyBrightness ──────────────────────────────────────────────────────
function testBrightness() {
  // brightness=15 → no change (early return)
  {
    const ppu = makePPU();
    ppu.inidisp = 15; // brightness = inidisp & 0x0F = 15
    ppu.frameBuffer[0] = 0xFF8844AA;
    ppu.applyBrightness(0, 0);
    assert(ppu.frameBuffer[0] === 0xFF8844AA, 'brightness=15: no change');
  }

  // brightness=0 → all black
  {
    const ppu = makePPU();
    ppu.inidisp = 0;
    ppu.frameBuffer[0] = 0xFFFFFFFF;
    ppu.applyBrightness(0, 0);
    const result = ppu.frameBuffer[0];
    assert((result & 0xFFFFFF) === 0, `brightness=0: expected all black, got 0x${result.toString(16)}`);
  }

  // brightness=7: r = floor(r * 7 / 15)
  {
    const ppu = makePPU();
    ppu.inidisp = 7;
    const inputR = 255, inputG = 0, inputB = 0;
    ppu.frameBuffer[0] = (0xFF << 24) | (inputB << 16) | (inputG << 8) | inputR;
    ppu.applyBrightness(0, 0);
    const expectedR = Math.floor(255 * 7 / 15); // = 119
    const r = ppu.frameBuffer[0] & 0xFF;
    assert(r === expectedR, `brightness=7: expected r=${expectedR}, got r=${r}`);
    assert(((ppu.frameBuffer[0] >> 8) & 0xFF) === 0, 'brightness=7: g=0');
    assert(((ppu.frameBuffer[0] >> 16) & 0xFF) === 0, 'brightness=7: b=0');
  }

  // All 256 pixels scaled uniformly
  {
    const ppu = makePPU();
    ppu.inidisp = 4; // brightness = 4
    for (let x = 0; x < 256; x++) {
      ppu.frameBuffer[x] = (0xFF << 24) | (0x40 << 16) | (0x80 << 8) | 0xC0;
    }
    ppu.applyBrightness(0, 0);
    for (let x = 0; x < 256; x++) {
      const r = ppu.frameBuffer[x] & 0xFF;
      const g = (ppu.frameBuffer[x] >> 8) & 0xFF;
      const b = (ppu.frameBuffer[x] >> 16) & 0xFF;
      const eR = Math.floor(0xC0 * 4 / 15);
      const eG = Math.floor(0x80 * 4 / 15);
      const eB = Math.floor(0x40 * 4 / 15);
      assert(r === eR, `brightness=4 x=${x}: r expected ${eR}, got ${r}`);
      assert(g === eG, `brightness=4 x=${x}: g expected ${eG}, got ${g}`);
      assert(b === eB, `brightness=4 x=${x}: b expected ${eB}, got ${b}`);
    }
  }
}

// ─── run ──────────────────────────────────────────────────────────────────────
testGetColor();
testGetTilePixel2bpp();
testGetTilePixel4bpp();
testGetTilePixel8bpp();
testColorMathAddition();
testColorMathSubtraction();
testColorMathHalve();
testColorMathNeverApply();
testColorMathLayerGate();
testBrightness();

console.log('PASS: PPU pixel/colour checks');
