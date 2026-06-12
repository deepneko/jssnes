// Debug helper: dump PPU state needed to diagnose BG/sprite priority issues
// (e.g. "sprite drawn in front of a high-priority BG tile that should be
// drawn on top of it"). Intended to be called from the browser console
// (see main.js: globalThis.dumpPriorityInfo).
//
// This is a READ-ONLY diagnostic tool. It re-runs renderLine() for every
// visible line (idempotent if emulation is paused) so that zBuffer /
// layerBuffer / objBuffer reflect the current VRAM/OAM/CGRAM/register state,
// then cross-references the actual compositing result against an
// independently-computed "expected" BG tilemap entry + z value for every
// pixel where a sprite overlaps a high-priority ("prio=1") BG tile.

import { captureState } from './SaveState.js';

function bgSetup(ppu, bgIndex, mode) {
    let sc, charBase, bpp, paletteOffset, hScroll, vScroll;
    switch (bgIndex) {
        case 1:
            sc = ppu.bg1sc;
            charBase = (ppu.bg12nba & 0x0F) << 13;
            bpp = (mode === 0) ? 2 : ((mode === 3 || mode === 4) ? 8 : 4);
            paletteOffset = 0;
            hScroll = ppu.bg1hofs & 0x3FF;
            vScroll = ppu.bg1vofs & 0x3FF;
            break;
        case 2:
            sc = ppu.bg2sc;
            charBase = (ppu.bg12nba & 0xF0) << 9;
            bpp = (mode === 0 || mode === 4 || mode === 5) ? 2 : 4;
            paletteOffset = (mode === 0) ? 32 : 0;
            hScroll = ppu.bg2hofs & 0x3FF;
            vScroll = ppu.bg2vofs & 0x3FF;
            break;
        case 3:
            sc = ppu.bg3sc;
            charBase = (ppu.bg34nba & 0x0F) << 13;
            bpp = (mode === 0) ? 2 : ((mode === 1) ? 2 : 4);
            paletteOffset = (mode === 0) ? 64 : 0;
            hScroll = ppu.bg3hofs & 0x3FF;
            vScroll = ppu.bg3vofs & 0x3FF;
            break;
        default:
            sc = ppu.bg4sc;
            charBase = (ppu.bg34nba & 0xF0) << 9;
            bpp = 2;
            paletteOffset = 96;
            hScroll = ppu.bg4hofs & 0x3FF;
            vScroll = ppu.bg4vofs & 0x3FF;
            break;
    }
    const screenSize = sc & 3;
    const scBase = (sc & 0xFC) << 9;
    const large = !!((ppu.bgmode >> (3 + bgIndex)) & 1);
    const tileShift = large ? 4 : 3;
    const pageShift = large ? 9 : 8;
    return { scBase, charBase, bpp, paletteOffset, hScroll, vScroll, screenSize, tileShift, pageShift, large };
}

function tileGraphic(ppu, tileIdx, bpp, charBase) {
    const rows = [];
    for (let ty = 0; ty < 8; ty++) {
        let row = '';
        for (let tx = 0; tx < 8; tx++) row += ppu.getTilePixel(tileIdx, tx, ty, bpp, charBase).toString(16);
        rows.push(row);
    }
    return rows;
}

// Replicates the tilemap lookup + pixel fetch from PPU.renderLayer for a
// single BG layer at a single output pixel (x256 = 0..255, line = 0..223).
function bgPixelAt(ppu, bgIndex, mode, line, x256) {
    const s = bgSetup(ppu, bgIndex, mode);
    const rX = (x256 + s.hScroll) & 0xFFFF;
    const rY = (line + s.vScroll) & 0xFFFF;

    const mapX = rX >> s.pageShift;
    const mapY = rY >> s.pageShift;
    let mapOff = 0;
    if (s.screenSize === 1) mapOff = (mapX & 1) * 2048;
    else if (s.screenSize === 2) mapOff = (mapY & 1) * 2048;
    else if (s.screenSize === 3) mapOff = ((mapY & 1) * 2 + (mapX & 1)) * 2048;

    const tileX = (rX >> s.tileShift) & 0x1F;
    const tileY = (rY >> s.tileShift) & 0x1F;
    const mapAddr = s.scBase + mapOff + (tileY * 32 + tileX) * 2;

    const t1 = ppu.vram[mapAddr & 0xFFFF];
    const t2 = ppu.vram[(mapAddr + 1) & 0xFFFF];
    const entry = (t2 << 8) | t1;

    const tileIdxBase = entry & 0x3FF;
    const palIdx = (entry >> 10) & 7;
    const prio = (entry >> 13) & 1;
    const flipX = (entry >> 14) & 1;
    const flipY = (entry >> 15) & 1;

    let tileIdx = tileIdxBase;
    if (s.large) {
        let subX = (rX >> 3) & 1;
        let subY = (rY >> 3) & 1;
        if (flipX) subX = 1 - subX;
        if (flipY) subY = 1 - subY;
        tileIdx = (tileIdxBase + subY * 16 + subX) & 0x3FF;
    }

    const localX = flipX ? (7 - (rX & 7)) : (rX & 7);
    const localY = flipY ? (7 - (rY & 7)) : (rY & 7);
    const pixelVal = ppu.getTilePixel(tileIdx, localX, localY, s.bpp, s.charBase);
    const opaque = pixelVal !== 0;

    let colorAbgr = null;
    if (opaque) {
        let globalColorIdx;
        if (s.bpp === 8) globalColorIdx = pixelVal;
        else if (s.bpp === 4) globalColorIdx = s.paletteOffset + palIdx * 16 + pixelVal;
        else globalColorIdx = s.paletteOffset + palIdx * 4 + pixelVal;
        colorAbgr = '#' + (ppu.getColor(globalColorIdx) >>> 0).toString(16).padStart(8, '0');
    }

    return {
        bg: bgIndex,
        entry: '0x' + entry.toString(16).padStart(4, '0'),
        tileIdx, tileIdxBase, palIdx, prio,
        flipX: !!flipX, flipY: !!flipY,
        pixelVal, opaque, colorAbgr,
        charBase: '0x' + s.charBase.toString(16),
        scBase: '0x' + s.scBase.toString(16),
        mapAddr: '0x' + (mapAddr & 0xFFFF).toString(16),
        bpp: s.bpp, large: s.large,
        tileGraphic: opaque ? tileGraphic(ppu, tileIdx, s.bpp, s.charBase) : undefined,
    };
}

