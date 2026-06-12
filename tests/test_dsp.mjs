// test_dsp.mjs — SNES DSP unit tests
// Covers: register read/write, voice volume/pitch, KON/KOFF state machine,
//         FLG soft-reset, GAIN direct mode, ADSR ATTACK→DECAY, RELEASE decay,
//         DIR+srcn address lookup, echo length from EDL.
import { DSP } from '../src/DSP.js';

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

function makeDSP() {
  const dsp = new DSP();
  dsp.setApuRam(new Uint8Array(65536));
  dsp.flg = 0x00; // no mute, no soft reset
  return dsp;
}

// ─── 1. Register read/write ───────────────────────────────────────────────────
function testDspRegisterReadWrite() {
  const dsp = makeDSP();

  // General DSP RAM round-trip (addr not mapped to special field)
  dsp.write(0x10, 0xAB); // Voice 1 reg 0 (volL)
  assert(dsp.ram[0x10] === 0xAB, 'write stores to ram[0x10]');
  // dsp.read(0x10) reads from ram for non-special regs
  assert(dsp.read(0x10) === 0xAB, 'read(0x10)=0xAB');

  // Master volume L (0x0C)
  dsp.write(0x0C, 0x7F);
  assert(dsp.mvolL === 0x7F, 'mvolL=0x7F');

  // Master volume R (0x1C)
  dsp.write(0x1C, 0x40);
  assert(dsp.mvolR === 0x40, 'mvolR=0x40');

  // DIR register (0x5D)
  dsp.write(0x5D, 0x0A);
  assert(dsp.dir === 0x0A, 'dir=0x0A');

  // ESA (echo source addr, 0x6D)
  dsp.write(0x6D, 0x20);
  assert(dsp.esa === 0x20, 'esa=0x20');

  // ENDX clear on write (0x7C)
  dsp.endx = 0xFF;
  dsp.write(0x7C, 0x00);
  assert(dsp.endx === 0, 'write 0x7C clears endx');
}

// ─── 2. Voice volume sign extension ──────────────────────────────────────────
function testVoiceVolumeSignExtension() {
  const dsp = makeDSP();

  // 0x00: volL; sign-extended: 0x80 = -128
  dsp.write(0x00, 0x80); // voice 0 volL
  assert(dsp.voices[0].volL === -128, `volL=0x80 → -128, got ${dsp.voices[0].volL}`);

  // 0x01: volR; 0x7F = +127
  dsp.write(0x01, 0x7F); // voice 0 volR
  assert(dsp.voices[0].volR === 127, 'volR=0x7F → +127');

  // Voice 1 volL: addr 0x10
  dsp.write(0x10, 0xC0); // 0xC0 = -64 when sign-extended
  assert(dsp.voices[1].volL === -64, `voice1 volL=0xC0 → -64, got ${dsp.voices[1].volL}`);
}

// ─── 3. Pitch register (14-bit across two bytes) ─────────────────────────────
function testPitchRegister() {
  const dsp = makeDSP();

  // Voice 0 pitch lo = 0x02 (0xFF), pitch hi = 0x03 (0x1F)
  dsp.write(0x02, 0xAB); // pitch lo
  assert(dsp.voices[0].pitch === 0x00AB, 'pitch after lo write');
  dsp.write(0x03, 0x3F); // pitch hi (only bits 5-0 = 0x3F)
  assert(dsp.voices[0].pitch === 0x3FAB, 'pitch after hi write (hi masked to 6 bits)');

  // High byte clamped to 6 bits: 0x40 → 0x00 after mask & 0x3F
  dsp.write(0x03, 0x40);
  assert(dsp.voices[0].pitch === (0x00 << 8) | 0xAB, 'pitch hi=0x40 masked to 0x00');
}

// ─── 4. KON starts ATTACK state ──────────────────────────────────────────────
function testKonStartsAttack() {
  const dsp = makeDSP();

  // Set up dir table: dir=1 → table at 0x0100; srcn=0 → addr at [0x0100..0x0103]
  dsp.write(0x5D, 0x01);  // dir=1
  dsp.write(0x04, 0);     // srcn=0 (voice 0 reg 4)
  // apu_ram all zeros → decodeOffset=0, brrLoopPtr=0

  dsp.write(0x4C, 0x01);  // KON bit 0 = voice 0
  assert(dsp.voices[0].state === 'ATTACK', 'KON: voice[0].state=ATTACK');
  assert(dsp.voices[0].envx === 0, 'KON: envx reset to 0');
  assert(dsp.voices[0].pitchCounter === 0, 'KON: pitchCounter reset to 0');
}

