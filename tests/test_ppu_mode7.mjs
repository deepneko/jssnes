// test_ppu_mode7.mjs — Mode 7 rendering tests
// Covers: identity matrix 1:1 pixel mapping, out-of-bounds modes (transparent/tile0),
//         hScroll translate, horizontal flip, scale (2×).
//
// NOTE: the PPU's internal frameBuffer/zBuffer/layerBuffer are 512px wide.
// Mode 7 is never hi-res, so it is pixel-doubled: logical screen pixel sx
// maps to output indices 2*sx and 2*sx+1, which always carry the same value.
// Tests check both sub-pixels.
import { PPU } from '../src/PPU.js';

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

// VRAM layout for Mode 7:
//   Tilemap:    vram[mapIndex * 2]          (even bytes)   mapIndex = tileY*128 + tileX
//   Pixel data: vram[pixelOffset * 2 + 1]   (odd bytes)    pixelOffset = tileCode*64 + py*8 + px

function makePPU() {
  const ppu = new PPU();
  ppu.inidisp = 0x0F; // forced-blank off
  // Identity matrix (a=256, b=0, c=0, d=256 in 8.8 fixed-point)
  ppu.m7a = 0x0100; ppu.m7b = 0x0000;
  ppu.m7c = 0x0000; ppu.m7d = 0x0100;
  ppu.m7x = 0; ppu.m7y = 0;
  ppu.m7hofs = 0; ppu.m7vofs = 0;
  ppu.m7sel  = 0x00; // no flip, repeat=0 (wrap)
  return ppu;
}

// Write a BGR555 colour directly to CGRAM entry n
function setCgramColor(ppu, n, r5, g5, b5) {
  const val = r5 | (g5 << 5) | (b5 << 10);
  ppu.cgram[n * 2]     = val & 0xFF;
  ppu.cgram[n * 2 + 1] = (val >> 8) & 0xFF;
}

// Place a tileCode in the Mode 7 tilemap for tile (tileX, tileY)
function setM7TileCode(ppu, tileX, tileY, tileCode) {
  const mapIndex = tileY * 128 + tileX;
  ppu.vram[mapIndex * 2] = tileCode & 0xFF;
}

// Set the colorIdx for a specific pixel (px, py) within a tileCode
function setM7Pixel(ppu, tileCode, px, py, colorIdx) {
  const pixelOffset = tileCode * 64 + py * 8 + px;
  ppu.vram[pixelOffset * 2 + 1] = colorIdx & 0xFF;
}

// ─── 1. Identity 1:1 matrix mapping ──────────────────────────────────────────
function testMode7IdentityMapping() {
  const ppu = makePPU();

  // World pixel (0,0) is in tile (0,0), sub-pixel (0,0)
  // tileCode at tile(0,0) = 1; pixel(0,0) in tile 1 = colorIdx 7
  setM7TileCode(ppu, 0, 0, 1);
  setM7Pixel(ppu, 1, 0, 0, 7);
  setCgramColor(ppu, 7, 31, 0, 0); // red

  ppu.zBuffer.fill(0);
  ppu.renderMode7(0); // line 0

  const expectedColor = ppu.getColor(7) >>> 0;
  // sx=0 → output indices 0,1 (pixel-doubled)
  assert((ppu.frameBuffer[0] >>> 0) === expectedColor,
    `identity: screen(0,0) → world(0,0) → tileCode=1 pixel(0,0)=7 → red (o0)`);
  assert((ppu.frameBuffer[1] >>> 0) === expectedColor,
    `identity: screen(0,0) → world(0,0) → tileCode=1 pixel(0,0)=7 → red (o1)`);
  assert(ppu.zBuffer[0] === 15, 'identity: z=15 written to zBuffer (o0)');
  assert(ppu.zBuffer[1] === 15, 'identity: z=15 written to zBuffer (o1)');
  assert(ppu.layerBuffer[0] === 1, 'identity: layerBuffer=1 (BG1) (o0)');
  assert(ppu.layerBuffer[1] === 1, 'identity: layerBuffer=1 (BG1) (o1)');

  // World pixel (5,0): tile(0,0), sub-pixel(5,0) → colorIdx 3
  setM7Pixel(ppu, 1, 5, 0, 3);
  setCgramColor(ppu, 3, 0, 31, 0); // green

  ppu.zBuffer.fill(0);
  ppu.renderMode7(0);

  const green = ppu.getColor(3) >>> 0;
  // sx=5 → output indices 10,11 (pixel-doubled)
  assert((ppu.frameBuffer[10] >>> 0) === green,
    'identity: screen(5,0) → sub-pixel(5,0)=3 → green (o0)');
  assert((ppu.frameBuffer[11] >>> 0) === green,
    'identity: screen(5,0) → sub-pixel(5,0)=3 → green (o1)');
}

