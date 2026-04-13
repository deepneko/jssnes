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

document.getElementById('romInput').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const arrayBuffer = await file.arrayBuffer();
    const romData = new Uint8Array(arrayBuffer);
    
    log(`Loaded ROM: ${file.name} (${romData.length} bytes)`);
    snes.loadRom(romData);
    
    startEmulation();
});

// Auto-load rom/zelda.smc if available (Development convenience)
async function loadDefaultRom() {
    try {
        log("Attempting to auto-load rom/zelda.smc...");
        const response = await fetch('./rom/zelda.smc');
        if (!response.ok) {
            log(`Auto-load failed: ${response.status} ${response.statusText}`);
            return;
        }
        const arrayBuffer = await response.arrayBuffer();
        const romData = new Uint8Array(arrayBuffer);
        log(`Auto-Loaded ROM: zelda.smc (${romData.length} bytes)`);
        
        // Debug ROM content
        let hex = "";
        for(let i=0; i<16; i++) hex += romData[i].toString(16).padStart(2,'0') + " ";
        log(`ROM Header [00-0F]: ${hex}`);
        
        // Check Vector Manually (LoROM: 7FFC, HiROM: FFFC relative to bank end?)
        // Simple check at end of file? No, vectors are at specific map addresses.
        
        snes.loadRom(romData);
        startEmulation();
    } catch (e) {
        log(`Auto-load error: ${e.message}`);
    }
}
loadDefaultRom();

// Update input state
window.addEventListener('keydown', (e) => {
    console.log("Pressed key:", e.code);
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

document.getElementById('resetBtn').addEventListener('click', () => {
    snes.reset();
});

document.getElementById('pauseBtn').addEventListener('click', () => {
    running = !running;
    if (running) {
        startEmulation();
        document.getElementById('pauseBtn').textContent = 'Pause';
    } else {
        cancelAnimationFrame(animationFrameId);
        document.getElementById('pauseBtn').textContent = 'Resume';
    }
});

function startEmulation() {
    if (running) return;
    running = true;
    log("Starting emulation...");
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
    if (!running) return;

    try {
        // Run one frame (~60Hz)
        snes.frame(); 
        
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
            log(`Frame ${frames} | PC: ${pb}:${pc} | INIDISP: ${inidisp} | MODE: ${bgmode} | TM: ${tm}`);
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
