// test_ppu_bg.mjs — BG layer rendering tests
// Covers: basic tile draw (scBase, charBase, z/layer buffers),
//         transparent pixel, z-buffer gate, flipX/flipY,
//         hScroll/vScroll, palette index, mode 0 palette offsets.
import { PPU } from './src/PPU.js';

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

function makePPU() {
  const ppu = new PPU();
  ppu.inidisp = 0x0F; // forced-blank off
  return ppu;
}

// Set tilemap word entry at a VRAM byte address
function setTilemapEntry(ppu, vramByteAddr, tileIdx, palIdx, prio, flipX, flipY) {
  const entry = (tileIdx & 0x3FF) | ((palIdx & 7) << 10) | ((prio & 1) << 13)
              | ((flipX & 1) << 14) | ((flipY & 1) << 15);
  ppu.vram[vramByteAddr]     = entry & 0xFF;
  ppu.vram[vramByteAddr + 1] = (entry >> 8) & 0xFF;
}

// Write one row of a 4bpp tile (charBase in bytes; tileIdx is the tile number)
function setTile4bppRow(ppu, charBase, tileIdx, row, p0, p1, p2, p3) {
  const tileAddr = charBase + tileIdx * 32;
  ppu.vram[tileAddr + row * 2]          = p0;
  ppu.vram[tileAddr + row * 2 + 1]      = p1;
  ppu.vram[tileAddr + 16 + row * 2]     = p2;
  ppu.vram[tileAddr + 16 + row * 2 + 1] = p3;
}

// Write one row of a 2bpp tile
function setTile2bppRow(ppu, charBase, tileIdx, row, p0, p1) {
  const tileAddr = charBase + tileIdx * 16;
  ppu.vram[tileAddr + row * 2]     = p0;
  ppu.vram[tileAddr + row * 2 + 1] = p1;
}

// Write a BGR555 colour directly to CGRAM (palette entry n)
function setCgramColor(ppu, n, r5, g5, b5) {
  const val = r5 | (g5 << 5) | (b5 << 10);
  ppu.cgram[n * 2]     = val & 0xFF;
  ppu.cgram[n * 2 + 1] = (val >> 8) & 0xFF;
}

// ─── 1. Basic BG1 tile draw (4bpp, mode 1) ───────────────────────────────────
function testBgBasicDraw() {
  const ppu = makePPU();

  // bg1sc = 0x08 → scBase = (0x08 & 0xFC) << 9 = 0x1000
  ppu.bg1sc   = 0x08;
  ppu.bg12nba = 0x00; // charBase = 0
  ppu.bg1hofs = 0;
  ppu.bg1vofs = 0;

  // Tilemap: entry at 0x1000 → tile 1, palette 0, no flip
  setTilemapEntry(ppu, 0x1000, 1, 0, 0, 0, 0);

  // Tile 1 row 0 (4bpp): plane0=0xFF → colorIdx=1 for all 8 pixels
  setTile4bppRow(ppu, 0, 1, 0, 0xFF, 0x00, 0x00, 0x00);

  // CGRAM entry 1: pure red (r5=31)
  setCgramColor(ppu, 1, 31, 0, 0);

  ppu.zBuffer.fill(0);
  ppu.layerBuffer.fill(0);

  ppu.renderLayer(0, 1, 1, 5, 15);

  const expectedColor = ppu.getColor(1) >>> 0;
  for (let x = 0; x < 8; x++) {
    assert((ppu.frameBuffer[x] >>> 0) === expectedColor, `basic draw x=${x}: color mismatch`);
    assert(ppu.zBuffer[x] === 5, `basic draw x=${x}: zBuffer should be 5`);
    assert(ppu.layerBuffer[x] === 1, `basic draw x=${x}: layerBuffer should be 1`);
  }
  // Tile 1 ends at x=7; x=8 uses next tilemap entry (tile 0 = transparent by default)
  assert(ppu.zBuffer[8] === 0, 'x=8 not drawn: zBuffer=0');
}

// ─── 2. Transparent pixel (colorIdx=0) is not drawn ──────────────────────────
function testBgTransparentPixel() {
  const ppu = makePPU();
  ppu.bg1sc   = 0x08;
  ppu.bg12nba = 0x00;
  ppu.bg1hofs = 0; ppu.bg1vofs = 0;

  // Tile 1 row 0: all planes = 0 → colorIdx = 0 everywhere
  setTilemapEntry(ppu, 0x1000, 1, 0, 0, 0, 0);
  setTile4bppRow(ppu, 0, 1, 0, 0x00, 0x00, 0x00, 0x00);

  const sentinel = 0xDEADBEEF;
  ppu.frameBuffer[0] = sentinel;
  ppu.zBuffer.fill(0);

  ppu.renderLayer(0, 1, 1, 5, 15);

  assert((ppu.frameBuffer[0] >>> 0) === (sentinel >>> 0),
    'transparent pixel: frameBuffer should not change');
  assert(ppu.zBuffer[0] === 0, 'transparent pixel: zBuffer stays 0');
}

