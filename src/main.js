import './style.css';
import { SNES } from './SNES.js';
import { dumpSpc } from './spc_dump.js';
import { captureState, restoreState } from './SaveState.js';
import { dumpPriorityInfo } from './PriorityDebug.js';

console.log("JSSNES v2.24 (VRAM Address Mapping Fix) Loaded");

document.body.style.visibility = 'visible';

const snes = new SNES();
// Expose globally for browser-console debugging.
globalThis.snes = snes;
globalThis._snesCPU = snes.cpu;
// Debug: call dumpPriorityInfo() from the browser console to dump
// BG/sprite priority info for the current frame (see PriorityDebug.js).
globalThis.dumpPriorityInfo = () => dumpPriorityInfo(snes);
// Debug: call dumpSaveState() from the browser console to download a
// savestate JSON (restorable via restoreState()) plus a PNG screenshot
// of the current frame, for offline bug reports.
globalThis.dumpSaveState = () => {
    const state = captureState(snes);
    const frame = snes.frameCount;
    const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `savestate_f${frame}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    const canvas = document.getElementById('screen');
    if (canvas) {
        const a2 = document.createElement('a');
        a2.href = canvas.toDataURL('image/png');
        a2.download = `screenshot_f${frame}.png`;
        document.body.appendChild(a2);
        a2.click();
        document.body.removeChild(a2);
    }
    console.log(`[dumpSaveState] downloaded savestate_f${frame}.json + screenshot_f${frame}.png`);
};
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
// Crop 16 rows from bottom (SNES CRT overscan area — many games leave this blank)
const DISPLAY_ROWS = 208;
const imageData = ctx.createImageData(512, DISPLAY_ROWS);
// Use 32-bit view for faster pixel manipulation
const buf32 = new Uint32Array(imageData.data.buffer);

let animationFrameId;
let running = false;
let audioActivatedOnce = false;

const originalLog = console.log;
const originalError = console.error;

console.log = function(...args) {
    // Suppress verbose internal diagnostic logs by default.
    // Re-enable with: globalThis._verbose = true
    if (!globalThis._verbose) {
        const first = args[0];
        if (typeof first === 'string') {
            // Drop bracketed tag logs (e.g. "[APU] ...", "[DSP] ...", "[WRAM] ...", "[HDMA] ..."),
            // ROM/Mapper/Reset boilerplate, and the per-frame emulator-loop trace.
            if (first[0] === '[') return;
            if (first.startsWith('ROM loaded')) return;
            if (first.startsWith('Mapper detection')) return;
            if (first.startsWith('Debug CPU check')) return;
            if (first.startsWith('CPU Reset')) return;
            if (first.startsWith('SMC Header')) return;
            if (first.startsWith('Unimplemented Opcode')) return;
            if (first.startsWith('JSSNES')) return;
        }
    }
    originalLog.apply(console, args);
};

console.error = function(...args) {
    originalError.apply(console, args);
};

function log(msg) { console.log(msg); }

let romLoaded = false;
let romData = null;
let currentRomName = null;
let currentSlot = 0;
let pendingAutoStart = false;

// Try to resume the AudioContext and (once resumed) start emulation. Shared by
// every ROM-loading path so behavior stays consistent regardless of source.
function tryAutoStartAfterLoad() {
    initAudio();
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume().then(() => {
            audioActivatedOnce = true;
            log("AudioContext.resume()自動成功。即エミュ開始。");
            startEmulation();
        }).catch(() => {
            pendingAutoStart = true;
            log("音声有効化後にエミュレーションを開始します。画面をクリックしてください。");
        });
    } else if (audioContext && audioContext.state === 'running') {
        audioActivatedOnce = true;
        log("AudioContext既に有効。即エミュ開始。");
        startEmulation();
    } else {
        pendingAutoStart = true;
        log("音声有効化後にエミュレーションを開始します。画面をクリックしてください。");
    }
}

// --- Q-SAVE / Q-LOAD (quick save-state) -------------------------------------
// 10 slots per ROM (SLOT 0-9), persisted in localStorage so they survive reloads.
const qsaveBtn = document.getElementById('qsaveBtn');
const qloadBtn = document.getElementById('qloadBtn');
const slotSelect = document.getElementById('slotSelect');
qsaveBtn.disabled = true;
qloadBtn.disabled = true;

function qSaveKey() {
    return currentRomName ? `jssnes_qsave_${currentRomName}_slot${currentSlot}` : null;
}

function selectSlot(slot) {
    currentSlot = slot;
    slotSelect.value = String(currentSlot);
    updateSaveStateButtons();
}

slotSelect.addEventListener('change', () => selectSlot(Number(slotSelect.value)));

function showToast(msg) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => toast.classList.remove('visible'), 1800);
}

function updateSaveStateButtons() {
    const key = qSaveKey();
    qsaveBtn.disabled = !romLoaded;
    qloadBtn.disabled = !romLoaded || !key || !localStorage.getItem(key);
    battExportBtn.disabled = !romLoaded;
    battImportBtn.disabled = !romLoaded;
}

function quickSave() {
    const key = qSaveKey();
    if (!romLoaded || !key) return;
    try {
        const state = captureState(snes);
        localStorage.setItem(key, JSON.stringify(state));
        log(`[Q-SAVE] Slot ${currentSlot}: state saved for ${currentRomName} (frame ${state.frameCount}).`);
        showToast(`Quick Save complete (Slot ${currentSlot})`);
    } catch (e) {
        log(`[Q-SAVE] Failed: ${e.message}`);
        showToast('Quick Save failed: ' + e.message);
    }
    updateSaveStateButtons();
}

function quickLoad() {
    const key = qSaveKey();
    if (!romLoaded || !key) return;
    const json = localStorage.getItem(key);
    if (!json) {
        showToast(`No quick-save found in Slot ${currentSlot}`);
        return;
    }
    try {
        const state = JSON.parse(json);
        restoreState(snes, state);
        log(`[Q-LOAD] Slot ${currentSlot}: state restored for ${currentRomName} (frame ${state.frameCount}).`);
        showToast(`Quick Load complete (Slot ${currentSlot})`);
        if (!running && romLoaded) startEmulation();
    } catch (e) {
        log(`[Q-LOAD] Failed: ${e.message}`);
        showToast('Quick Load failed: ' + e.message);
    }
}

qsaveBtn.addEventListener('click', quickSave);
qloadBtn.addEventListener('click', quickLoad);

// --- BATT EXPORT / BATT IMPORT (battery-backed cartridge SRAM) --------------
// Lets the user download the cartridge's battery save (in-game save data,
// e.g. Zelda/Chrono Trigger save files) as a .srm file, and load one back in.
const battExportBtn = document.getElementById('battExportBtn');
const battImportBtn = document.getElementById('battImportBtn');
battExportBtn.disabled = true;
battImportBtn.disabled = true;

function battFileName() {
    if (!currentRomName) return 'battery.srm';
    return currentRomName.replace(/\.[^.]+$/, '') + '.srm';
}

function battExport() {
    if (!romLoaded) return;
    const sram = snes.mmu.sram;
    const blob = new Blob([sram], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = battFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    log(`[BATT EXPORT] Saved ${sram.length} bytes of battery data as ${battFileName()}.`);
    showToast('Battery data exported');
}

function battImport() {
    if (!romLoaded) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.srm,.sav';
    input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        const data = new Uint8Array(await file.arrayBuffer());
        const sram = snes.mmu.sram;
        sram.fill(0);
        sram.set(data.subarray(0, Math.min(data.length, sram.length)));
        log(`[BATT IMPORT] Loaded ${data.length} bytes of battery data from ${file.name}.`);
        showToast('Battery data imported');
    });
    input.click();
}

battExportBtn.addEventListener('click', battExport);
battImportBtn.addEventListener('click', battImport);

// Common path for "we now have ROM bytes, load them and (try to) start".
// `name` is used as the Q-SAVE/Q-LOAD slot key and shown in the log.
function loadRomBytes(bytes, name) {
    if (running) {
        running = false;
        cancelAnimationFrame(animationFrameId);
    }
    romData = bytes;
    currentRomName = name;
    log(`Loaded ROM: ${name} (${romData.length} bytes)`);
    snes.loadRom(romData);
    romLoaded = true;
    updateSaveStateButtons();
    tryAutoStartAfterLoad();
}

// Auto-load a default ROM on startup (development convenience)

// --- Local-directory ROM loading -------------------------------------------
// Lets the user pick a folder on their machine; every recognizable ROM inside
// is shown as a clickable entry in the ROM list (bottom-left), and clicking
// one loads it immediately — no extra "Load" step needed.
const ROM_EXTENSIONS = ['.sfc', '.smc'];
const pickDirBtn = document.getElementById('pickDirBtn');
const romListDiv = document.getElementById('rom-list');

function isRomFile(filename) {
    const lower = filename.toLowerCase();
    return ROM_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function populateRomList(files) {
    romListDiv.innerHTML = '';
    const romFiles = files.filter(f => isRomFile(f.name));
    if (romFiles.length === 0) {
        log('Selected folder contains no .sfc/.smc files.');
        return;
    }
    // アルファベット順・あいうえお順（五十音順）で並べる
    romFiles.sort((a, b) => {
        const an = a.webkitRelativePath || a.name;
        const bn = b.webkitRelativePath || b.name;
        return an.localeCompare(bn, 'ja', { numeric: true, sensitivity: 'base' });
    });
    for (const file of romFiles) {
        const btn = document.createElement('button');
        btn.textContent = file.webkitRelativePath || file.name;
        btn.addEventListener('click', async () => {
            const arrayBuffer = await file.arrayBuffer();
            loadRomBytes(new Uint8Array(arrayBuffer), file.name);
        });
        romListDiv.appendChild(btn);
    }
    log(`Folder loaded: found ${romFiles.length} ROM file(s).`);
}

async function pickDirectoryViaFsAccess() {
    const dirHandle = await window.showDirectoryPicker();
    const files = [];
    for await (const [name, handle] of dirHandle.entries()) {
        if (handle.kind === 'file' && isRomFile(name)) {
            files.push(await handle.getFile());
        }
    }
    populateRomList(files);
}

function pickDirectoryViaFileInput() {
    // webkitdirectory gives us every file under the chosen folder (recursively),
    // which we then filter down to recognizable ROM extensions.
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.addEventListener('change', () => {
        populateRomList(Array.from(input.files));
    });
    input.click();
}

if (pickDirBtn) {
    pickDirBtn.addEventListener('click', async () => {
        // The File System Access API shows a native "Select Folder" dialog
        // (rather than the upload-style picker from <input webkitdirectory>).
        if (window.showDirectoryPicker) {
            try {
                await pickDirectoryViaFsAccess();
            } catch (e) {
                if (e.name !== 'AbortError') {
                    log(`Folder selection failed: ${e.message}`);
                    pickDirectoryViaFileInput();
                }
            }
        } else {
            pickDirectoryViaFileInput();
        }
    });
}

// --- Drag & drop ROM loading ------------------------------------------------
const screenContainer = document.getElementById('screen-container');
if (screenContainer) {
    ['dragenter', 'dragover'].forEach(evt => {
        screenContainer.addEventListener(evt, (e) => {
            e.preventDefault();
            screenContainer.classList.add('drag-over');
        });
    });
    ['dragleave', 'dragend', 'drop'].forEach(evt => {
        screenContainer.addEventListener(evt, (e) => {
            e.preventDefault();
            screenContainer.classList.remove('drag-over');
        });
    });
    screenContainer.addEventListener('drop', async (e) => {
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        if (!isRomFile(file.name)) {
            log(`Dropped file "${file.name}" is not a .sfc/.smc ROM — ignored.`);
            return;
        }
        const arrayBuffer = await file.arrayBuffer();
        loadRomBytes(new Uint8Array(arrayBuffer), file.name);
    });
}


// --- 初回ユーザー操作でのみ音声有効化（resume）する ---
function handleFirstAudioActivation(e) {
    if (audioActivatedOnce) return;
    audioActivatedOnce = true;
    document.getElementById('screen').removeEventListener('click', handleFirstAudioActivation);
    window.removeEventListener('keydown', handleFirstAudioActivation);
    initAudio();
    if (!audioContext) return;
    const afterResume = () => {
        log(`Audio activated: AudioContext resumed. romLoaded=${romLoaded}, pendingAutoStart=${pendingAutoStart}`);
        initAudio();
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume().then(() => {
                audioActivatedOnce = true;
                log("AudioContext.resume()自動成功。即エミュ開始。");
                startEmulation();
            }).catch(() => {
                pendingAutoStart = true;
                log("音声有効化後にエミュレーションを開始します。画面をクリックしてください。");
            });
        } else if (audioContext && audioContext.state === 'running') {
            audioActivatedOnce = true;
            log("AudioContext既に有効。即エミュ開始。");
            startEmulation();
        } else {
            pendingAutoStart = true;
            log("音声有効化後にエミュレーションを開始します。画面をクリックしてください。");
        }
    };
    if (audioContext.state === 'suspended') {
        audioContext.resume().then(afterResume).catch(e => log("Audio resume failed: " + e));
    } else {
        afterResume();
    }
}
document.getElementById('screen').addEventListener('click', handleFirstAudioActivation);
window.addEventListener('keydown', handleFirstAudioActivation);

// --- 通常のキー入力処理 ---
// SNES画面 (canvas#screen) にフォーカスがない間は、キー入力をゲーム側に渡さない
// (ブラウザの他の操作を妨げないようにする)。
window.addEventListener('keydown', (e) => {
    if (document.activeElement !== canvas) return;
    let mask = 0;
    const isControlKey = ['KeyZ', 'KeyA', 'ShiftRight', 'ShiftLeft', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyX', 'KeyS', 'KeyQ', 'KeyW'].includes(e.code);
    if (isControlKey) e.preventDefault();
    switch(e.code) { // Use code for position-based mapping
        case 'KeyZ': mask = 0x8000; break; // B
        case 'KeyA': mask = 0x4000; break; // Y
        case 'ShiftRight': 
        case 'ShiftLeft': mask = 0x2000; break; // Select
        case 'Enter': mask = 0x1000; break; // Start
        case 'ArrowUp': mask = 0x0800; break; // Up
        case 'ArrowDown': mask = 0x0400; break; // Down
        case 'ArrowLeft': mask = 0x0200; break; // Left
        case 'ArrowRight': mask = 0x0100; break; // Right
        case 'KeyX': mask = 0x0080; break; // A
        case 'KeyS': mask = 0x0040; break; // X
        case 'KeyQ': mask = 0x0020; break; // L
        case 'KeyW': mask = 0x0010; break; // R
    }
    if (mask) {
        snes.mmu.joy1 |= mask;
    }
});

window.addEventListener('keyup', (e) => {
    if (document.activeElement !== canvas) return;
    let mask = 0;
    const isControlKey = ['KeyZ', 'KeyA', 'ShiftRight', 'ShiftLeft', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyX', 'KeyS', 'KeyQ', 'KeyW'].includes(e.code);
    if (isControlKey) e.preventDefault();
    switch(e.code) {
        case 'KeyZ': mask = 0x8000; break; // B
        case 'KeyA': mask = 0x4000; break; // Y
        case 'ShiftRight':
        case 'ShiftLeft': mask = 0x2000; break; // Select
        case 'Enter': mask = 0x1000; break; // Start
        case 'ArrowUp': mask = 0x0800; break; // Up
        case 'ArrowDown': mask = 0x0400; break; // Down
        case 'ArrowLeft': mask = 0x0200; break; // Left
        case 'ArrowRight': mask = 0x0100; break; // Right
        case 'KeyX': mask = 0x0080; break; // A
        case 'KeyS': mask = 0x0040; break; // X
        case 'KeyQ': mask = 0x0020; break; // L
        case 'KeyW': mask = 0x0010; break; // R
    }
    if (mask) {
        snes.mmu.joy1 &= ~mask;
    }
});

// スクリーンショット操作 (Ctrl+Shift+4 等) でウィンドウがフォーカスを失うと、
// Shift の keyup イベントがページに届かずボタンが押されたまま(スタック)になる。
// フォーカスが外れたタイミングで入力状態をクリアして解消する。
window.addEventListener('blur', () => {
    snes.mmu.joy1 = 0;
});
// SNES画面からフォーカスが外れた(他要素をクリック/Tab移動など)際も、
// 押しっぱなしのボタンが残らないようにリセットする。
canvas.addEventListener('blur', () => {
    snes.mmu.joy1 = 0;
});


const resetBtn = document.getElementById('resetBtn');

resetBtn.addEventListener('click', () => {
        console.log("[UI] Reset pressed, running=", running);
    if (!running) return;
    snes.reset();
});

// F5 / F8 hotkeys (common emulator convention for quick save/load).
window.addEventListener('keydown', (e) => {
    if (e.code === 'F5') {
        e.preventDefault();
        quickSave();
    } else if (e.code === 'F8') {
        e.preventDefault();
        quickLoad();
    }
});

let audioContext;
let audioProcessor;
let gainNode;
let audioRingL = new Float32Array(65536);
let audioRingR = new Float32Array(65536);
let audioRingRead = 0;
let audioRingWrite = 0;
let audioFrac = 0;

function initAudio() {
    if (audioContext) return;
    try {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioCtor();
        audioProcessor = audioContext.createScriptProcessor(2048, 0, 2);
        gainNode = audioContext.createGain();
        gainNode.gain.value = 2.0; // Boost volume (try 2x, can increase if still too quiet)

        audioProcessor.onaudioprocess = function(e) {
                        console.log(`[Audio] onaudioprocess running=${running} L=${(audioRingWrite-audioRingRead)&65535} gain=${gainNode.gain.value}`);
            const outL = e.outputBuffer.getChannelData(0);
            const outR = e.outputBuffer.getChannelData(1);
            const len = outL.length;
            // The producer (main loop) feeds the ring buffer once per
            // requestAnimationFrame tick, paced by the display's refresh rate,
            // while this consumer drains it on the audio hardware's clock.
            // Those two clocks are never exactly equal (e.g. 59.94Hz/60Hz vs the
            // SNES's true ~60.0988Hz), so a fixed ratio lets the backlog grow or
            // shrink without bound, which is heard as audio falling further and
            // further behind. Nudge the resample ratio by the buffer's deviation
            // from a target occupancy (dynamic rate control) to keep the backlog
            // bounded; the correction is kept small enough to be inaudible.
            const available0 = (audioRingWrite - audioRingRead) & 65535;
            const targetBuffer = 4096;
            const maxCorrection = 0.02;
            let correction = (available0 - targetBuffer) / targetBuffer * 0.1;
            if (correction > maxCorrection) correction = maxCorrection;
            else if (correction < -maxCorrection) correction = -maxCorrection;
            let ratio = (32000.0 / audioContext.sampleRate) * (1 + correction);
            for (let i = 0; i < len; i++) {
                let available = (audioRingWrite - audioRingRead) & 65535;
                if (available > 2) {
                    let idx1 = audioRingRead;
                    let idx2 = (audioRingRead + 1) & 65535;
                    let s1L = audioRingL[idx1];
                    let s2L = audioRingL[idx2];
                    outL[i] = s1L + (s2L - s1L) * audioFrac;
                    let s1R = audioRingR[idx1];
                    let s2R = audioRingR[idx2];
                    outR[i] = s1R + (s2R - s1R) * audioFrac;
                    audioFrac += ratio;
                    while (audioFrac >= 1.0) {
                        audioFrac -= 1.0;
                        audioRingRead = (audioRingRead + 1) & 65535;
                    }
                } else {
                    outL[i] = 0;
                    outR[i] = 0;
                }
            }
            // Debug: Log max amplitude for this buffer
            let maxAbs = 0;
            for (let i = 0; i < outL.length; i++) {
                maxAbs = Math.max(maxAbs, Math.abs(outL[i]), Math.abs(outR[i]));
            }
            if (maxAbs > 0.01) {
                log('[Audio] Buffer max amplitude: ' + maxAbs.toFixed(5));
            }
        };
        audioProcessor.connect(gainNode);
        gainNode.connect(audioContext.destination);
    } catch(e) {
        log("Web Audio exception: " + e.message);
    }
}

function startEmulation() {
    if (running) return;
    if (!romLoaded) {
        log("ROM未読み込みのため開始できません。ROMを選択してください。");
        return;
    }
    running = true;
    log("Starting emulation...");
    
    initAudio();
    if(audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
    }
    
    // Move focus to the canvas so keyboard input is routed to the game
    // immediately, even when emulation was started by clicking a ROM-list
    // button (which would otherwise keep focus on that button and silently
    // drop all keydown events via the canvas-focus guard below).
    canvas.focus();

    try {
        loop();
        log("Emulation loop started.");
    } catch (e) {
        log(`Error starting loop: ${e.message}`);
        running = false;
    }
}

// --- Gamepad support ---
// Standard gamepad button index → SNES joy1 bitmask
const GAMEPAD_MAP = [
    [0,  0x8000], // A (Cross)   → B
    [1,  0x0080], // B (Circle)  → A
    [2,  0x4000], // X (Square)  → Y
    [3,  0x0040], // Y (Triangle)→ X
    [4,  0x0020], // LB/L1       → L
    [5,  0x0010], // RB/R1       → R
    [8,  0x2000], // Back/Select → Select
    [9,  0x1000], // Start       → Start
    [12, 0x0800], // D-Up        → Up
    [13, 0x0400], // D-Down      → Down
    [14, 0x0200], // D-Left      → Left
    [15, 0x0100], // D-Right     → Right
];
const AXIS_THRESHOLD = 0.5;

function pollGamepad() {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gpMask = 0;
    for (const gp of gamepads) {
        if (!gp) continue;
        for (const [idx, mask] of GAMEPAD_MAP) {
            if (gp.buttons[idx]?.pressed) gpMask |= mask;
        }
        // Left stick
        if (gp.axes[0] < -AXIS_THRESHOLD) gpMask |= 0x0200; // Left
        if (gp.axes[0] >  AXIS_THRESHOLD) gpMask |= 0x0100; // Right
        if (gp.axes[1] < -AXIS_THRESHOLD) gpMask |= 0x0800; // Up
        if (gp.axes[1] >  AXIS_THRESHOLD) gpMask |= 0x0400; // Down
        break; // Player 1のみ
    }
    // キーボード入力と OR して合成
    snes.mmu.joy1 = (snes.mmu.joy1 & ~pollGamepad._gpPrev) | gpMask;
    pollGamepad._gpPrev = gpMask;
}
pollGamepad._gpPrev = 0;

window.addEventListener('gamepadconnected', (e) => {
    log(`[Gamepad] コントローラ接続: ${e.gamepad.id}`);
});
window.addEventListener('gamepaddisconnected', (e) => {
    log(`[Gamepad] コントローラ切断: ${e.gamepad.id}`);
    snes.mmu.joy1 &= ~pollGamepad._gpPrev;
    pollGamepad._gpPrev = 0;
});

let frames = 0;
function loop() {
        console.log("[EMU] loop running=", running, "frame=", frames);
    if (!running) return;

    try {
        pollGamepad();
        // Run one frame (~60Hz)
        globalThis._snesFrame = frames;
        snes.frame();
        
        // Audio hookup
        const audioData = snes.getAudioSamples();
        if (audioData) {
            // Write to ring buffer
            for (let i = 0; i < audioData.left.length; i++) {
                // Drop if full
                if (((audioRingWrite + 1) & 65535) === audioRingRead) break;
                
                audioRingL[audioRingWrite] = audioData.left[i];
                audioRingR[audioRingWrite] = audioData.right[i];
                audioRingWrite = (audioRingWrite + 1) & 65535;
            }
        }
        
        // Copy PPU buffer to canvas (first DISPLAY_ROWS rows only)
        buf32.set(snes.ppu.frameBuffer.subarray(0, 512 * DISPLAY_ROWS));
        ctx.putImageData(imageData, 0, 0);

        frames++;
        if (frames % 60 === 0 || frames < 120) {
            const pc = snes.cpu.PC.toString(16).toUpperCase().padStart(4, '0');
            const pb = snes.cpu.PB.toString(16).toUpperCase().padStart(2, '0');
            const inidisp = snes.ppu.inidisp.toString(16).padStart(2, '0');
            const bgmode = snes.ppu.bgmode.toString(16);
            const tm = snes.ppu.tm.toString(16).padStart(2, '0');
            const stopped = snes.cpu.stopped ? ' STOPPED!' : '';
            log(`Frame ${frames} | PC: ${pb}:${pc} | INIDISP: ${inidisp} | MODE: ${bgmode} | TM: ${tm}${stopped}`);
        }
        // Detect stuck CPU (same PC for 3 seconds)
        if (frames % 180 === 0) {
            const curPC = (snes.cpu.PB << 16) | snes.cpu.PC;
            if (loop._lastPC === curPC) {
                log(`[WARN] CPU appears stuck at PC: ${snes.cpu.PB.toString(16).padStart(2,'0')}:${snes.cpu.PC.toString(16).padStart(4,'0')} for 3s | stopped=${snes.cpu.stopped} waiting=${snes.cpu.waiting}`);
            }
            loop._lastPC = curPC;
            log(`[DIAG] nmitimen=0x${snes.mmu.nmitimen.toString(16)} INIDISP=0x${snes.ppu.inidisp.toString(16)} PC=${snes.cpu.PB.toString(16).padStart(2,'0')}:${snes.cpu.PC.toString(16).padStart(4,'0')} waiting=${snes.cpu.waiting}`);
        }
        
        animationFrameId = requestAnimationFrame(loop);
    } catch (e) {
        log(`Runtime Error: ${e.message}`);

        // Automatically download a savestate + screenshot at the moment of
        // the crash, so it can be attached to a bug report for offline
        // root-cause analysis (before the canvas is overwritten below).
        try {
            globalThis.dumpSaveState();
        } catch (dumpErr) {
            console.error('[dumpSaveState on crash] failed:', dumpErr);
        }

        // Draw Red Screen of Death
        ctx.fillStyle = "red";
        ctx.fillRect(0, 0, 512, DISPLAY_ROWS);
        ctx.fillStyle = "white";
        ctx.fillText("CRASH: " + e.message, 10, 20);

        running = false;
        console.error(e);
    }
}

// ---- Browser-console debug helpers ----------------------------------------
// Port-log control: start/stop CPU->APU port-write recording and dump SPC.
globalThis._portLog = [];
globalThis._portLogEnabled = false;
globalThis.portLogStart = () => { globalThis._portLog.length = 0; globalThis._portLogEnabled = true; console.log('[portLog] start'); };
globalThis.portLogStop  = () => { globalThis._portLogEnabled = false; console.log('[portLog] stop:', globalThis._portLog.length, 'events'); };
globalThis.portLogDump  = (count = 200) => {
    const arr = globalThis._portLog;
    const slice = arr.slice(Math.max(0, arr.length - count));
    console.table(slice.map(([fr,p,v,pc]) => ({frame:fr, port:p, val:'$'+v.toString(16).padStart(2,'0'), cpuPC:'$'+pc.toString(16).padStart(6,'0')})));
    return slice;
};
globalThis.portLogSave = (name = 'portlog.json') => {
    const blob = new Blob([JSON.stringify(globalThis._portLog)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
    originalLog('[portLogSave]', name, globalThis._portLog.length, 'events');
};

// SPC snapshot download.
globalThis.spcDump = (name = 'snapshot.spc') => {
    try {
        const buf = dumpSpc(snes.apu);
        const blob = new Blob([buf], {type:'application/octet-stream'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
        originalLog('[spcDump]', name, buf.length, 'bytes  apuPC=$'+snes.apu.PC.toString(16), 'cpuP=', [...snes.apu.cpuPorts].map(v=>v.toString(16)));
        return buf.length;
    } catch (e) {
        originalLog('[spcDump] ERROR', e);
        throw e;
    }
};
