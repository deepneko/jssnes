import fs from 'fs';
import { SNES } from './src/SNES.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function testChronoTriggerBootNoEarlyBrk() {
  const romPath = './rom/chrono_trigger.sfc';
  assert(fs.existsSync(romPath), 'Chrono Trigger ROM is required at ./rom/chrono_trigger.sfc');

  const snes = new SNES();
  snes.loadRom(fs.readFileSync(romPath));

  const cpu = snes.cpu;
  const origStep = cpu.step.bind(cpu);
  let brk = false;

  cpu.step = function stepHook() {
    if (cpu.PB === 0x00 && cpu.PC === 0xFF18) {
      brk = true;
    }
    return origStep();
  };

  const origWarn = console.warn;
  const origLog = console.log;
  console.warn = (...args) => {
    if (args.join(' ').includes('BRK triggered')) {
      brk = true;
    }
  };
  console.log = () => {};

  const maxFrames = 180;
  for (let frame = 0; frame < maxFrames; frame++) {
    snes.frame();
    if (brk) {
      break;
    }
  }

  console.warn = origWarn;
  console.log = origLog;

  assert(!brk, 'Chrono Trigger boot regression: entered BRK loop before frame 180');
}

testChronoTriggerBootNoEarlyBrk();

console.log('PASS: Chrono Trigger boot regression checks');