// ─── 3. Z-buffer gates rendering ─────────────────────────────────────────────
function testBgZBufferGate() {
  const ppu = makePPU();
  ppu.bg1sc   = 0x08;
  ppu.bg12nba = 0x00;
  ppu.bg1hofs = 0; ppu.bg1vofs = 0;
  setTilemapEntry(ppu, 0x1000, 1, 0, 0, 0, 0);
  setTile4bppRow(ppu, 0, 1, 0, 0xFF, 0x00, 0x00, 0x00); // colorIdx=1
  setCgramColor(ppu, 1, 31, 0, 0);

  // Case A: zBuffer[0] = 10, calling with zLow=5 → z=5 <= 10 → NOT drawn
  ppu.zBuffer.fill(0);
  ppu.zBuffer[0] = 10;
  ppu.frameBuffer[0] = 0;
  ppu.renderLayer(0, 1, 1, 5, 15);
  assert(ppu.frameBuffer[0] === 0, 'z-gate: z=5 <= zBuf=10 → not drawn');

  // Case B: zBuffer[0] = 3, calling with zLow=5 → z=5 > 3 → IS drawn
  ppu.zBuffer.fill(0);
  ppu.zBuffer[0] = 3;
  ppu.frameBuffer[0] = 0;
  ppu.renderLayer(0, 1, 1, 5, 15);
  assert(ppu.frameBuffer[0] !== 0, 'z-gate: z=5 > zBuf=3 → drawn');

  // Case C: high-priority tile (entry prio=1 → uses zHigh=15) over zBuffer=10
  setTilemapEntry(ppu, 0x1000, 1, 0, 1, 0, 0); // prio=1
  ppu.zBuffer.fill(0);
  ppu.zBuffer[0] = 12;
  ppu.frameBuffer[0] = 0;
  ppu.renderLayer(0, 1, 1, 5, 15);
  assert(ppu.frameBuffer[0] !== 0, 'z-gate prio=1: z=15 > zBuf=12 → drawn');
  assert(ppu.zBuffer[0] === 15, 'z-gate prio=1: zBuffer updated to 15');
}

// ─── 4. flipX in tilemap entry ────────────────────────────────────────────────
function testBgFlipX() {
  const ppu = makePPU();
  ppu.bg1sc   = 0x08;
  ppu.bg12nba = 0x00;
  ppu.bg1hofs = 0; ppu.bg1vofs = 0;

  // Tile 1 row 0: only leftmost pixel (x=0) opaque → plane0=0b10000000
  setTile4bppRow(ppu, 0, 1, 0, 0b10000000, 0x00, 0x00, 0x00); // colorIdx=1 only at x=0

  // Without flip: pixel x=0 drawn, x=1..7 transparent
  setTilemapEntry(ppu, 0x1000, 1, 0, 0, 0, 0); // no flip
  ppu.zBuffer.fill(0);
  ppu.renderLayer(0, 1, 1, 5, 15);
  assert(ppu.zBuffer[0] === 5, 'no flipX: x=0 drawn');
  assert(ppu.zBuffer[7] === 0, 'no flipX: x=7 not drawn');

  // With flipX: localX = 7 - (rX & 7) → x=0 maps to localX=7 (transparent), x=7 maps to localX=0 (opaque)
  setTilemapEntry(ppu, 0x1000, 1, 0, 0, 1, 0); // flipX=1
  ppu.zBuffer.fill(0);
  ppu.renderLayer(0, 1, 1, 5, 15);
  assert(ppu.zBuffer[0] === 0, 'flipX: x=0 should now be transparent (was localX=7)');
  assert(ppu.zBuffer[7] === 5, 'flipX: x=7 should be drawn (maps to localX=0)');
}