// ─── 2. Transparent pixel (colorIdx=0) not drawn ─────────────────────────────
function testMode7Transparent() {
  const ppu = makePPU();

  // tileCode 1 pixel(0,0) = 0 (transparent)
  setM7TileCode(ppu, 0, 0, 1);
  setM7Pixel(ppu, 1, 0, 0, 0);

  ppu.frameBuffer[0] = 0xABCD1234;
  ppu.frameBuffer[1] = 0xABCD1234;
  ppu.zBuffer.fill(0);
  ppu.renderMode7(0);

  assert((ppu.frameBuffer[0] >>> 0) === (0xABCD1234 >>> 0),
    'transparent pixel: frameBuffer not modified (o0)');
  assert((ppu.frameBuffer[1] >>> 0) === (0xABCD1234 >>> 0),
    'transparent pixel: frameBuffer not modified (o1)');
  assert(ppu.zBuffer[0] === 0, 'transparent pixel: zBuffer stays 0 (o0)');
  assert(ppu.zBuffer[1] === 0, 'transparent pixel: zBuffer stays 0 (o1)');
}

// ─── 3. hScroll translation ───────────────────────────────────────────────────
function testMode7HScroll() {
  const ppu = makePPU();

  // Tile(0,0) pixel(0,0) = 0 (transparent), pixel(8,0) is in tile(1,0) colorIdx=5
  setM7TileCode(ppu, 0, 0, 1);
  setM7TileCode(ppu, 1, 0, 2);
  setM7Pixel(ppu, 1, 0, 0, 0); // tile 1, sub-pixel(0,0) = transparent
  setM7Pixel(ppu, 2, 0, 0, 5); // tile 2, sub-pixel(0,0) = colorIdx 5
  setCgramColor(ppu, 5, 0, 0, 31); // blue

  // With hScroll=8: at sx=0, xx = (0 + 8 - 0)*256>>8 + 0 = 8 → tile(1,0) sub-pixel(0,0)
  ppu.m7hofs = 8; // hScroll = 8 (positive, no sign extension needed)

  ppu.zBuffer.fill(0);
  ppu.renderMode7(0);

  const blue = ppu.getColor(5) >>> 0;
  // sx=0 → output indices 0,1 (pixel-doubled)
  assert((ppu.frameBuffer[0] >>> 0) === blue,
    'hScroll=8: screen(0,0) maps to world(8,0) → tile(1,0) → blue (o0)');
  assert((ppu.frameBuffer[1] >>> 0) === blue,
    'hScroll=8: screen(0,0) maps to world(8,0) → tile(1,0) → blue (o1)');
}

// ─── 4. Repeat mode 2: transparent outside [0..1023] ─────────────────────────
function testMode7RepeatMode2Transparent() {
  const ppu = makePPU();
  // m7sel bits 7-6 = 10 → repeatMode=2 (transparent outside)
  ppu.m7sel = 0x80;

  // hScroll = -1 (m7hofs sign: bit 12 sign extend of 13-bit value)
  // 0x1FFF = 0b001_1111_1111_1111 → bit 12 set → sign extended to -1
  ppu.m7hofs = 0x1FFF; // hScroll = -1

  // With hScroll=-1, cx=0, identity matrix:
  // At sx=0: xx = (0 + (-1) - 0)*256>>8 + 0 = -1 → out of bounds → transparent
  setM7TileCode(ppu, 0, 0, 1);
  setM7Pixel(ppu, 1, 0, 0, 7);
  setCgramColor(ppu, 7, 31, 0, 0);

  ppu.frameBuffer[0] = 0;
  ppu.frameBuffer[1] = 0;
  ppu.zBuffer.fill(0);
  ppu.renderMode7(0);

  assert(ppu.frameBuffer[0] === 0,
    'repeatMode=2: out-of-bounds pixel is transparent (o0)');
  assert(ppu.frameBuffer[1] === 0,
    'repeatMode=2: out-of-bounds pixel is transparent (o1)');
  assert(ppu.zBuffer[0] === 0, 'repeatMode=2: zBuffer stays 0 (o0)');
  assert(ppu.zBuffer[1] === 0, 'repeatMode=2: zBuffer stays 0 (o1)');
}