// z value the real renderer would assign to this BG layer's pixel,
// mirroring the per-mode tables in PPU.renderPass.
function expectedBgZ(bgIndex, mode, bg3Prio, prio) {
    if (mode === 0) {
        const table = { 1: [40, 80], 2: [30, 70], 3: [20, 60], 4: [10, 50] };
        return table[bgIndex] ? table[bgIndex][prio] : null;
    }
    if (mode === 1) {
        if (bgIndex === 1) return prio ? 90 : 60;
        if (bgIndex === 2) return prio ? 80 : 50;
        if (bgIndex === 3) return prio ? (bg3Prio ? 110 : 30) : 10;
        return null;
    }
    // Modes 2-6: only BG1/BG2 participate in the z-table.
    if (bgIndex === 1) return prio ? 60 : 30;
    if (bgIndex === 2) return prio ? 50 : 20;
    return null;
}

function objZTable(mode) {
    return mode === 1 ? [20, 40, 70, 100] : [20, 50, 80, 100];
}

// Dump OAM entries whose bounding box can plausibly be visible on some line
// of the current 256x224 frame (using OBSEL size settings), independent of
// any ROM-specific "off-screen" conventions.
function dumpOAM(ppu) {
    const sizeSel = (ppu.obsel >> 5) & 7;
    let smallW = 8, smallH = 8, largeW = 16, largeH = 16;
    switch (sizeSel) {
        case 0: smallW = 8;  smallH = 8;  largeW = 16; largeH = 16; break;
        case 1: smallW = 8;  smallH = 8;  largeW = 32; largeH = 32; break;
        case 2: smallW = 8;  smallH = 8;  largeW = 64; largeH = 64; break;
        case 3: smallW = 16; smallH = 16; largeW = 32; largeH = 32; break;
        case 4: smallW = 16; smallH = 16; largeW = 64; largeH = 64; break;
        case 5: smallW = 32; smallH = 32; largeW = 64; largeH = 64; break;
        case 6: smallW = 16; smallH = 32; largeW = 32; largeH = 64; break;
        case 7: smallW = 16; smallH = 32; largeW = 32; largeH = 32; break;
    }

    const list = [];
    for (let i = 0; i < 128; i++) {
        const addr = i * 4;
        const xLo = ppu.oam[addr];
        const y = ppu.oam[addr + 1];
        const tile = ppu.oam[addr + 2];
        const attr = ppu.oam[addr + 3];
        const hiByte = ppu.oam[512 + (i >> 2)];
        const shift = (i & 3) * 2;
        const xHi = (hiByte >> shift) & 1;
        const sizeFlag = (hiByte >> (shift + 1)) & 1;

        let x = xLo | (xHi << 8);
        if (x > 255) x -= 512;

        const w = sizeFlag ? largeW : smallW;
        const h = sizeFlag ? largeH : smallH;

        let visible = false;
        for (let line = 0; line < 224; line++) {
            if (((line - y) & 0xFF) < h) { visible = true; break; }
        }
        if (!visible) continue;
        if (x + w <= 0 || x >= 256) continue;

        list.push({
            i, x, y, tile, w, h,
            priority: (attr >> 4) & 3,
            palette: (attr >> 1) & 7,
            page: attr & 1,
            flipX: !!(attr & 0x40),
            flipY: !!(attr & 0x80),
        });
    }
    return list;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function downloadJSON(obj, filename) {
    downloadBlob(new Blob([JSON.stringify(obj)], { type: 'application/json' }), filename);
}

/**
 * dumpPriorityInfo(snes) - call from the browser console while the scene
 * with the suspicious sprite/BG overlap is on screen.
 *
 * - Re-renders all 224 lines so PPU buffers reflect the current frame.
 * - Logs a summary and the full result object to the console.
 * - Downloads a full savestate JSON (reusable with restoreState() in
 *   analysis scripts) and a PNG screenshot of the canvas.
 */
export function dumpPriorityInfo(snes = globalThis.snes) {
    const ppu = snes.ppu;
    const mode = ppu.bgmode & 0x07;
    const bg3Prio = (ppu.bgmode & 0x08) !== 0;

    const activeBgs = (mode === 0) ? [1, 2, 3, 4] : (mode === 7 ? [] : [1, 2, 3]);
    const objZ = objZTable(mode);

    const overlaps = [];
    const suspects = [];

    // zBuffer/layerBuffer/objBuffer/objPrioBuffer are per-line (512-wide)
    // scratch buffers that renderLine() clears and refills on every call,
    // so each line must be analyzed immediately after rendering it.
    for (let line = 0; line < 224; line++) {
        ppu.renderLine(line);
        for (let x256 = 0; x256 < 256; x256++) {
            const fx = x256 * 2;
            if (ppu.objBuffer[fx] === 0 && ppu.objBuffer[fx + 1] === 0) continue;

            const bgs = activeBgs.map(bg => {
                const info = bgPixelAt(ppu, bg, mode, line, x256);
                info.expectedZ = expectedBgZ(bg, mode, bg3Prio, info.prio);
                return info;
            });
            if (!bgs.some(b => b.prio === 1 && b.opaque)) continue;

            const objPriority = ppu.objPrioBuffer[fx];
            const entry = {
                x: x256, y: line,
                layerWon: ppu.layerBuffer[fx],
                zWon: ppu.zBuffer[fx],
                objPriority,
                objExpectedZ: objZ[objPriority],
                objColor: '#' + (ppu.objBuffer[fx] >>> 0).toString(16).padStart(8, '0'),
                bgs,
            };
            overlaps.push(entry);

            // Candidate bug pixels: a sprite is shown (layerWon===5) even
            // though some opaque, prio=1 BG tile has a higher z and should
            // have rendered on top of it per the spec tables.
            if (entry.layerWon === 5 && bgs.some(b => b.prio === 1 && b.opaque && b.expectedZ > entry.zWon)) {
                suspects.push(entry);
            }
        }
    }

    const registers = {
        inidisp: ppu.inidisp, bgmode: ppu.bgmode, mode, bg3Prio,
        mosaic: ppu.mosaic,
        bg1sc: ppu.bg1sc, bg2sc: ppu.bg2sc, bg3sc: ppu.bg3sc, bg4sc: ppu.bg4sc,
        bg12nba: ppu.bg12nba, bg34nba: ppu.bg34nba,
        bg1hofs: ppu.bg1hofs, bg1vofs: ppu.bg1vofs,
        bg2hofs: ppu.bg2hofs, bg2vofs: ppu.bg2vofs,
        bg3hofs: ppu.bg3hofs, bg3vofs: ppu.bg3vofs,
        bg4hofs: ppu.bg4hofs, bg4vofs: ppu.bg4vofs,
        obsel: ppu.obsel,
        tm: ppu.tm, ts: ppu.ts, tmw: ppu.tmw, tsw: ppu.tsw,
        cgwsel: ppu.cgwsel, cgadsub: ppu.cgadsub,
        w1l: ppu.w1l, w1r: ppu.w1r, w2l: ppu.w2l, w2r: ppu.w2r,
        w12sel: ppu.w12sel, w34sel: ppu.w34sel, wobjsel: ppu.wobjsel,
        wbgobj: ppu.wbgobj, wcolmath: ppu.wcolmath,
    };

    const oam = dumpOAM(ppu);

    const result = {
        frame: snes.frameCount,
        registers,
        oam,
        overlapCount: overlaps.length,
        suspectCount: suspects.length,
        suspects,
        overlaps,
    };

    console.log(
        `[PriorityDump] frame=${snes.frameCount} mode=${mode} bg3Prio=${bg3Prio} ` +
        `overlaps(sprite x opaque prio=1 BG)=${overlaps.length} suspects(sprite drawn in front despite BG having higher z)=${suspects.length}`
    );
    if (suspects.length > 0) {
        console.log('[PriorityDump] suspect pixels (x,y):', suspects.map(s => [s.x, s.y]));
    }
    console.log('[PriorityDump] full result (expand to inspect, or run copy(result) for clipboard):', result);

    try {
        const state = captureState(snes);
        downloadJSON(state, `torii_savestate_f${snes.frameCount}.json`);
        console.log(`[PriorityDump] savestate downloaded: torii_savestate_f${snes.frameCount}.json`);
    } catch (e) {
        console.error('[PriorityDump] savestate capture failed:', e);
    }

    try {
        const canvas = document.querySelector('canvas');
        if (canvas) {
            const a = document.createElement('a');
            a.href = canvas.toDataURL('image/png');
            a.download = `torii_screenshot_f${snes.frameCount}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            console.log(`[PriorityDump] screenshot downloaded: torii_screenshot_f${snes.frameCount}.png`);
        }
    } catch (e) {
        console.error('[PriorityDump] screenshot failed:', e);
    }

    return result;
}
