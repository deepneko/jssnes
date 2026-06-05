// test_ppu_sprites.mjs — PPU sprite evaluation tests
// Covers: forced-blank guard, basic sprite draw, out-of-line skip,
//         x-clipping, priority, horizontal flip, low-index priority over high-index.
import { PPU } from './src/PPU.js';

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

function makePPU() {
  const ppu = new PPU();
  ppu.inidisp = 0x0F; // clear forced-blank (bit 7)
  ppu.obsel   = 0x00; // 8×8 small, nameBase=0, page1Offset=0x2000
  return ppu;
}

// Move all 128 sprites off-screen (y=0xF0, difY will be ≥8 for any line ≤ 16)
function clearSprites(ppu) {
  for (let i = 0; i < 128; i++) {
    ppu.oam[i * 4 + 1] = 0xF0; // y=240 → difY≥8 for lines 0..231
  }
}

// Place sprite i at (x, y), tile=tile, attr=attr (8×8 small, no hi-x, sizeFlag=0)
function setSprite(ppu, i, x, y, tile, attr) {
  const base = i * 4;
  ppu.oam[base]     = x & 0xFF;
  ppu.oam[base + 1] = y & 0xFF;
  ppu.oam[base + 2] = tile;
  ppu.oam[base + 3] = attr;
  // Hi-byte table: clear xHi + sizeFlag for sprite i
  const hiAddr = 512 + (i >> 2);
  const shift  = (i & 3) * 2;
  ppu.oam[hiAddr] &= ~(0x03 << shift); // xHi=0, sizeFlag=0
}

// Write a solid 4bpp tile at tileIdx * 32 bytes in VRAM
// colorIdx = value (1–15) to fill all 8 pixels of every row
function writeSolidTile4bpp(ppu, tileIdx, colorIdx) {
  const tileAddr = tileIdx * 32; // nameBase=0
  const bit0 = (colorIdx & 1) ? 0xFF : 0x00;
  const bit1 = (colorIdx & 2) ? 0xFF : 0x00;
  const bit2 = (colorIdx & 4) ? 0xFF : 0x00;
  const bit3 = (colorIdx & 8) ? 0xFF : 0x00;
  for (let row = 0; row < 8; row++) {
    ppu.vram[tileAddr + row * 2]      = bit0; // plane 0
    ppu.vram[tileAddr + row * 2 + 1]  = bit1; // plane 1
    ppu.vram[tileAddr + 16 + row * 2]     = bit2; // plane 2
    ppu.vram[tileAddr + 16 + row * 2 + 1] = bit3; // plane 3
  }
}

// ─── 1. Forced blank: evaluateSprites does nothing ────────────────────────────
function testForcedBlank() {
  const ppu = makePPU();
  ppu.inidisp = 0x8F; // forced blank bit set
  clearSprites(ppu);
  writeSolidTile4bpp(ppu, 0, 1);
  setSprite(ppu, 0, 0, 0, 0, 0);
  ppu.objBuffer.fill(0);
  ppu.evaluateSprites(0);
  assert(ppu.objBuffer[0] === 0, 'forced blank: no sprite drawn');
}

// ─── 2. Sprite on correct line draws into objBuffer ───────────────────────────
function testSpriteOnLine() {
  const ppu = makePPU();
  clearSprites(ppu);
  writeSolidTile4bpp(ppu, 0, 1); // colorIdx=1 everywhere
  setSprite(ppu, 0, 10, 5, 0, 0); // x=10, y=5, tile=0, attr=0
  ppu.objBuffer.fill(0);
  ppu.evaluateSprites(5); // line 5 = sprite's y

  // All 8 pixels x=10..17 should be drawn (non-zero in objBuffer)
  for (let x = 10; x < 18; x++) {
    assert(ppu.objBuffer[x] !== 0, `line=5 x=${x}: expected sprite pixel, got 0`);
  }
  // Pixels outside the sprite should still be 0
  assert(ppu.objBuffer[9]  === 0, 'x=9: no sprite');
  assert(ppu.objBuffer[18] === 0, 'x=18: no sprite');
}

// ─── 3. Sprite on wrong line does not draw ────────────────────────────────────
function testSpriteOffLine() {
  const ppu = makePPU();
  clearSprites(ppu);
  writeSolidTile4bpp(ppu, 0, 1);
  setSprite(ppu, 0, 0, 5, 0, 0); // y=5
  ppu.objBuffer.fill(0);
  ppu.evaluateSprites(0); // line 0 ≠ y=5
  for (let x = 0; x < 8; x++) {
    assert(ppu.objBuffer[x] === 0, `wrong line x=${x}: should be 0`);
  }
}