// ─── 5. Repeat mode 3: use tile 0 outside [0..1023] ─────────────────────────
function testMode7RepeatMode3Tile0() {
  const ppu = makePPU();
  // m7sel bits 7-6 = 11 → repeatMode=3 (tile 0 outside)
  ppu.m7sel = 0xC0;

  // hScroll = -8 (0x1FF8 sign-extended from 13-bit = -8)
  // At sx=0: xx = (0 + (-8))*256>>8 = -8 → out of bounds
  // px = (-8) & 7 = 0, py = 0 & 7 = 0 → pixelOffset = 0*64+0=0 → vram[1]
  ppu.m7hofs = 0x1FF8; // 13-bit signed -8

  // tileCode=0, px=0, py=0: pixelOffset=0; pixel data at vram[0*2+1]=vram[1]
  ppu.vram[1] = 9;
  setCgramColor(ppu, 9, 0, 0, 31); // blue at entry 9

  ppu.zBuffer.fill(0);
  ppu.renderMode7(0);

  const blue = ppu.getColor(9) >>> 0;
  // sx=0 → output indices 0,1 (pixel-doubled)
  assert((ppu.frameBuffer[0] >>> 0) === blue,
    'repeatMode=3: out-of-bounds uses tile 0 → colorIdx=9 → blue (o0)');
  assert((ppu.frameBuffer[1] >>> 0) === blue,
    'repeatMode=3: out-of-bounds uses tile 0 → colorIdx=9 → blue (o1)');
}

// ─── 6. Repeat mode 0: wrap (default) ────────────────────────────────────────
function testMode7WrapMode() {
  const ppu = makePPU();
  ppu.m7sel = 0x00; // repeatMode=0 (wrap)

  // In-bounds pixel still renders correctly.
  ppu.m7hofs = 0; // no scroll, in-bounds
  setM7TileCode(ppu, 0, 0, 3);
  setM7Pixel(ppu, 3, 0, 0, 11);
  setCgramColor(ppu, 11, 15, 15, 15); // mid-gray

  ppu.zBuffer.fill(0);
  ppu.renderMode7(0);

  const gray = ppu.getColor(11) >>> 0;
  // sx=0 → output indices 0,1 (pixel-doubled)
  assert((ppu.frameBuffer[0] >>> 0) === gray,
    'wrapMode: in-bounds pixel renders correctly (o0)');
  assert((ppu.frameBuffer[1] >>> 0) === gray,
    'wrapMode: in-bounds pixel renders correctly (o1)');
}

// ─── 6b. Repeat mode 0: out-of-bounds coordinates wrap into 0..1023 ──────────
function testMode7WrapModeOutOfBounds() {
  const ppu = makePPU();
  ppu.m7sel = 0x00; // repeatMode=0 (wrap)

  // hScroll = -8: at sx=0, xx = (0-8)*256>>8 = -8 (out of [0,1023]).
  // In wrap mode, -8 must wrap to 1024-8=1016 in the 1024x1024 map space,
  // i.e. tile(127,0) sub-pixel(0,0) (1016 = 127*8 + 0).
  ppu.m7hofs = 0x1FF8; // 13-bit signed -8

  setM7TileCode(ppu, 127, 0, 5);
  setM7Pixel(ppu, 5, 0, 0, 13);
  setCgramColor(ppu, 13, 31, 31, 0); // yellow

  ppu.zBuffer.fill(0);
  ppu.renderMode7(0);

  const yellow = ppu.getColor(13) >>> 0;
  // sx=0 → output indices 0,1 (pixel-doubled)
  assert((ppu.frameBuffer[0] >>> 0) === yellow,
    'wrapMode: xx=-8 wraps to 1016 → tile(127,0) sub(0,0) (o0)');
  assert((ppu.frameBuffer[1] >>> 0) === yellow,
    'wrapMode: xx=-8 wraps to 1016 → tile(127,0) sub(0,0) (o1)');
}