// ─── 5. KOFF transitions to RELEASE ──────────────────────────────────────────
function testKoffStartsRelease() {
  const dsp = makeDSP();

  // Configure for fast ADSR: adsr1=0xFF (attack rate=31), pitch=0
  dsp.write(0x5D, 0x01);  // dir
  dsp.write(0x05, 0xFF);  // adsr1 = 0xFF (ADSR mode, fastest attack)
  dsp.write(0x06, 0x20);  // adsr2 = 0x20 (sl=1, sustainRate=0)
  dsp.write(0x02, 0x00);  // pitch lo = 0 (no sample advancement)
  dsp.write(0x03, 0x00);  // pitch hi = 0
  dsp.write(0x4C, 0x01);  // KON voice 0

  // 2 steps get through ATTACK into DECAY
  dsp.step(); dsp.step();
  assert(dsp.voices[0].state === 'DECAY', `After 2 ATTACK steps: state=${dsp.voices[0].state}`);
  assert(dsp.voices[0].envx === 0x7FFF, 'After ATTACK: envx=0x7FFF');

  // KOFF
  dsp.write(0x5C, 0x01);  // KOFF voice 0
  assert(dsp.voices[0].state === 'RELEASE', 'KOFF: state=RELEASE');
}

// ─── 6. FLG bit7 (soft reset) prevents step() from running ──────────────────
function testFLGSoftReset() {
  const dsp = makeDSP();
  dsp.flg = 0x80; // soft reset bit

  const before = dsp.counter;
  dsp.step(); // should return early
  assert(dsp.counter === before, 'FLG.bit7=1: step() is a no-op (counter unchanged)');
}

// ─── 7. GAIN direct mode sets envx immediately ───────────────────────────────
function testGainDirectMode() {
  const dsp = makeDSP();

  // adsr1.bit7=0 → GAIN mode; gain=0x3F → mode=1<4 → direct level
  // envx = (0x3F & 0x7F) << 8 = 0x3F00 = 16128
  dsp.write(0x5D, 0x01);
  dsp.write(0x05, 0x00);  // adsr1 = 0x00 (GAIN mode, bit7=0)
  dsp.write(0x07, 0x3F);  // gain = 0x3F (direct level, mode=0x3F>>5=1)
  dsp.write(0x02, 0x00);  // pitch=0
  dsp.write(0x03, 0x00);
  dsp.write(0x4C, 0x01);  // KON

  dsp.step();
  const expected = (0x3F & 0x7F) << 8; // 0x3F00 = 16128
  assert(dsp.voices[0].envx === expected,
    `GAIN direct: envx=0x${dsp.voices[0].envx.toString(16)}, expected 0x${expected.toString(16)}`);

  // Sustained: each subsequent step also sets envx to same value
  dsp.step(); dsp.step();
  assert(dsp.voices[0].envx === expected, 'GAIN direct: envx stable on every step');
}

// ─── 8. ADSR ATTACK → DECAY progression ─────────────────────────────────────
function testAdsrAttackDecay() {
  const dsp = makeDSP();

  // adsr1=0xFF: ADSR mode, attack rate=31 (fastest), decay rate=30 (fastest)
  // adsr2=0x20: sl=1, target=(1+1)*4096=8192
  dsp.write(0x05, 0xFF);  // adsr1
  dsp.write(0x06, 0x20);  // adsr2
  dsp.write(0x02, 0x00); dsp.write(0x03, 0x00); // pitch=0
  dsp.write(0x4C, 0x01);  // KON

  // Step 1: attack rate=31 period=1 → envTick fires → envx += 0x4000 = 16384
  dsp.step();
  assert(dsp.voices[0].state === 'ATTACK', 'After step 1: still ATTACK');
  assert(dsp.voices[0].envx === 0x4000, `Step 1: envx=0x${dsp.voices[0].envx.toString(16)}`);

  // Step 2: envx = 16384 + 0x4000 = 32768 → capped at 0x7FFF, transition to DECAY
  dsp.step();
  assert(dsp.voices[0].state === 'DECAY', `After step 2: state=${dsp.voices[0].state}`);
  assert(dsp.voices[0].envx === 0x7FFF, `Step 2: envx=0x${dsp.voices[0].envx.toString(16)}`);

  // Step 3: decay rate=30 period=2 → envTick doesn't fire yet (counter=1)
  const envAfter2 = dsp.voices[0].envx;
  dsp.step();
  assert(dsp.voices[0].envx === envAfter2, 'Step 3: envx unchanged (decay not fired yet)');

  // Step 4: decay fires → envx -= (0x7FFF>>8)+1 = 127+1 = 128
  dsp.step();
  const expected4 = 0x7FFF - ((0x7FFF >> 8) + 1); // 32767 - 128 = 32639 = 0x7F7F
  assert(dsp.voices[0].envx === expected4,
    `Step 4: envx=0x${dsp.voices[0].envx.toString(16)}, expected 0x${expected4.toString(16)}`);
}

