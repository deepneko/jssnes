import { MMU } from './src/MMU.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function testWramPowerOnState() {
  const first = new MMU();
  const second = new MMU();
  const sampleAddresses = [0x0000, 0x0001, 0x0101, 0x2980, 0x7FFF, 0xFFFF, 0x1FFFF];

  const firstValues = sampleAddresses.map((address) => first.wram[address]);
  const secondValues = sampleAddresses.map((address) => second.wram[address]);

  assert(firstValues.every((value) => value !== 0), 'WRAM power-on state must not be zero-filled');
  assert(
    firstValues.join(',') === secondValues.join(','),
    'WRAM power-on state must be deterministic across MMU instances',
  );
}

testWramPowerOnState();

console.log('PASS: WRAM power-on state checks');