// ─── 7. Horizontal flip ───────────────────────────────────────────────────────
function testMode7FlipH() {
  const ppu = makePPU();
  ppu.m7sel = 0x01; // flipH bit

  // Without flipH: screen(0,0) → world(0,0) = tile(0,0) sub-pixel(0,0)
  // With flipH: actualSx = 255 - sx; at sx=255 → actualSx=0 → world(0,0)
  //             at sx=0 → actualSx=255 → world(255,0) = tile(31,0) sub-pixel(7,0)

  // Set tile(0,0) pixel(0,0) = colorIdx 7 (red)
  setM7TileCode(ppu, 0, 0, 1);
  setM7Pixel(ppu, 1, 0, 0, 7);
  setCgramColor(ppu, 7, 31, 0, 0); // red

  // Set tile(31,0) pixel(7,0) = colorIdx 3 (green)
  setM7TileCode(ppu, 31, 0, 2);
  setM7Pixel(ppu, 2, 7, 0, 3);
  setCgramColor(ppu, 3, 0, 31, 0); // green

  ppu.zBuffer.fill(0);
  ppu.renderMode7(0);

  const red   = ppu.getColor(7) >>> 0;
  const green = ppu.getColor(3) >>> 0;

  // With flipH: sx=255 → world(0,0) = red; sx=0 → world(255,0) = green
  // sx=255 → output indices 510,511 (pixel-doubled)
  assert((ppu.frameBuffer[510] >>> 0) === red,
    'flipH: sx=255 → world(0,0) → red (o0)');
  assert((ppu.frameBuffer[511] >>> 0) === red,
    'flipH: sx=255 → world(0,0) → red (o1)');
  // sx=0 → output indices 0,1 (pixel-doubled)
  assert((ppu.frameBuffer[0] >>> 0) === green,
    'flipH: sx=0 → world(255,0) = tile(31,0) sub(7,0) → green (o0)');
  assert((ppu.frameBuffer[1] >>> 0) === green,
    'flipH: sx=0 → world(255,0) = tile(31,0) sub(7,0) → green (o1)');
}

// ─── 8. Scale: a=512 (2× zoom) ──────────────────────────────────────────────
function testMode7Scale2x() {
  const ppu = makePPU();
  // a=512 (2.0 in 8.8 fixed-point), d=512, b=c=0 → 2× zoom
  ppu.m7a = 0x0200; ppu.m7d = 0x0200;

  // With 2× zoom: world x = (sx * 512) >> 8 = sx * 2
  // sx=0 → xx=0; sx=1 → xx=2; sx=2 → xx=4 ...
  // sx=4 → xx=8, which is in tile(1,0) sub-pixel(0,0)

  // Tile(0,0) pixels 0-7: colorIdx=5 (blue)
  setM7TileCode(ppu, 0, 0, 1);
  for (let px = 0; px < 8; px++) setM7Pixel(ppu, 1, px, 0, 5);
  // Tile(1,0) pixels 0-7: colorIdx=7 (red)
  setM7TileCode(ppu, 1, 0, 2);
  for (let px = 0; px < 8; px++) setM7Pixel(ppu, 2, px, 0, 7);

  setCgramColor(ppu, 5, 0, 0, 31); // blue
  setCgramColor(ppu, 7, 31, 0, 0); // red

  ppu.zBuffer.fill(0);
  ppu.renderMode7(0);

  const blue = ppu.getColor(5) >>> 0;
  const red  = ppu.getColor(7) >>> 0;

  // sx=0..3 → world x=0..6 → tile(0,0) → blue
  // each sx → output indices 2*sx, 2*sx+1 (pixel-doubled)
  for (let sx = 0; sx < 4; sx++) {
    const o0 = sx * 2, o1 = o0 + 1;
    assert((ppu.frameBuffer[o0] >>> 0) === blue,
      `2× zoom: sx=${sx} → world x=${sx*2} (tile 0) → blue (o0)`);
    assert((ppu.frameBuffer[o1] >>> 0) === blue,
      `2× zoom: sx=${sx} → world x=${sx*2} (tile 0) → blue (o1)`);
  }
  // sx=4 → world x=8 → tile(1,0) → red
  assert((ppu.frameBuffer[8] >>> 0) === red, '2× zoom: sx=4 → world x=8 (tile 1) → red (o0)');
  assert((ppu.frameBuffer[9] >>> 0) === red, '2× zoom: sx=4 → world x=8 (tile 1) → red (o1)');
}

// ─── run ──────────────────────────────────────────────────────────────────────
testMode7IdentityMapping();
testMode7Transparent();
testMode7HScroll();
testMode7RepeatMode2Transparent();
testMode7RepeatMode3Tile0();
testMode7WrapMode();
testMode7WrapModeOutOfBounds();
testMode7FlipH();
testMode7Scale2x();

console.log('PASS: PPU Mode 7 rendering checks');