// ─── 4. Sprite transparent pixel (colorIdx=0) not drawn ──────────────────────
function testSpriteTransparentPixel() {
  const ppu = makePPU();
  clearSprites(ppu);
  // Tile where plane0=0b10000000: only pixel x=0 visible (colorIdx=1), rest transparent (0)
  ppu.vram[0] = 0b10000000; // plane 0, row 0
  // all others 0
  setSprite(ppu, 0, 0, 0, 0, 0);
  ppu.objBuffer.fill(0);
  ppu.evaluateSprites(0);
  assert(ppu.objBuffer[0] !== 0, 'transparent test: x=0 should be drawn');
  for (let x = 1; x < 8; x++) {
    assert(ppu.objBuffer[x] === 0, `transparent test: x=${x} should be 0`);
  }
}

// ─── 5. Sprite priority stored in objPrioBuffer ──────────────────────────────
function testSpritePriority() {
  const ppu = makePPU();
  clearSprites(ppu);
  writeSolidTile4bpp(ppu, 0, 1);
  // attr bits 5-4 = priority. Test priority=2 (attr = 0b0010_0000 = 0x20)
  setSprite(ppu, 0, 0, 0, 0, 0x20);
  ppu.objBuffer.fill(0);
  ppu.objPrioBuffer.fill(0);
  ppu.evaluateSprites(0);
  for (let x = 0; x < 8; x++) {
    assert(ppu.objPrioBuffer[x] === 2, `priority x=${x}: expected 2, got ${ppu.objPrioBuffer[x]}`);
  }
}

// ─── 6. High-palette flag in objPalHighBuffer ────────────────────────────────
function testSpritePalHighFlag() {
  const ppu = makePPU();
  clearSprites(ppu);
  writeSolidTile4bpp(ppu, 0, 1);

  // attr bits 3-1 = palette index.
  // Palette 0 (bits 3-1 = 0b000) → attr = 0x00 → palHigh = 0
  setSprite(ppu, 0, 0, 0, 0, 0x00);
  ppu.objBuffer.fill(0); ppu.objPalHighBuffer.fill(99);
  ppu.evaluateSprites(0);
  for (let x = 0; x < 8; x++) {
    assert(ppu.objPalHighBuffer[x] === 0, `palette 0: palHigh x=${x} expected 0`);
  }

  // Palette 4 (bits 3-1 = 0b100 → attr bits 3-1 = 4 → attr = 0x08) → palHigh = 1
  setSprite(ppu, 0, 0, 0, 0, 0x08);
  ppu.objBuffer.fill(0); ppu.objPalHighBuffer.fill(0);
  ppu.evaluateSprites(0);
  for (let x = 0; x < 8; x++) {
    assert(ppu.objPalHighBuffer[x] === 1, `palette 4: palHigh x=${x} expected 1`);
  }
}

// ─── 7. Horizontal flip ──────────────────────────────────────────────────────
function testHorizontalFlip() {
  const ppu = makePPU();
  clearSprites(ppu);
  // Tile: only plane 0 bit 7 (x=0) set → pixel x=0 is opaque, x=1..7 transparent
  ppu.vram[0] = 0b10000000; // plane 0 row 0: only leftmost pixel
  setSprite(ppu, 0, 0, 0, 0, 0x40); // attr bit 6 = flipX
  ppu.objBuffer.fill(0);
  ppu.evaluateSprites(0);

  // With hflip, actualCol = width-1-col. For 8×8: col=0 → actualCol=7, col=7 → actualCol=0.
  // colInTile=7 → bitShift=7-7=0 → (p0>>0)&1 = 0 → transparent
  // col=7 → actualCol=0 → colInTile=0 → bitShift=7-0=7 → (p0>>7)&1 = 1 → opaque
  // So objBuffer[7] should be non-zero, objBuffer[0..6] should be 0
  assert(ppu.objBuffer[7] !== 0, 'hflip: pixel at x=7 should be drawn');
  for (let x = 0; x < 7; x++) {
    assert(ppu.objBuffer[x] === 0, `hflip: x=${x} should be 0`);
  }
}