// ─── 5. flipY in tilemap entry ────────────────────────────────────────────────
function testBgFlipY() {
  const ppu = makePPU();
  ppu.bg1sc   = 0x08;
  ppu.bg12nba = 0x00;
  ppu.bg1hofs = 0; ppu.bg1vofs = 0;

  // Row 0 transparent, row 7 opaque
  setTile4bppRow(ppu, 0, 1, 0, 0x00, 0x00, 0x00, 0x00); // row 0: transparent
  setTile4bppRow(ppu, 0, 1, 7, 0xFF, 0x00, 0x00, 0x00); // row 7: opaque
  setTilemapEntry(ppu, 0x1000, 1, 0, 0, 0, 0);

  // No flipY: renderLine(0) uses row 0 → transparent
  ppu.zBuffer.fill(0);
  ppu.renderLayer(0, 1, 1, 5, 15);
  assert(ppu.zBuffer[0] === 0, 'no flipY: row 0 is transparent');

  // With flipY: renderLine(0) maps to localY = 7 - (rY & 7) = 7 → opaque
  setTilemapEntry(ppu, 0x1000, 1, 0, 0, 0, 1); // flipY=1
  ppu.zBuffer.fill(0);
  ppu.renderLayer(0, 1, 1, 5, 15);
  assert(ppu.zBuffer[0] === 5, 'flipY: line=0 maps to row 7 → opaque');

  // With flipY: renderLine(7) maps to localY = 7 - (7 & 7) = 0 → transparent
  ppu.zBuffer.fill(0);
  ppu.renderLayer(7, 1, 1, 5, 15);
  assert(ppu.zBuffer[0] === 0, 'flipY: line=7 maps to row 0 → transparent');
}

// ─── 6. hScroll shifts tile selection ────────────────────────────────────────
function testBgHScroll() {
  const ppu = makePPU();
  ppu.bg1sc   = 0x08;
  ppu.bg12nba = 0x00;
  ppu.bg1vofs = 0;

  // Tile 1 at tilemap[0,0] (x=0..7 with no scroll): all opaque
  setTilemapEntry(ppu, 0x1000, 1, 0, 0, 0, 0);
  setTile4bppRow(ppu, 0, 1, 0, 0xFF, 0x00, 0x00, 0x00);

  // Tile 2 at tilemap[0,1] (x=8..15 with no scroll): all opaque
  setTilemapEntry(ppu, 0x1002, 2, 1, 0, 0, 0); // palette 1
  setTile4bppRow(ppu, 0, 2, 0, 0xFF, 0x00, 0x00, 0x00);

  setCgramColor(ppu, 1, 31, 0, 0);   // color 1 = red
  setCgramColor(ppu, 17, 0, 31, 0);  // color 16+1 = green (palette 1, colorIdx=1)

  // No scroll: x=0 uses tile 1 (red)
  ppu.bg1hofs = 0;
  ppu.zBuffer.fill(0);
  ppu.renderLayer(0, 1, 1, 5, 15);
  const red   = ppu.getColor(1) >>> 0;
  const green = ppu.getColor(17) >>> 0;
  assert((ppu.frameBuffer[0] >>> 0) === red,   'hScroll=0: x=0 uses tile 1 (red)');
  assert((ppu.frameBuffer[8] >>> 0) === green,  'hScroll=0: x=8 uses tile 2 (green)');

  // hScroll=8: at x=0, rX=8 → tileX=1 → tile 2 (green)
  ppu.bg1hofs = 8;
  ppu.zBuffer.fill(0);
  ppu.frameBuffer.fill(0);
  ppu.renderLayer(0, 1, 1, 5, 15);
  assert((ppu.frameBuffer[0] >>> 0) === green, 'hScroll=8: x=0 uses tile 2 (green)');
}

// ─── 7. vScroll shifts tile row selection ────────────────────────────────────
function testBgVScroll() {
  const ppu = makePPU();
  ppu.bg1sc   = 0x08;
  ppu.bg12nba = 0x00;
  ppu.bg1hofs = 0;

  // Tile 1 at tilemap[0,0]: row 0 opaque, row 1 transparent
  setTilemapEntry(ppu, 0x1000, 1, 0, 0, 0, 0);
  setTile4bppRow(ppu, 0, 1, 0, 0xFF, 0x00, 0x00, 0x00); // row 0: opaque
  setTile4bppRow(ppu, 0, 1, 1, 0x00, 0x00, 0x00, 0x00); // row 1: transparent

  // No vScroll: renderLine(0) → localY=0 → opaque
  ppu.bg1vofs = 0;
  ppu.zBuffer.fill(0);
  ppu.renderLayer(0, 1, 1, 5, 15);
  assert(ppu.zBuffer[0] === 5, 'vScroll=0: line=0 uses tile row 0 (opaque)');

  // vScroll=1: renderLine(0) → rY=1 → localY=1 → transparent
  ppu.bg1vofs = 1;
  ppu.zBuffer.fill(0);
  ppu.renderLayer(0, 1, 1, 5, 15);
  assert(ppu.zBuffer[0] === 0, 'vScroll=1: line=0 maps to tile row 1 (transparent)');
}

