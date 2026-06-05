#!/usr/bin/env node
// Compare two 128KB WRAM dumps (JS vs reference / Snes9x).
// Usage: node tools/wram_diff.mjs <ref.bin> <js.bin>
//
// Reports:
//   - Total bytes different
//   - Byte ranges with contiguous differences (clustered)
//   - First 60 specific diffs with annotations for well-known CT addresses
//   - Summary buckets ($0000-$01FF zp, $0200-$0FFF, $1000-$1FFF, $2000-$5FFF, etc.)

import { readFileSync } from 'fs';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: wram_diff.mjs <ref.bin> <js.bin>');
  process.exit(1);
}
const [refPath, jsPath] = args;
const ref = readFileSync(refPath);
const js = readFileSync(jsPath);

const N = Math.min(ref.length, js.length);
console.log(`Comparing ${refPath} vs ${jsPath} (${N} bytes)`);

const diffs = [];
for (let i = 0; i < N; i++) {
  if (ref[i] !== js[i]) diffs.push(i);
}
console.log(`\nTotal differing bytes: ${diffs.length} / ${N} (${(diffs.length*100/N).toFixed(2)}%)`);

// Bucket by region
const buckets = [
  ['ZP $0000-$00FF       ', 0x0000, 0x0100],
  ['stack $0100-$01FF    ', 0x0100, 0x0200],
  ['CT state $0200-$0FFF ', 0x0200, 0x1000],
  ['CT vars  $1000-$1FFF ', 0x1000, 0x2000],
  ['CT vars  $2000-$3FFF ', 0x2000, 0x4000],
  ['CT vars  $4000-$7FFF ', 0x4000, 0x8000],
  ['CT vars  $8000-$BFFF ', 0x8000, 0xC000],
  ['$C000-$FFFF          ', 0xC000, 0x10000],
  ['$7F:$0000-$7F:$FFFF  ', 0x10000, 0x20000],
];
console.log('\nDiffs by region:');
for (const [label, lo, hi] of buckets) {
  let c = 0;
  for (let i = lo; i < hi && i < N; i++) if (ref[i] !== js[i]) c++;
  console.log(`  ${label} ${String(c).padStart(6)} / ${hi - lo}`);
}

// Cluster contiguous diffs
const clusters = [];
let cs = -1, ce = -1;
for (const d of diffs) {
  if (cs < 0) { cs = ce = d; continue; }
  if (d <= ce + 8) ce = d;
  else { clusters.push([cs, ce]); cs = ce = d; }
}
if (cs >= 0) clusters.push([cs, ce]);
console.log(`\nClusters (gap ≤ 8): ${clusters.length}`);
console.log('Top 30 clusters by size:');
clusters
  .map(([a, b]) => ({ a, b, sz: b - a + 1 }))
  .sort((x, y) => y.sz - x.sz)
  .slice(0, 30)
  .forEach(c => {
    console.log(`  $${c.a.toString(16).padStart(5,'0')}-$${c.b.toString(16).padStart(5,'0')}  (${c.sz} bytes)`);
  });

// Known CT addresses we care about
const known = {
  0x0117: 'TM-precursor #1',
  0x0121: '?',
  0x0126: 'game state byte',
  0x0127: 'substate',
  0x0152: 'NMI flag',
  0x0158: 'frame counter lo',
  0x0159: 'frame counter hi',
  0x01BB: 'flags',
  0x01BC: 'flags',
  0x01BD: 'flags',
  0x01BE: 'flags',
  0x01BF: 'flags',
  0x0BD7: 'TM precursor (WRAM)',
  0x1DF9: 'state-0 branch flag',
  0xB504: 'TM source',
};
console.log('\nKnown-address checks:');
for (const [a, label] of Object.entries(known).sort((x, y) => +x[0] - +y[0])) {
  const off = +a;
  const r = ref[off], j = js[off];
  const mark = r === j ? '  OK' : '  *** DIFF ***';
  console.log(`  $${off.toString(16).padStart(4,'0')} ref=$${r.toString(16).padStart(2,'0')} js=$${j.toString(16).padStart(2,'0')}  ${label}${mark}`);
}

// First 60 raw diffs
console.log('\nFirst 60 raw diffs:');
diffs.slice(0, 60).forEach(off => {
  console.log(`  $${off.toString(16).padStart(5,'0')}  ref=$${ref[off].toString(16).padStart(2,'0')} js=$${js[off].toString(16).padStart(2,'0')}`);
});