// ─── 9. RELEASE decay per step ───────────────────────────────────────────────
function testReleaseDecayPerStep() {
  const dsp = makeDSP();

  // Fastest ADSR attack to quickly reach DECAY
  dsp.write(0x05, 0xFF);
  dsp.write(0x06, 0x20);
  dsp.write(0x02, 0x00); dsp.write(0x03, 0x00);
  dsp.write(0x4C, 0x01); // KON

  // Advance to DECAY state (takes 2 ATTACK steps)
  dsp.step(); dsp.step(); // now state=DECAY, envx=0x7FFF

  const envxBeforeRelease = dsp.voices[0].envx; // 0x7FFF = 32767

  dsp.write(0x5C, 0x01); // KOFF → RELEASE
  assert(dsp.voices[0].state === 'RELEASE', 'KOFF → RELEASE');

  // Each RELEASE step: envx -= 0x80 (128)
  dsp.step();
  assert(dsp.voices[0].envx === envxBeforeRelease - 0x80,
    `RELEASE step 1: envx=0x${dsp.voices[0].envx.toString(16)}`);

  dsp.step();
  assert(dsp.voices[0].envx === envxBeforeRelease - 0x80 * 2,
    `RELEASE step 2: envx=0x${dsp.voices[0].envx.toString(16)}`);

  // Run until STOP
  for (let i = 0; i < 500; i++) dsp.step();
  assert(dsp.voices[0].state === 'STOP', 'RELEASE → STOP after envx reaches 0');
  assert(dsp.voices[0].envx === 0, 'STOP: envx=0');
}

// ─── 10. DIR + srcn → decodeOffset ───────────────────────────────────────────
function testDirSrcnAddress() {
  const dsp = makeDSP();
  const ram = new Uint8Array(65536);
  dsp.setApuRam(ram);

  // dir=2 → dir table at 0x0200; srcn=3 → entry at 0x0200 + 3*4 = 0x020C..0x020F
  // lo byte = 0x34, hi byte = 0x12 → decodeOffset = 0x1234
  // loop lo = 0x00, loop hi = 0x20 → brrLoopPtr = 0x2000
  ram[0x020C] = 0x34; ram[0x020D] = 0x12;  // start addr lo/hi
  ram[0x020E] = 0x00; ram[0x020F] = 0x20;  // loop addr lo/hi

  dsp.write(0x5D, 0x02);  // dir=2
  dsp.write(0x04, 0x03);  // srcn=3
  dsp.write(0x4C, 0x01);  // KON voice 0

  assert(dsp.voices[0].decodeOffset === 0x1234,
    `decodeOffset=0x${dsp.voices[0].decodeOffset.toString(16)}, expected 0x1234`);
  assert(dsp.voices[0].brrLoopPtr === 0x2000,
    `brrLoopPtr=0x${dsp.voices[0].brrLoopPtr.toString(16)}, expected 0x2000`);
}

// ─── 11. EDL → echoLength ────────────────────────────────────────────────────
function testEchoLength() {
  const dsp = makeDSP();

  // edl=0 → echoLength=1
  dsp.write(0x7D, 0x00);
  assert(dsp.echoLength === 1, 'EDL=0 → echoLength=1');

  // edl=1 → echoLength=512 (1 EDL unit = 2KB = 512 stereo sample-pairs = 16ms)
  dsp.write(0x7D, 0x01);
  assert(dsp.echoLength === 512, 'EDL=1 → echoLength=512');

  // edl=4 → echoLength=2048
  dsp.write(0x7D, 0x04);
  assert(dsp.echoLength === 2048, 'EDL=4 → echoLength=2048');

  // edl=0x0F (max 4-bit) → echoLength=0x0F*512=7680
  dsp.write(0x7D, 0x0F);
  assert(dsp.echoLength === 0x0F * 512, `EDL=0x0F → echoLength=${dsp.echoLength}`);
}

// ─── 12. envRatePeriod static table ──────────────────────────────────────────
function testEnvRatePeriod() {
  // Spot-check the envelope rate period table via DSP internal behavior.
  // We test indirectly: rate 31 = period 1 (fires every step) → ATTACK steps.
  // rate 0 = period 0 (never fires) → envx stays 0 in ATTACK.

  const dsp = makeDSP();
  // adsr1 = 0x80 | 0x00: ADSR mode, attack rate = 0*2+1 = 1 (period=2048)
  dsp.write(0x05, 0x80);  // adsr1: ADSR mode, attack nibble=0 → rate=1
  dsp.write(0x02, 0x00); dsp.write(0x03, 0x00); // pitch=0
  dsp.write(0x4C, 0x01); // KON

  // Rate 1 has period 2048. After 1 step envTick returns false → envx stays 0.
  dsp.step();
  assert(dsp.voices[0].envx === 0,
    `rate=1 (period=2048): no env tick after 1 step, envx=${dsp.voices[0].envx}`);

  // After enough steps to fire once: envx should increase
  for (let i = 1; i < 2048; i++) dsp.step();
  // 2048 total steps: 2048 >= 2048 → fires
  assert(dsp.voices[0].envx > 0, 'rate=1: envx advances after 2048 steps');
}

// ─── run ─────────────────────────────────────────────────────────────────────
testDspRegisterReadWrite();
testVoiceVolumeSignExtension();
testPitchRegister();
testKonStartsAttack();
testKoffStartsRelease();
testFLGSoftReset();
testGainDirectMode();
testAdsrAttackDecay();
testReleaseDecayPerStep();
testDirSrcnAddress();
testEchoLength();
testEnvRatePeriod();

console.log('PASS: DSP checks');
