import fs from 'fs';
import { SNES } from './src/SNES.js';

const romBuffer = fs.readFileSync('./rom/zelda.sfc');
const snes = new SNES();
snes.loadRom(romBuffer);
for (let f = 0; f < 300; f++) {
    snes.frame();
    if (f % 50 === 0) {
        console.log(`F${f} SNES PC=${snes.cpu.PB.toString(16)}:${snes.cpu.PC.toString(16)} SPC PC=${snes.apu.PC.toString(16)}`);
    }
}