// ─── 8. Palette index in tilemap entry affects color ─────────────────────────
function testBgPaletteIndex() {
  const ppu = makePPU();
  ppu.bg1sc   = 0x08;
  ppu.bg12nba = 0x00;
  ppu.bg1hofs = 0; ppu.bg1vofs = 0;

  // colorIdx=1 for all pixels
  setTile4bppRow(ppu, 0, 1, 0, 0xFF, 0x00, 0x00, 0x00);

  // Palette 0: colorIdx 1 → globalColorIdx = 0 + 0*16 + 1 = 1 (red)
  setCgramColor(ppu, 1, 31, 0, 0);
  // Palette 2: colorIdx 1 → globalColorIdx = 0 + 2*16 + 1 = 33 (green)
  setCgramColor(ppu, 33, 0, 31, 0);

  // Use palette 0
  setTilemapEntry(ppu, 0x1000, 1, 0, 0, 0, 0); // palIdx=0
  ppu.zBuffer.fill(0);
  ppu.renderLayer(0, 1, 1, 5, 15);
  const red   = ppu.getColor(1) >>> 0;
  const green = ppu.getColor(33) >>> 0;
  assert((ppu.frameBuffer[0] >>> 0) === red, 'palIdx=0: expected red');

  // Use palette 2
  setTilemapEntry(ppu, 0x1000, 1, 2, 0, 0, 0); // palIdx=2
  ppu.zBuffer.fill(0);
  ppu.frameBuffer.fill(0);
  ppu.renderLayer(0, 1, 1, 5, 15);
  assert((ppu.frameBuffer[0] >>> 0) === green, 'palIdx=2: expected green');
}

// ─── 9. Mode 0 palette offsets per BG ────────────────────────────────────────
function testBgMode0PaletteOffset() {
  // In mode 0: BG1 paletteOffset=0, BG2 paletteOffset=32, BG3=64, BG4=96
  const ppu = makePPU();
  ppu.bg2sc   = 0x10; // scBase = (0x10 & 0xFC) << 9 = 0x2000
  ppu.bg12nba = 0x00; // BG2 charBase = (bg12nba & 0xF0) << 9 = 0
  ppu.bg2hofs = 0; ppu.bg2vofs = 0;

  // BG2, mode 0 → bpp=2, paletteOffset=32
  // Tile 1 2bpp row 0: plane0=0xFF → colorIdx=1 (all pixels)
  setTile2bppRow(ppu, 0, 1, 0, 0xFF, 0x00);
  setTilemapEntry(ppu, 0x2000, 1, 0, 0, 0, 0); // palIdx=0

  // globalColorIdx = 32 + 0*4 + 1 = 33
  setCgramColor(ppu, 33, 0, 31, 0); // green at CGRAM 33

  ppu.zBuffer.fill(0);
  ppu.renderLayer(0, 2, 0, 5, 15);

  const green = ppu.getColor(33) >>> 0;
  assert((ppu.frameBuffer[0] >>> 0) === green,
    `mode0 BG2 paletteOffset=32: expected green at 0x${green.toString(16)}`);
}

// ─── 10. charBase from bg12nba ────────────────────────────────────────────────
function testBgCharBase() {
  const ppu = makePPU();
  ppu.bg1sc   = 0x08; // scBase=0x1000
  ppu.bg1hofs = 0; ppu.bg1vofs = 0;

  // bg12nba bits 3-0 for BG1: charBase = (bg12nba & 0x0F) << 13
  // Set bg12nba = 0x01 → charBase = 1 << 13 = 0x2000 (8192 bytes)
  ppu.bg12nba = 0x01;
  const charBase = 0x2000;

  setTilemapEntry(ppu, 0x1000, 1, 0, 0, 0, 0);
  // Tile 1 at charBase: row 0 plane0=0xFF
  setTile4bppRow(ppu, charBase, 1, 0, 0xFF, 0x00, 0x00, 0x00);
  setCgramColor(ppu, 1, 31, 0, 0); // red

  ppu.zBuffer.fill(0);
  ppu.renderLayer(0, 1, 1, 5, 15);

  const red = ppu.getColor(1) >>> 0;
  assert((ppu.frameBuffer[0] >>> 0) === red, 'charBase=0x2000: tile drawn from correct location');

  // Verify: tile data at charBase=0 (default) is empty → tile NOT drawn
  ppu.bg12nba = 0x00; // charBase=0, tile 1 at 0x20 (not set up → 0 → transparent)
  ppu.zBuffer.fill(0);
  ppu.frameBuffer.fill(0);
  ppu.renderLayer(0, 1, 1, 5, 15);
  assert(ppu.zBuffer[0] === 0, 'charBase=0: tile 1 empty at 0x20 → not drawn');
}

// ─── run ──────────────────────────────────────────────────────────────────────
testBgBasicDraw();
testBgTransparentPixel();
testBgZBufferGate();
testBgFlipX();
testBgFlipY();
testBgHScroll();
testBgVScroll();
testBgPaletteIndex();
testBgMode0PaletteOffset();
testBgCharBase();

console.log('PASS: PPU BG layer rendering checks');
