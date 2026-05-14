import { SNES } from './SNES.js';

console.log("JSSNES v2.24 (VRAM Address Mapping Fix) Loaded");

const snes = new SNES();
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const imageData = ctx.createImageData(256, 224);
// Use 32-bit view for faster pixel manipulation
const buf32 = new Uint32Array(imageData.data.buffer);

let animationFrameId;
let running = false;
let audioActivatedOnce = false;

// Patch console to output to debug div
const originalLog = console.log;
const originalError = console.error;
const debugDiv = document.getElementById('debug');

function logToDiv(msg, isError) {
    if (debugDiv) {
        const line = document.createElement('div');
        line.textContent = msg;
        if (isError) line.style.color = 'red';
        debugDiv.prepend(line);
        // Only keep last 20 lines to prevent memory issues 
        if (debugDiv.childNodes.length > 20) debugDiv.lastChild.remove();
    }
}

console.log = function(...args) {
    originalLog.apply(console, args);
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' '); 
    logToDiv(msg, false);
};

console.error = function(...args) {
    originalError.apply(console, args);
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
    logToDiv(msg, true);
};

function log(msg) { console.log(msg); }

let romLoaded = false;
let romData = null;
let pendingAutoStart = false;

document.getElementById('romInput').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const arrayBuffer = await file.arrayBuffer();
    romData = new Uint8Array(arrayBuffer);
    log(`Loaded ROM: ${file.name} (${romData.length} bytes)`);
    snes.loadRom(romData);
    romLoaded = true;
    log(`[ROMロード] romLoaded=${romLoaded}, audioActivatedOnce=${audioActivatedOnce}`);
    // 自動でAudioContext.resume()を試みる
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
});

// Auto-load rom/zelda.smc if available (Development convenience)
async function loadDefaultRom(romPath = './rom/super_mario_world.smc') {
    // Stop current emulation before loading new ROM
    if (running) {
        running = false;
        cancelAnimationFrame(animationFrameId);
    }
    try {
        const romName = romPath.split('/').pop();
        log(`Attempting to auto-load ${romPath}...`);
        const response = await fetch(romPath);
        if (!response.ok) {
            log(`Auto-load failed: ${response.status} ${response.statusText}`);
            return;
        }
        const arrayBuffer = await response.arrayBuffer();
        romData = new Uint8Array(arrayBuffer);
        log(`Auto-Loaded ROM: ${romName} (${romData.length} bytes)`);
        // Debug ROM content
        let hex = "";
        for(let i=0; i<16; i++) hex += romData[i].toString(16).padStart(2,'0') + " ";
        log(`ROM Header [00-0F]: ${hex}`);
        snes.loadRom(romData);
        romLoaded = true;
        // 自動でAudioContext.resume()を試みる
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
    } catch (e) {
        log(`Auto-load error: ${e.message}`);
    }
}
loadDefaultRom();

// Load button for ROM selector
const loadRomBtn = document.getElementById('loadRomBtn');
if (loadRomBtn) {
    loadRomBtn.addEventListener('click', () => {
        loadDefaultRom('./rom/super_mario_world.smc');
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
        // Startボタンを有効化
            if (startBtn) {
                startBtn.disabled = false;
                log("Startボタンを押してください");
            } else {
                // 自動でAudioContext.resume()を試みる
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
    };
    if (audioContext.state === 'suspended') {
        audioContext.resume().then(afterResume).catch(e => log("Audio resume failed: " + e));
    } else {
        afterResume();
    }
}
document.getElementById('screen').addEventListener('click', handleFirstAudioActivation);
window.addEventListener('keydown', handleFirstAudioActivation);

// Startボタンの制御
const startBtn = document.getElementById('startBtn');
if (startBtn) {
    startBtn.disabled = true;
    startBtn.addEventListener('click', () => {
        // 音声有効化されていなければまずresume
        initAudio();
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume().then(() => {
                audioActivatedOnce = true;
                log('AudioContext.resume() (Startボタン)');
                if (romLoaded) startEmulation();
            }).catch(e => log('Audio resume failed: ' + e));
        } else {
            audioActivatedOnce = true;
            if (romLoaded) startEmulation();
        }
    });
    // Startボタンがある場合は自動開始しない（ユーザー操作必須）
    startBtn.disabled = false;
}

// --- 通常のキー入力処理 ---
window.addEventListener('keydown', (e) => {
    // ...existing code...
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


const pauseBtn = document.getElementById('pauseBtn');
const resetBtn = document.getElementById('resetBtn');
const testAudioBtn = document.getElementById('testAudioBtn');

pauseBtn.addEventListener('click', () => {
        console.log("[UI] Pause pressed, running=", running);
    if (!running) return;
    running = !running;
    if (!running) {
        cancelAnimationFrame(animationFrameId);
        pauseBtn.textContent = 'Resume';
    } else {
        pauseBtn.textContent = 'Pause';
        loop();
    }
});

resetBtn.addEventListener('click', () => {
        console.log("[UI] Reset pressed, running=", running);
    if (!running) return;
    snes.reset();
});

testAudioBtn.addEventListener('click', () => {
        console.log("[UI] TestAudio pressed, running=", running);
    if (!running) return;
    initAudio();
    if(audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
    }
    const osc = audioContext.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, audioContext.currentTime); // 440Hz A4
    osc.connect(audioContext.destination);
    osc.start();
    osc.stop(audioContext.currentTime + 0.5); // Play for 0.5 seconds
    log("Test Audio: Played 440Hz tone for 0.5s");
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
            let ratio = 32000.0 / audioContext.sampleRate;
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
    running = true;
    log("Starting emulation...");
    
    initAudio();
    if(audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
    }
    
    try {
        loop();
        log("Emulation loop started.");
    } catch (e) {
        log(`Error starting loop: ${e.message}`);
        running = false;
    }
}

let frames = 0;
function loop() {
        console.log("[EMU] loop running=", running, "frame=", frames);
    if (!running) return;

    try {
        // Run one frame (~60Hz)
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
        
        // Copy PPU buffer to canvas
        buf32.set(snes.ppu.frameBuffer);
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
        
        // Draw Red Screen of Death
        ctx.fillStyle = "red";
        ctx.fillRect(0, 0, 256, 224);
        ctx.fillStyle = "white";
        ctx.fillText("CRASH: " + e.message, 10, 20);
        
        running = false;
        console.error(e);
    }
}