// ─── 8. Vertical flip ────────────────────────────────────────────────────────
function testVerticalFlip() {
  const ppu = makePPU();
  clearSprites(ppu);
  // Tile: only row 0 is solid (row 1..7 are transparent)
  // With vflip on 8×8 sprite: tile row 7 maps to screen row 0
  // So row 0 of tile (vram[0]) won't be visible at screen y=0 when vflip is set

  writeSolidTile4bpp(ppu, 0, 0); // all transparent
  // Only set row 7 opaque
  const row7Base = 7 * 2;
  ppu.vram[row7Base]     = 0xFF; // plane 0 row 7
  ppu.vram[row7Base + 1] = 0x00;

  setSprite(ppu, 0, 0, 0, 0, 0x80); // attr bit 7 = flipY, sprite at y=0
  ppu.objBuffer.fill(0);
  ppu.evaluateSprites(0); // line 0
  // vflip: actualRow = row ^ (height-1) = 0 ^ 7 = 7 → reads tile row 7 → opaque
  for (let x = 0; x < 8; x++) {
    assert(ppu.objBuffer[x] !== 0, `vflip: x=${x} line=0 should show tile row 7`);
  }

  // Without vflip on line 0: should read tile row 0 (transparent)
  setSprite(ppu, 0, 0, 0, 0, 0x00); // no flip
  ppu.objBuffer.fill(0);
  ppu.evaluateSprites(0);
  for (let x = 0; x < 8; x++) {
    assert(ppu.objBuffer[x] === 0, `no vflip: x=${x} line=0 should be transparent (row 0)`);
  }
}

// ─── 9. Lower sprite index wins at same pixel (priority override) ─────────────
function testLowerIndexWins() {
  const ppu = makePPU();
  clearSprites(ppu);

  // Sprite 127: tile 1 with colorIdx=1, palette 0 → black (CGRAM=0)
  writeSolidTile4bpp(ppu, 1, 1);
  setSprite(ppu, 127, 0, 0, 1, 0x00); // tile=1, palette=0, priority=0

  // Sprite 0: tile 2 with colorIdx=3, palette 1 (16 entries offset)
  // Put recognizable color in CGRAM entry 128 + 16 + 3 = 147
  writeSolidTile4bpp(ppu, 2, 3);
  ppu.write(0x2121, 147);  // CGADD = 147
  ppu.write(0x2122, 0xFF); // lo = 0xFF (R=31, G=24)
  ppu.write(0x2122, 0x03); // hi = 0x03 → R=31, G=31-ish
  setSprite(ppu, 0, 0, 0, 2, 0x02); // tile=2, palette=1 (attr bits 3-1=1 → attr=0x02)

  ppu.objBuffer.fill(0);
  ppu.evaluateSprites(0);

  // Both sprites are at x=0..7. Sprite 0 (lower index) should win.
  // Sprite 0's CGRAM entry 147 was set. Sprite 127's CGRAM entry 129 is default black.
  // Both are non-zero. We verify by checking the color matches sprite 0's CGRAM entry.
  const expectedColor = ppu.getColor(147) >>> 0;
  for (let x = 0; x < 8; x++) {
    assert((ppu.objBuffer[x] >>> 0) === expectedColor,
      `lower index wins: x=${x} expected 0x${expectedColor.toString(16)}, got 0x${(ppu.objBuffer[x]>>>0).toString(16)}`);
  }
}

// ─── 10. X-clipping: pixels outside 0..255 not drawn ─────────────────────────
function testXClipping() {
  const ppu = makePPU();
  clearSprites(ppu);
  writeSolidTile4bpp(ppu, 0, 1);

  // Sprite at x=252: pixels at x=252,253,254,255 visible; 256,257,258,259 clipped
  setSprite(ppu, 0, 252, 0, 0, 0);
  ppu.objBuffer.fill(0);
  ppu.evaluateSprites(0);
  for (let x = 252; x < 256; x++) {
    assert(ppu.objBuffer[x] !== 0, `clip test: x=${x} should be drawn`);
  }
  // x=256+ can't be checked (array is only 256 wide), but no crash = pass

  // Sprite with hi-x bit set: x = 256 - 512 = -256 → all 8 pixels off screen
  const ppu2 = makePPU();
  clearSprites(ppu2);
  writeSolidTile4bpp(ppu2, 0, 1);
  // Place sprite at x=256 (xLo=0, xHi=1) → signed x = 256-512 = -256
  ppu2.oam[0] = 0;   // xLo = 0
  ppu2.oam[1] = 0;   // y = 0
  ppu2.oam[2] = 0;   // tile = 0
  ppu2.oam[3] = 0;   // attr
  ppu2.oam[512] = 0x01; // sprite 0 xHi bit = 1 → x = 256 → 256>255 → x = 256-512 = -256
  ppu2.objBuffer.fill(0);
  ppu2.evaluateSprites(0);
  for (let x = 0; x < 256; x++) {
    assert(ppu2.objBuffer[x] === 0, `off-screen sprite: x=${x} should be 0`);
  }
}

// ─── run ──────────────────────────────────────────────────────────────────────
testForcedBlank();
testSpriteOnLine();
testSpriteOffLine();
testSpriteTransparentPixel();
testSpritePriority();
testSpritePalHighFlag();
testHorizontalFlip();
testVerticalFlip();
testLowerIndexWins();
testXClipping();

console.log('PASS: PPU sprite evaluation checks');
