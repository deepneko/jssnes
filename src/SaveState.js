// Quick-save / quick-load state serialization.
//
// Strategy: walk each component's own primitive / TypedArray / flat-array
// fields generically (snapshotFlat/restoreFlat), and explicitly stitch
// together the few nested structures (CPU.P, MMU.dma, APU.timers, DSP.voices)
// that are plain-data sub-objects. Cross-component references (mmu.ppu,
// cpu.bus, dsp.apu_ram, ...) are never touched: restore writes data into the
// existing instances in place, so the wiring set up by `new SNES()` stays intact.

const TYPED_ARRAY_CTORS = {
    Uint8Array, Int8Array, Uint16Array, Int16Array,
    Uint32Array, Int32Array, Float32Array, Float64Array,
};

function encodeTypedArray(ta) {
    const bytes = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return { __ta: ta.constructor.name, b64: btoa(binary) };
}

function decodeTypedArray(enc) {
    const binary = atob(enc.b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const Ctor = TYPED_ARRAY_CTORS[enc.__ta];
    return new Ctor(bytes.buffer);
}

function snapshotFlat(obj, skip = []) {
    const out = {};
    for (const k of Object.keys(obj)) {
        if (skip.includes(k)) continue;
        const v = obj[k];
        const t = typeof v;
        if (t === 'number' || t === 'string' || t === 'boolean' || v === null) {
            out[k] = v;
        } else if (ArrayBuffer.isView(v)) {
            out[k] = encodeTypedArray(v);
        } else if (Array.isArray(v) && v.every(e => e === null || (typeof e !== 'object' && typeof e !== 'function'))) {
            out[k] = v.slice();
        }
    }
    return out;
}

function restoreFlat(obj, data) {
    for (const k of Object.keys(data)) {
        const v = data[k];
        const cur = obj[k];
        if (v && typeof v === 'object' && v.__ta) {
            const decoded = decodeTypedArray(v);
            if (ArrayBuffer.isView(cur)) cur.set(decoded);
            else obj[k] = decoded;
        } else if (Array.isArray(cur) && Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) cur[i] = v[i];
        } else {
            obj[k] = v;
        }
    }
}

// PPU per-line render scratch buffers are fully rebuilt every frame; skip them.
const PPU_SKIP = ['frameBuffer', 'zBuffer', 'layerBuffer', 'objBuffer', 'objPrioBuffer', 'objPalHighBuffer'];
// MMU references to other components, plus the (immutable) loaded ROM image.
const MMU_SKIP = ['ppu', 'apu', 'rom', 'dma'];
// APU: dsp/bootRom are handled separately (dsp recursively, bootRom is constant); timers handled explicitly.
const APU_SKIP = ['dsp', 'bootRom', 'timers'];
// DSP: apu_ram aliases apu.ram (relinked already); gauss is a constant table;
// sample buffers are transient audio scratch space; voices handled explicitly.
const DSP_SKIP = ['apu_ram', 'gauss', 'sampleBufferL', 'sampleBufferR', 'voices'];

export function captureState(snes) {
    const dsp = snes.apu.dsp;
    return {
        version: 1,
        frameCount: snes.frameCount || 0,
        cpu: { ...snapshotFlat(snes.cpu, ['bus', 'P']), P: snapshotFlat(snes.cpu.P) },
        ppu: snapshotFlat(snes.ppu, PPU_SKIP),
        mmu: { ...snapshotFlat(snes.mmu, MMU_SKIP), dma: snes.mmu.dma.map(ch => snapshotFlat(ch)) },
        apu: { ...snapshotFlat(snes.apu, APU_SKIP), timers: snes.apu.timers.map(t => ({ ticks: t.ticks, counter: t.counter })) },
        dsp: { ...snapshotFlat(dsp, DSP_SKIP), voices: dsp.voices.map(v => snapshotFlat(v)) },
    };
}

export function restoreState(snes, state) {
    if (!state || state.version !== 1) throw new Error('Unsupported save-state version');

    snes.frameCount = state.frameCount || 0;

    restoreFlat(snes.cpu, state.cpu);
    restoreFlat(snes.cpu.P, state.cpu.P);

    restoreFlat(snes.ppu, state.ppu);

    restoreFlat(snes.mmu, state.mmu);
    for (let i = 0; i < snes.mmu.dma.length; i++) restoreFlat(snes.mmu.dma[i], state.mmu.dma[i]);

    restoreFlat(snes.apu, state.apu);
    for (let i = 0; i < snes.apu.timers.length; i++) {
        snes.apu.timers[i].ticks = state.apu.timers[i].ticks;
        snes.apu.timers[i].counter = state.apu.timers[i].counter;
    }

    const dsp = snes.apu.dsp;
    // Pull `voices` out before restoreFlat: it's an array of plain snapshot
    // objects, and restoreFlat would otherwise overwrite the live Voice
    // instances in dsp.voices with those plain objects (losing their methods).
    const { voices: voiceStates, ...dspFlat } = state.dsp;
    restoreFlat(dsp, dspFlat);
    for (let i = 0; i < dsp.voices.length; i++) restoreFlat(dsp.voices[i], voiceStates[i]);
    dsp.samplePos = 0;
}
