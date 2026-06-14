# SNES Emulator — Implementation Design Document

## 1. System Architecture

This emulator (JSSNES) is a SNES emulator that runs in a JavaScript environment.
Each call to `SNES.frame()` runs one frame (262 scanlines) worth of CPU/PPU/APU
processing, with each subsystem synchronized at the cycle/scanline level.

### 1.1 Source File Layout

| File | Lines | Role |
|---|---|---|
| `src/SNES.js` | ~190 | Top-level orchestration. Main loop in `frame()` |
| `src/CPU.js` | ~2230 | S-CPU (65816) core. Registers, instruction dispatch, interrupts |
| `src/MMU.js` | ~975 | Memory mapping, DMA/HDMA, ROM mapper detection, DSP-1 integration |
| `src/PPU.js` | ~1210 | Graphics rendering (BG modes, windows, color math, Mode 7, sprites) |
| `src/APU.js` | ~625 | SPC700 sound CPU core |
| `src/DSP.js` | ~595 | Audio synthesis DSP (BRR, ADSR/GAIN, echo) |
| `src/DSP1.js` | ~1190 | DSP-1 math coprocessor (HLE, port of snes9x dsp1.cpp) |
| `src/SaveState.js` | ~120 | Save-state serialization/deserialization |
| `src/PriorityDebug.js` | ~345 | BG/sprite priority debugging tool |
| `src/main.js` | ~690 | UI, canvas rendering, audio output, input, ROM loading |
| `src/spc_dump.js` | ~40 | Debug tool that dumps APU state in `.spc` format |
| `src/APUTable.js` | ~14 | Unused dead code (prototype of an old opcode table) |

### 1.2 Subsystem Overview

- **SNES (Core)**: Overall orchestration, frame-by-frame progress management (`src/SNES.js`)
- **S-CPU (Ricoh 5A22)**: Main CPU (custom 16-bit 65816 core)
- **MMU**: Memory mapping, bus arbitration, DMA/HDMA, DSP-1 coprocessor
- **PPU**: Graphics rendering processor (backgrounds, sprites, windows, Mode 7, etc.)
- **APU / SPC700**: Audio sub-processor
- **DSP**: Sound synthesis and effects (BRR decoding, ADSR, echo, etc.)
- **DSP-1**: Cartridge-resident math coprocessor (HLE, used by Super Mario Kart, etc.)

### 1.3 Main Loop (`SNES.frame()`)

`frame()` runs one frame = 262 scanlines (NTSC assumed). For each scanline:

```js
const scanlinesPerFrame = 262;
const cyclesPerScanline = Math.floor(1364 / 6); // ~227 CPU cycles/line

for (let line = 0; line < scanlinesPerFrame; line++) {
    // line===225: VBlank begins — set the VBlank flag in RDNMI ($4210), reload the
    //             OAM address, and if NMITIMEN ($4200) is enabled set cpu.nmiPending=true;
    //             also run Auto-Joypad reading.
    // line===0:   Clear the VBlank flag, toggle the field (even/odd) flag, and call
    //             initHDMA() if HDMAEN is enabled.

    let lineCycles = 0;
    while (lineCycles < cyclesPerScanline) {
        // H/V-IRQ check (NMITIMEN bits 4/5 = IRQ mode, compared against vtime/htime)
        // HBlank detection (lineCycles>=137 sets hvbjoy |= 0x40)
        const cyclesTaken = this.cpu.step();
        lineCycles += cyclesTaken;

        // Keep the APU following the CPU at a 1024:3580 cycle ratio
        this.apuTargetCycles += cyclesTaken * 1024 / 3580;
        while (this.apu.cycles < this.apuTargetCycles) this.apu.step();

        this.ppu.vcounter = line;
        this.ppu.hcounter = Math.floor(lineCycles * (1364 / cyclesPerScanline));
    }

    if (line < 224) this.ppu.renderLine(line);          // render visible lines only
    if (line < 225 && this.mmu.hdmaen) this.mmu.doHDMA(); // HDMA transfer during H-Blank
}
```

- **NMI**: At line===225, if NMITIMEN bit 7 is set, `cpu.nmiPending=true` is set. The CPU
  side detects this via `checkInterrupts()` after each instruction.
- **IRQ (H/V timer)**: The mode is determined by `NMITIMEN & 0x30` (`0x30` = H+V coincidence,
  `0x20` = V coincidence only, `0x10` = H coincidence only). `vtime`/`htime`
  (`$4209-$420C`) are compared against the current line/dot, and on a match
  `mmu.timeUp=true` and `cpu.irqPending=true` are set.
- **Auto-Joypad read**: At line===225, the bits of `joy1`/`joy2` are copied into
  `$4218-$421F` (`autoJoy[0..7]`).
- **Audio sync**: The APU is advanced toward a target of "CPU cycles × 1024/3580" —
  a loosely coupled, fixed-ratio sync where `apu.step()` is called just enough to
  catch up with however far the CPU has progressed.

---

## 2. S-CPU (Ricoh 5A22 / 65816)

Emulation of the 16-bit 65816 processor (`src/CPU.js`).

### 2.1 Registers and State Management

- `A`/`X`/`Y`/`SP`/`DP`/`PC` are held as 16-bit integers (plain instance fields such as `this.A`).
- `DB` (Data Bank) / `PB` (Program Bank) are 8-bit.
- The status flags `P` are not stored as a bitfield but as an object keyed by flag name:
  ```js
  this.P = { C:0, Z:0, I:1, D:0, X:1, M:1, V:0, N:0, E:1 };
  ```
  `getP()` packs this into a single byte (used by PHP and when pushing during an
  interrupt), and `P_set(val)` restores it from a byte (PLP/RTI). `P_set` also
  enforces 65816 invariants: in emulation mode (`E=1`) it forces `M=1,X=1`, pins
  the high byte of SP to `0x01`, and when `X=1` (8-bit index registers) masks `X`/`Y`
  with `&0xFF`.
- **Switching between 8-bit and 16-bit width** is done per-instruction: each instruction
  handler checks `this.P.M` (A/memory width) or `this.P.X` (X/Y width) and branches
  accordingly when calling `fetchByte()/fetchWord()` or `read()/readWord()`. Registers
  are not physically truncated on every access; instead, each instruction performs
  width-dependent reads/writes.
- `XCE` (`case 0xFB`) swaps the C and E flags, and when entering emulation mode forces
  `M=1,X=1` and pins the high byte of SP to `0x01`.

### 2.2 Instruction Dispatch and Addressing Modes

- `execute(opcode, pc, pb)` is one giant **256-case `switch`** statement (multiple
  opcodes can share a `case`, e.g. `case 0x24: case 0x2C:` handle BIT dp/abs together).
  Unimplemented opcodes fall into `default:`, log an error, and set `this.stopped=true`.
- Addressing modes are implemented as individual helper methods (about 17 in total):
  - `addr_abs`, `addr_absl` (24-bit absolute), `addr_dp`, `addr_dp_ind`, `addr_dp_ind_long`, `addr_dp_ind_long_y`
  - `addr_abs_x`/`addr_abs_y`, `addr_dp_x`/`addr_dp_y`, `addr_dp_ind_x`/`addr_dp_ind_y` (each also has an
    `_info` variant that returns `{addr, pageCrossed}` for page-cross detection)
  - `addr_sr`/`addr_sr_ind_y` (stack-relative addressing)
- Direct-page wraparound is split into two variants: `dpAddrOld` (the 6502-style
  wraparound used in emulation mode when the low byte of DP is zero) and `dpAddrNew`
  (used for `[dp]`-style long-indirect addressing, which does not wrap).
- ALU common logic is factored into helper methods: `adc(val)`, `sbc(val)`,
  `cmp_reg(reg, val, is16bit)`, `setZN(val, is16bit)`. The CMP/CPX/CPY family of
  instructions share `cmp_reg` across all their addressing modes.

### 2.3 Cycle-Counting Model

Rather than a fixed cycle table, `step()` first adds a baseline of `this.cycles++`,
and each `case` then adds its own delta via `this.cycles += N`:

- **Width-dependent increments**: for 16-bit operations, deltas such as
  `cycles += 4 - (this.P.M ? 1 : 0)` adjust for the M flag.
- **Direct-page penalty**: when the low byte of DP is non-zero, add
  `+ ((this.DP & 0xFF) ? 1 : 0)`. This applies to all dp-based addressing modes
  of ADC/SBC/CMP/BIT/CPX/CPY.
- **Page-cross penalty**: based on the `pageCrossed` flag returned by `addr_*_info()`,
  add `+1` depending on the X flag (index register width).
- **Branch instructions** (`branch8`): "not taken = +1, taken = +2, taken with a
  page crossing in emulation mode = +3".
- **MVN/MVP** (`case 0x44/0x54`): implemented as a self-looping instruction that
  consumes one `step()` per byte transferred. For each byte, A is decremented; if
  `A !== 0xFFFF`, `PC -= 3` re-executes the same opcode. Each byte adds
  `cycles += 6` (plus the baseline +1 from `step()`, for a total of 7 cycles per
  byte, matching real hardware).
- **Decimal mode (D flag)**: `adc()`/`sbc()` implement BCD correction paths for both
  8-bit and 16-bit operands. As on real hardware, the V flag is computed from the
  binary result even in decimal mode.

### 2.4 Interrupt Handling

- **Reset** (`reset()`): forces `E=1, M=1, X=1, I=1, D=0, DB=PB=0, SP=0x01FF, DP=0`
  and reads the reset vector from `$FFFC/$FFFD`. If the vector is `0` or `0xFFFF`,
  it throws `Error("Invalid Reset Vector")`.
- **NMI** (`nmi()`) / **IRQ** (`irq()`): push PC (and, in native mode, PB), then the
  packed P, onto the stack, set `P.I=1, P.D=0`, and jump to the vector.
  - NMI: emulation `$FFFA/FFFB`, native `$FFEA/FFEB`
  - IRQ: emulation `$FFFE/FFFF`, native `$FFEE/FFEF`
  - Cost is `P.E ? 7 : 8` cycles. `waiting=false` (wakes from WAI), and the
    corresponding `*Pending` flag is cleared.
- **`checkInterrupts()`**: called once per `step()`, **after** `execute()` (matching
  real hardware, where NMI is sampled at the end of an instruction). NMI is
  unconditionally prioritized; IRQ only fires when `irqPending && !P.I`.
- **WAI** (`0xCB`): sets `this.waiting=true`. While waiting, `checkInterrupts()` is
  run every step, and an IRQ wakes the CPU even if `P.I` is set (matching the WAI
  spec). Each step while waiting consumes 1 cycle.
- **STP** (`0xDB`): sets `this.stopped=true`. After this, `step()` only keeps
  incrementing the cycle count ("time advances but execution is fully halted").
- **BRK** (`0x00`) / **COP** (`0x02`): push PB (native mode)/PC/P, then set
  `D=0,I=1,PB=0`. Vectors are: BRK — native `$FFE6/E7` / emulation `$FFFE/FFFF`;
  COP — native `$FFE4/E5` / emulation `$FFF4/F5`. **If the vector is `0x0000`**, this
  is treated as a fatal error: `this.stopped=true` → `dumpTrace()` →
  `throw new Error("Invalid BRK Vector")`.

### 2.5 Crash Diagnostics (Instruction Trace Buffer)

- `this.trace` is a ring buffer (`traceSize=32`) that, on every `step()`, pushes
  `{pb, pc, op, a, x, y, sp, dp, db, e, m}` (older entries are shifted out once 32
  entries are exceeded).
- `dumpTrace()` dumps the last 32 instructions as a hex dump via `console.error`.
  It is called only when the BRK vector is invalid, as a post-mortem analysis tool.

### 2.6 Notes on Debug Instrumentation

Of the roughly 128 lines that make up the body of `step()`, about 60% (roughly 78
lines) are **ROM-specific debug instrumentation**: one-shot watchpoint logging
(`[WP]`/`[WP-B4]`/`[B4-VISIT]`) keyed off `globalThis._pcVisited` for specific PC
addresses (`$9326`, `$8082`, `$8A0E`, `$935F`, `$938E`, `$8674`, bank 4's
`$DBA0`/`$DB60`/`$DBB6`, `$A0C4`, etc.), plus a stuck-loop detector that prints
`[STUCK]` if the PC stays within a 32-byte range for 2000 consecutive steps. This
is all layered on top of the core functionality (fetch → record trace →
`cycles++` → `execute()` → `checkInterrupts()`) and can be removed.

---

## 3. MMU (Memory Management Unit)

Maps the 24-bit address (Bank + Offset) issued by the S-CPU to physical memory
and I/O (`src/MMU.js`).

### 3.1 Memory Regions

- **WRAM**: `Uint8Array(128 * 1024)` (128KB, mapped contiguously at `$7E0000-$7FFFFF`,
  with the first 8KB mirrored into `$0000-$1FFF` of banks `$00-$3F`/`$80-$BF`).
- **SRAM**: `Uint8Array(128 * 1024)` (cartridge battery-backed RAM).
- **ROM**: a `Uint8Array` set by `loadRom()`.

> **Known regression**: the constructor originally contained a WRAM initialization
> pattern, `for (...) wram[i] = (0x88 + i*17) & 0xFF`, which fixed a Chrono Trigger
> BRK-loop issue by initializing WRAM to non-zero values. This was accidentally
> dropped during a DSP-1-related refactor, so WRAM is currently zero-initialized
> (`test_wram_poweron.mjs` fails; not yet fixed).

### 3.2 ROM Loading and Mapper Detection (`loadRom()`)

1. **Header-strip check**: if `data.length % 1024 === 512`, the first 512 bytes are
   skipped as a copier header.
2. **LoROM/HiROM detection** uses a scoring scheme (`loScore`/`hiScore`):
   - **Header string printability**: `checkHeader()` scores the title region at
     `$7FC0` (LoROM) / `$FFC0` (HiROM) based on the proportion of printable
     (0x20-0x7E) characters.
   - **Map-mode byte**: `rom[0x7FD5] & 0x0F === 0x00` → `loScore += 5`;
     `rom[0xFFD5] & 0x0F === 0x01` → `hiScore += 5`.
   - **Interrupt vector validity**: `countValidVectors(base)` counts how many of
     the NMI/Reset/IRQ vectors (`base+4..+14`) satisfy `0x8000 < vec < 0xFFFF`,
     comparing the LoROM candidate (`$7FE0`) and HiROM candidate (`$FFE0`); the
     better of the two gets `+10`.
   - `this.isHiRom = (hiScore > loScore)` (ties favor LoROM).
3. **DSP-1 detection**: the cart-type byte at `headerBase + 0x16`
   (`headerBase = isHiRom ? 0xFFC0 : 0x7FC0`) is checked; if it is `0x03`
   (ROM+DSP) or `0x05` (ROM+RAM+Battery+DSP), then `this.hasDSP1=true` and
   `this.dsp1 = new DSP1()`.

### 3.3 Address Decoding / Memory Map

`read()`/`write()` split the address into `bank = (addr>>16)&0xFF` and
`offset = addr&0xFFFF`, and check in the following order:

| Address range | Contents |
|---|---|
| `$0000-$1FFF` of banks `00-3F`,`80-BF` | Mirror of the lower 8KB of WRAM |
| All of banks `7E-7F` | WRAM body (`((bank&1)<<16)\|offset`) |
| With DSP-1, `$6000-$7FFF` of banks `00-1F`/`80-9F` | DSP-1 DR/SR ports (see below) |
| LoROM: `(bank&0x7F)<=0x7D` and `offset>=0x8000` | `romAddr = (((bank&0x7F)<<15)\|(offset&0x7FFF)) % rom.length` |
| HiROM: bank `≥0xC0`, or `≥0x80` with `offset≥0x8000`, or `<0x40` with `offset≥0x8000`, or all of `0x40-0x7D` | `romAddr = ((bank&0x3F)<<16)\|offset` |
| `$2000-$5FFF` when `(bank&0x40)===0` | I/O registers (below) |

Main I/O register breakdown:
- `$2100-$213F`: PPU I/O (delegated to `ppu.read/write`)
- `$2140-$217F` (4-byte periodic mirror via `offset&3`): APU communication ports
  (`apu.readCPU/writeCPU`)
- `$2180-$2183`: WMDATA/WMADDL/WMADDH (indirect 17-bit-address WRAM access port;
  `wmaddh<<16|wmaddl` auto-increments while wrapping at `0x1FFFF`)
- `$4016/$4017`: joypad read/strobe
- `$4200`: NMITIMEN, `$4202-$4206`: hardware multiply/divide, `$4207-$420A`: H/V
  timers, `$4210`: RDNMI, `$4211`: TIMEUP, `$4212`: HVBJOY, `$4214-$4217`:
  multiply/divide results, `$4218-$421F`: Auto-Joypad registers
- `$4300-$437F`: DMA/HDMA channel registers

### 3.4 DMA (General-Purpose DMA)

`this.dma[]` is an array of 8 channels, each with the following fields:

- `dmap` (control), `bbad` (destination `$21xx`), `a1t` (16-bit source address),
  `a1b` (source bank), `das` (size / indirect bank), `dasb` (HDMA indirect
  high address)
- HDMA runtime state: `tableAddress`, `tableBank`, `indirectAddress`, `repeat`,
  `doTransfer`, `completed`, `a2a` (line counter), `repeatData[4]`

Writes to `$4300-$437F` map via `channel=(offset>>4)&7`, `reg=offset&0xF` to each
field (reg 0=dmap, 1=bbad, 2/3=a1t low/high, 4=a1b, 5/6=das low/high, 7=dasb,
8/9=a2a low/high).

A write to `$420B` (MDMAEN) triggers `executeDMA()`, which runs `doDMA(i)` for
each channel whose enable bit is set, then clears that bit. `doDMA()`:

- `mode = dmap & 7` decodes into a pattern of B-bus offsets: mode 0 = `[0]`,
  1 = `[0,1]`, 2 = `[0,0]`, 3 = `[0,0,1,1]`, 4 = `[0,1,2,3]`, 5 = `[0,1,0,1]`.
- `direction = dmap & 0x80` (0 = CPU→PPU, 1 = PPU→CPU), `stepDec = dmap & 0x10`,
  `stepFixed = dmap & 0x08`.
- Transfers `count = das || 0x10000` bytes one at a time, advancing
  `workSrcAddr`. When done, `das=0` and `a1t=workSrcAddr`.

### 3.5 HDMA (H-Blank DMA)

**`initHDMA()`** (called at the start of the frame, at line===0, if `hdmaen` is set):
- For each enabled channel, set `tableAddress=a1t`, `tableBank=a1b`, read the
  first byte (the line-count byte) into `a2a`, and advance `tableAddress` by 1.
- `d.repeat = (a2a & 0x80) !== 0`, `a2a &= 0x7F`, `completed = (a2a===0)`.
- **Indirect HDMA** (`dmap` bit 6): if not yet completed, read the next 2 bytes
  (low/high) into `indirectAddress`.
- **Direct REPEAT** (not indirect, and `repeat && !completed`): pre-read
  `nBytes = [1,2,2,4,4,4,2,4][dmap&7]` bytes into `repeatData[]` (advancing the
  table address accordingly). This is the "direct-REPEAT prefetch" implementation
  noted in the project notes.
- Set `doTransfer = true`.

**`doHDMA()`** (called during H-Blank on each visible line):
- For channels where `doTransfer` is true, write to each offset using the same
  mode pattern as `doDMA`:
  - **Indirect**: read from `(dasb<<16)|indirectAddress`, then increment
    `indirectAddress`.
  - **Direct**: if `repeat`, **do not read memory** — instead take the value from
    `repeatData[byteIdx]` (this reproduces the behavior of EACH mode, where a
    value read once is held for the remaining N-1 lines). If `repeat=false`
    (EACH mode), read directly from `(tableBank<<16)|tableAddress` and increment
    `tableAddress`.
- Decrement `a2a`; when it reaches 0, read the next line-count byte, recompute
  `repeat`/`completed`, and (if not yet completed) re-read `indirectAddress` or
  `repeatData[]`.
- If `a2a !== 0`: `doTransfer = d.repeat` — **this is the branch point between
  EACH and REPEAT mode**. In REPEAT mode (bit 7 = 1), `doTransfer` stays `true`
  and the transfer continues every line; in EACH mode (bit 7 = 0), the transfer
  only happens on the line where a new line-count byte was read.

### 3.6 DSP-1 Coprocessor Integration

- On DSP-1-equipped carts, `$6000-$7FFF` of banks `$00-$1F`/`$80-$9F` is intercepted
  as the DSP-1 register port (checked before ROM/SRAM mapping).
- **DR (Data Register, `$6000-$6FFF`)**: read → `dsp1.getByte()`, write →
  `dsp1.setByte(value)`.
- **SR (Status Register, `$7000-$7FFF`)**: reads always return `0x80`
  (Rqm = ready, fixed; not delegated to DSP1). Writes are ignored. This makes
  ROM code that polls SR exit its polling loop immediately.

### 3.7 Notes on Debug Instrumentation

`MMU.js` contains many debug logs under tags such as `[ROM-BUF]`, `[ROM-POST]`,
`[ROM-CHECK]`, `[MMU]`, `[WRAM]`, `[WRAM-141x]`, `[PAL-BUF]`, `[WRAM-PAL0]`,
`[WRAM-WIN]`, `[WWATCH]`, `[DP72]`, `[DP77]`, `[DP15]`, `[13BF]`, `[HDMA]`,
`[HDMA-STATE]`, `[HDMA-ALL]`, `[HDMA-CG]`, `[DMA-CGRAM]`, `[DMA-VRAM]`, etc. Most
are gated behind flags such as `globalThis._dmaLog` / `_wramWatch` / `_forceNav` /
`_navHook` / `_ctMirror7fTo7e`, but ROM-loading logs (`[ROM-BUF]`/`[ROM-POST]`/
`[ROM-CHECK]`, etc.) are unconditional.

---

## 4. PPU (Picture Processing Unit)

Handles graphics rendering (`src/PPU.js`). One frame is 262 scanlines, with
visible lines 0-223.

### 4.1 Internal Memory and the 512px Framebuffer

- **VRAM**: `Uint8Array(64*1024)` (64KB) — tile (character) data and tilemaps
  (BG maps).
- **CGRAM**: `Uint8Array(512)` (256 colors × 2 bytes, BGR555).
- **OAM**: `Uint8Array(544)` (main table: 512 bytes = 4 bytes × 128 sprites; high
  table: 32 bytes = 2 bits × 128 sprites).

To accurately represent the real hardware's high-resolution (512px) output, all
of the framebuffer groups are allocated at **512px width**:

```js
this.frameBuffer      = new Uint32Array(512 * 224); // ABGR
this.zBuffer          = new Uint8Array(512);
this.layerBuffer      = new Uint8Array(512); // 0=Backdrop, 1-4=BG1-4, 5=OBJ
this.objBuffer        = new Uint32Array(512);
this.objPrioBuffer    = new Uint8Array(512);  // OBJ priority 0-3
this.objPalHighBuffer = new Uint8Array(512);  // 1=OBJ palettes 4-7 (color-math eligible)
// subFrameBuffer / subLayerBuffer are similarly 512-wide (allocated on the first
// call to renderLine)
```

- **Non-hi-res content** is pixel-doubled, writing each logical pixel to two
  output columns (`o0=x256*2, o1=o0+1`).
- **Only the hi-res BG layers in Mode 5/6** write 16 native columns directly into
  the 512-wide buffer (section 4.5).

### 4.2 Rendering Pipeline

`renderLine(line)`:
1. Clear `zBuffer`/`layerBuffer` for both the main and sub screens, initializing
   them with the backdrop color.
2. Call `renderPass(line, layers, mode, bg3Prio, outputOffset)` to composite the
   BG layers and sprites (main screen into `frameBuffer`/`layerBuffer`, sub screen
   into `subFrameBuffer`/`subLayerBuffer`).
3. If `cgadsub & 0x3F` is non-zero, call `applyColorMath()`.
4. `applyBrightness()` (the INIDISP `$2100` brightness setting).

### 4.3 BG Modes and Layer Priority (z-Tables)

`renderPass` branches on `mode = bgmode & 0x07` and draws each BG layer via
`renderLayer(line, bgIndex, mode, zLow, zHigh)`. The z-value (priority) tables for
each mode are as follows (higher values are drawn in front):

- **Mode 0**: drawn in the order BG4 → BG3 → BG2 → BG1.
  `BG1=[40,80] BG2=[30,70] BG3=[20,60] BG4=[10,50]`. OBJ z = `[20,50,80,100]`.
- **Mode 1** (the values finalized by the 2026-06-13 sprite-priority fix for the
  torii at Shiren's tower):
  ```js
  let zBg3L = 10, zBg3H = bg3Prio ? 110 : 30;
  let zBg1L = 60, zBg1H = 90;
  let zBg2L = 50, zBg2H = 80;
  ```
  OBJ z = `[20,40,70,100]` (Mode-1-specific). When `bg3Prio` (BGMODE bit 3) is set,
  high-priority BG3 tiles are drawn frontmost (110).
- **Mode 2 / 3-6**: `BG1=[30,60] BG2=[20,50]`. OBJ z = `[20,50,80,100]`.
- **Mode 7**: only `renderMode7(line)` is called (BG1 is fixed at z=15,
  `layerBuffer=1`).

Sprite compositing is common to all modes: for each OBJ pixel, its z-value
(priority 0-3 mapped through the OBJ z-table above) is compared against
`zBuffer[x]` (the current frontmost BG z at that point), and the winner is
written to `frameBuffer`/`layerBuffer`.

### 4.4 Inside `renderLayer`

- **Per-BG parameters**: `scBase` (tilemap base), `charBase` (character data
  base), `bpp`, `paletteOffset`, `hScroll`/`vScroll` are computed. BPP rules: BG1
  is 2bpp in Mode 0, 8bpp in Mode 3/4, and 4bpp otherwise; BG2 is 2bpp in Mode
  0/4/5 and 4bpp otherwise; BG3 is 2bpp in Mode 0/1 and 4bpp otherwise; BG4 is
  always 2bpp.
- **Tile size**: `large = !!((bgmode >> (3+bgIndex)) & 1)` (bit 4 = BG1 ...
  bit 7 = BG4 selects 16x16). When `large`, a 16x16 tile is treated as four 8x8
  sub-tiles, with `tileIdx = tileIdxBase + subY*16 + subX` (subX/subY are mirrored
  according to flipX/flipY).
- **Tilemap lookup**: a page offset determined by `screenSize` (0=32x32, 1=64x32,
  2=32x64, 3=64x64) is added, and the entry is fetched from
  `mapAddr = scBase + mapOff + (tileY*32+tileX)*2`. The entry encodes
  `tileIdxBase` (bits 0-9), `palIdx` (bits 10-12), `prio` (bit 13), `flipX`
  (bit 14), and `flipY` (bit 15).
- **`getTilePixel(tileIdx, x, y, bpp, charBase)`**: `tileAddr = charBase + tileIdx*8*bpp`.
  Bitplanes 0/1 are always read; bitplanes 2/3 (+16 bytes) are added for `bpp>=4`,
  and bitplanes 4-7 (+32/+48 bytes) for `bpp==8`. The bitplanes are combined into
  an 8-bit palette index.
- **`colorFor` closure**: for bpp8, the index is used directly (256-color direct
  mode); for bpp4, `paletteOffset + palIdx*16 + idx`; for bpp2,
  `paletteOffset + palIdx*4 + idx`.
- **OPT (Offset-Per-Tile, Modes 2/4/6)**: pre-reads two rows of the BG3 tilemap
  (`optHRow=(bg3vofs>>3)%g3MRows`, `optVRow=optHRow+1`) and, for each screen column
  (`ci`=0-31), overrides H/V scroll.
  - **BG3 column+1 quirk**: `g3c = ((g3Hofs>>3) + ci + 1) % g3MCols` (note the
    `+1` — this is the real-hardware OPT column-reference behavior, not just `ci`).
  - **Valid bits**: for the H/V entries, `validBit = bgIndex===1 ? 0x2000 : 0x4000`
    (bit 13 = BG1 valid, bit 14 = BG2 valid). If valid, `entry & 0x1FF` is used as
    the scroll value; otherwise it falls back to that layer's global scroll.

### 4.5 Hi-Resolution Mode 5/6 BG Rendering

`hires = (mode===5 && (bgIndex===1 || bgIndex===2)) || (mode===6 && bgIndex===1)`.

Real Mode 5/6 output is 512px wide, with each 8x8 tilemap cell corresponding to a
**16-pixel-wide** region (spanning two consecutive VRAM tiles `tileIdx`,
`tileIdx+1`). In hi-res mode, for each sub-pixel of the 512-wide output
(`within256` = 0 or 1):

```js
let nativeCol = 2 * (rX & 7) + within256;
if (flipX) nativeCol = 15 - nativeCol;
const tile = nativeCol < 8 ? tileIdx : (tileIdx + 1) & 0x3FF;
const lx = nativeCol & 7;
```

i.e. all 16 native columns are written directly to the corresponding output
columns of the 512-wide buffer (with no downsampling/decimation). Non-hi-res BG
layers (and all other layers) instead copy each logical pixel to two output
columns, `o0=x256*2`/`o1=o0+1` (pixel doubling).

> **Known issue (unfixed)**: BG1 (Mode 5 hi-res) on the RS3 character-creation
> screen shows dark vertical bands caused by the `tileIdx+1` scheme above. This
> scheme assumes consecutive VRAM tile placement, but RS3's BG1 tilemap is not
> always sequential (e.g. the `tileIdx` column reads `...,34,12,13,13,14,14,15,...`),
> so `(tileIdx+1)&0x3FF` ends up pointing at an unrelated/blank tile.

### 4.6 Window-Mask System

- **`inWindowRange(x, left, right)`**: a simple inclusive range check,
  `x>=left && x<=right`. A degenerate range (`left>right`) is always `false`
  (no wraparound).

- **BG-layer window evaluation** (inside `renderLayer`'s setup): refers to
  `w12sel=this.wbg12` (`$2123`), `w34sel=this.wbg34` (`$2124`), and
  `wbglog=this.wbgobj` (`$212A`). For BG1:
  ```js
  w1E = (w12sel & 0x01)!==0; w1I = (w12sel & 0x08)===0;
  w2E = (w12sel & 0x04)!==0; w2I = (w12sel & 0x02)===0; logic = wbglog & 0x03;
  ```
  i.e. each BG's corresponding nibble is interpreted as
  `(w1E,w1I,w2E,w2I) = (bit0, !bit3, bit2, !bit1)` (BG2 uses the upper nibble of
  `w12sel`; BG3/BG4 use the lower/upper nibbles of `w34sel`; `logic` is a 2-bit
  field per BG within `wbglog`).
  - Per pixel: `in1 = w1E ? (w1I ? !inWindowRange(...) : inWindowRange(...)) : false`
    (and similarly for `in2`).
  - Combination: if `w1E&&!w2E → masked=in1`; if `!w1E&&w2E → masked=in2`; if both
    are enabled, follow `logic`: **0=AND, 1=OR, 2=XOR, 3=XNOR**.

- **OBJ / color-math window** (a separate block inside `renderPass`): refers to
  `wobjsel=this.wobjsel` (`$2125`) and `wobjlog=this.wcolmath` (`$212B`), using a
  **different bit layout** than the BG case:
  ```js
  w1E = (wobjsel & 0x02)!==0; w1I = (wobjsel & 0x01)!==0;
  w2E = (wobjsel & 0x08)!==0; w2I = (wobjsel & 0x04)!==0;
  logic = wobjlog & 0x03;
  ```
  (i.e. `(bit1,bit0,bit3,bit2)`, with `w1I`/`w2I` used directly without inversion).
  The combination-logic codes are also **reversed relative to the BG case**:
  **0=OR, 1=AND, 2=XOR, 3=XNOR**.

> This formula (`(bit0,!bit3,bit2,!bit1)` plus AND/OR/XOR/XNOR=0/1/2/3) was
> finalized through fixes to RS1's missing terrain masking / border noise issue
> (2026-06-14d) and RS2's BAR-scene full-blackout issue (2026-06-14e, which only
> flipped the polarity of `w2I`). It has been verified against the window
> configurations of RS1, RS3, FF4, SMW, and RS2.

### 4.7 Color Math (`applyColorMath`)

- **CGADSUB (`$2131`)**: bit 7 = subtraction (`isSub`), bit 6 = half color,
  bits 0-5 = enable mask per target layer (Backdrop=bit5, BG1=bit0, BG2=bit1,
  BG3=bit2, BG4=bit3, OBJ palettes 4-7=bit4; OBJ palettes 0-3 are always excluded
  via `objPalHighBuffer`).
- **CGWSEL (`$2130`)**: bits 4-5 = color-math enable condition (0=always disabled,
  1=outside window only, 2=inside window only, 3=always), bits 6-7 = clip
  condition (same pattern), bit 1 = sub-screen-enable flag (when off, the fixed
  COLDATA color is used instead).
- The color-math window reuses the OBJ/color-math window block from section 4.6.
- Math is performed in 5-bit space (`r5=r>>3`, etc.): subtraction clamps at 0,
  addition clamps at 31. Half-color applies `>>1` (skipped when the sub-screen
  pixel is transparent). The fixed COLDATA color is assembled from `$2132`
  (`coldataR/G/B`).

### 4.8 Mode 7

Registers: `m7a/b/c/d` (`$211B-$211E`, 16-bit signed), `m7x/m7y` (`$211F/$2120`,
center coordinates, 13-bit signed), `m7hofs/m7vofs` (`$210D/$210E`).

Per-pixel coordinate transform:
```js
let xx = ((actualSx+hScroll-cx)*a + (actualSy+vScroll-cy)*b) >> 8; xx += cx;
let yy = ((actualSx+hScroll-cx)*c + (actualSy+vScroll-cy)*d) >> 8; yy += cy;
```

**Map-wrap fix** (2026-06-13, fixed the breakup of FF4's airship screen):
`let tx = xx & 1023; let ty = yy & 1023;` — the transformed coordinates are always
folded into the 1024x1024 (128x128-tile) map range. This ensures that even with
`repeatMode` (`(m7sel>>6)&3`) 0/1 (wrap), out-of-range tile codes are never read.
`repeatMode===2` (out-of-range is transparent, `pixelColorIdx=0`) and
`repeatMode===3` (out-of-range is tile 0) branch on `isOutOfBounds`, computed from
the un-wrapped `xx`/`yy`, in addition to the wrapped `tx`/`ty`. Output is pixel-doubled
(`o0=sx*2, o1=o0+1`), fixed at z=15, with `layerBuffer=1` (treated as BG1).

### 4.9 Sprites (OBJ)

- OAM: a 512-byte main table (4 bytes per sprite: X-low, Y, tile number,
  attributes) plus a 32-byte high table (1 bit each for the X high bit and the
  size bit, per sprite).
- `nameBase = (obsel&7)<<14`, `page1Offset = (((obsel>>3)&3)+1)<<13` (offset for
  the second character page).
- The size table (`sizeSel=(obsel>>5)&7`) defines 8 small/large size combinations
  (e.g. `sizeSel=0` → 8x8/16x16, `sizeSel=6` → 16x32/32x64 rectangular sizes, etc.).
- Priority = `(attr>>4)&3` (2 bits, 4 levels). Sprites are evaluated from OAM
  index 127 down to 0, and lower indices (processed later) overwrite (i.e. win
  against) `objBuffer`/`objPrioBuffer`/`objPalHighBuffer`.
- `palHigh = ((attr>>1)&7)>=4` indicates use of palettes 4-7, making the sprite
  eligible for color math.

### `PriorityDebug.js` — BG/Sprite Priority Debugging Tool

A read-only diagnostic tool invoked via `globalThis.dumpPriorityInfo()`. It
re-renders all 224 lines to capture `zBuffer`/`layerBuffer`/`objBuffer`/
`objPrioBuffer`, and for every pixel where a sprite was drawn, it independently
re-implements `bgPixelAt` (a tilemap lookup + reimplementation of `getTilePixel`)
and `expectedBgZ`/`objZTable` (reproducing the z-tables from section 4.3) to
recompute "which BG tile should have won". If `layerWon===5` (sprite won) and an
opaque, priority=1 BG tile's `expectedZ` would have exceeded it, the pixel is
flagged as a `suspect`, and a savestate JSON plus a screenshot PNG are downloaded
via the browser.

---

## 5. APU (SPC700 Coprocessor) & DSP

The audio subsystem, which runs independently of the main CPU (`src/APU.js`,
`src/DSP.js`).

### 5.1 SPC700 Core (`APU.js`)

- **Memory**: a single `Uint8Array(64*1024)` address space. The 64-byte IPL boot
  ROM is mapped at `$FFC0-$FFFF` while `control` (`$F1`) bit 7 is set.
- **I/O ports (`$00F0-$00FF`)**:
  - **CPU communication**: main CPU `$2140-$2143` ↔ SPC `$00F4-$00F7`. `apuPorts[]`
    (SPC→CPU direction; values the SPC writes to `$F4-F7` are read by the CPU via
    `readCPU`) and `cpuPorts[]`/`cpuPortsLatch[]` (CPU→SPC direction; values the CPU
    writes via `writeCPU` are read by the SPC at `$F4-F7`).
  - Bits 4/5 of `$F1` (CONTROL) zero out the `cpuPorts`/`cpuPortsLatch`/RAM mirrors
    of `$F4/$F5` and `$F6/$F7` respectively (reproducing the IPL handshake ACK
    behavior).
  - All MMIO writes are also mirrored into `ram[addr]` (matching Snes9x's SMP
    implementation).
- **Timers**: `timers[]` (Timer0/1/2), `timerTargets` (writes to `$FA/$FB/$FC`),
  and `counter0/1/2` (read via `$FD/$FE/$FF`, which resets to 0 on read).
  Timer0/1 advance their internal `counter` every 128 APU cycles (≈8kHz), and
  Timer2 every 16 cycles (≈64kHz). When `counter >= target`, the output counter
  increments. A rising edge on timer enable resets `ticks`/`counter`/output counter.
- **Instruction dispatch**: `this.opcodes = new Array(256)`, populated by
  `initOpcodes()` via `OP(code, fn)`, which registers each handler closure bound
  with `.bind(this)`. Each handler directly adds to `this.cycles += N`.
- **DSP integration**: in `step()`, the `delta` cycles of each instruction are
  accumulated into `dspCycles`; once `dspCycles >= 32`, `dsp.step()` is called
  (32 APU cycles corresponds to a 32kHz sample rate).
- **Sync**: `syncToCpuCycles(cpuCycles)` is called from the main loop and loops
  `step()` to maintain an APU:CPU ratio of 1024:3580 (the Snes9x approach).
- **Reset**: clears RAM/ports, sets `PC=0xFFC0` (the IPL ROM entry point),
  `A=X=Y=0, SP=0xEF, PSW=0x02` (Z flag set), and `control=0x80`.

> `APUTable.js` (14 lines) is an early prototype of a table-driven opcode
> implementation and is currently **unused dead code** (not imported anywhere).

### 5.2 DSP (`DSP.js`)

- **Voices (8ch)**: each `Voice` instance holds `volL/volR`, `pitch` (14-bit),
  `srcn`, `adcr` (ADSR1+ADSR2), `gain`, `envx/outx`,
  `state` (`'STOP'|'ATTACK'|'DECAY'|'SUSTAIN'|'RELEASE'`), BRR decode state
  (`decodeOffset`, `brrLoopPtr`, `decoded` (Int32Array(16)), `decodeIdx`,
  `s1/s2` filter history), interpolation buffers `history` (Int32Array(4)) /
  `historyIdx`, `pitchCounter`, and `envCounter`.

- **BRR decoding** (`decodeBRR`): a 9-byte block (1 header byte + 8 data bytes =
  16 nibbles). The header gives `shift` (bits 4-7), `filter` (bits 2-3),
  `isEnd` (bit 0), and `isLoop` (bit 1). Each nibble is sign-extended, then
  `sample = (n<<shift)>>1` (when `shift<=12`; otherwise clamped to `±2048`).
  Filter formulas:
  - filter1: `sample += s1 + ((-s1)>>4)`
  - filter2: `sample += s1*2 + ((-s1*3)>>5) - s2 + (s2>>4)`
  - filter3: `sample += s1*2 + ((-s1*13)>>6) - s2 + ((s2*3)>>4)`

  The result is clamped to a signed 16-bit value. On `isEnd`, the corresponding
  `endx` bit is set; if `isLoop`, decoding loops back to `brrLoopPtr`, otherwise
  `state='STOP'`.

- **ADSR/GAIN envelope** (`Voice.stepEnvelope`): **the KOF (key-off, register
  `0x5C`) check happens at the very top of the function** — if `state==='RELEASE'`,
  `envx -= 0x80` (transitioning to `STOP` at or below 0) and the function returns
  immediately. This guarantees that after a key-off, the voice always releases at
  a fixed rate (-8/sample) regardless of whether it was in GAIN or ADSR mode
  (fixed 2026-06-13 — this was the root cause of Shiren 2's music dissonance,
  caused by KOF being ignored).
  - GAIN mode (`adsr1&0x80===0`): `mode=gain>>5`. Modes 0-3 set the value directly;
    4 = linear decrease (-0x200); 5 = exponential decrease (`-(envx>>8)-1`);
    6 = linear increase (+0x200); 7 = bent-line increase
    (below `0x6000`: +0x200, at or above: +0x080).
  - ADSR mode: ATTACK (rate `(adsr1&0xF)*2+1`, moves to DECAY once
    `envx>=0x7FFF`) → DECAY (rate `((adsr1>>4)&7)*2+16`, exponential decrease,
    moves to SUSTAIN once `envx<=(sl+1)<<12`) → SUSTAIN (rate `adsr2&0x1F`,
    exponential decrease continues).

- **Pitch / PMON (pitch modulation)**: `v.pitch` is 14-bit. If bit `i` of the
  `pmon` register is set, voice `i`'s pitch is modulated using the previous
  voice's `outx` (`pmon_pitch`): `pitch += (pitch * (pmon_pitch>>5)) >> 10`.

- **Echo (EDL/ESA/EON/EVOL/EFB/FIR)**: from `edl` (written to `$7D`),
  `echoLength = edl>0 ? edl*512 : 1` (1 EDL unit = 2KB = 512 stereo sample-pairs =
  16ms; fixed on 2026-06-13 to be 4x its previous value — the old implementation
  used `edl*128`, i.e. 4ms units). An 8-tap FIR (`dsp.fir[]`, registers
  `0x0F,0x1F,...,0x7F`) is applied to a ring buffer `echoBuf` (Int32Array(16),
  8 taps × L/R):
  `firL/firR = Σ(echoBuf[...] * fir[fi]) >> 6`, followed by `>>1 & ~1` and a
  16-bit clamp. `efb` (echo feedback) is mixed into the value written back.

- **KON/KOF/register dispatch** (`write(addr,val)`): for `voiceIdx<8 && reg<0x0A`,
  this addresses a per-voice register (`0x00`=volL ... `0x07`=gain). Global
  registers: `0x4C`=KON (sets `state='ATTACK'`, resets various state, and loads
  `decodeOffset`/`brrLoopPtr` from `(dir<<8)+srcn*4`), `0x5C`=KOF (sets any
  non-STOP voice's `state='RELEASE'`), `0x6C`=FLG (includes `noiseRate`),
  `0x7C`=ENDX clear, `0x0D`=EFB, `0x2D`=PMON, `0x3D`=NON, `0x4D`=EON, `0x5D`=DIR,
  `0x6D`=ESA, `0x7D`=EDL, `0x0F..0x7F` (step 0x10)=FIR coefficients.

- **Output**: `sampleBufferL/R` (Float32Array(8192)), `samplePos`. At the end of
  `step()`, after applying master volume and echo, `mOutL/mOutR` (clamped to
  ±32768) are divided by `32768.0` and written as one stereo sample pair (every
  32 APU cycles = 32kHz).

---

## 6. DSP-1 Math Coprocessor (HLE)

`src/DSP1.js` (a port of snes9x's `dsp1.cpp`/`dsp1.h`, an HLE implementation of
the NEC µPD96050-based DSP-1 chip). Used by Super Mario Kart, Pilotwings, etc.

- **Interface**: a byte-stream protocol via `setByte(byte)`/`getByte()`. Bytes
  written by the MMU to DR (`$6000-$6FFF`) correspond to `setByte`, and bytes
  read from DR correspond to `getByte` (SR is fixed at `0x80` on the MMU side, as
  described earlier).
  - `setByte`: while `waiting4command`, the byte is interpreted as a command
    opcode via a large switch that sets the number of parameter words
    (`inCount`, later doubled into bytes) required for each command. Parameters
    accumulate in `parameters[]`, and once `inCount===0`, `_execute()` is called.
    `0x3a/0x2a/0x1a` are aliases of `0x1a`, and `0x17/0x37/0x3f` fall through to
    `0x1f` (firmware dump).
  - `getByte`: outputs from `output[]`. For commands `0x0a`/`0x1a`, the last
    output byte triggers `_rasterStep()` to refill the next 8 bytes (streaming
    Mode 7 raster coefficients). Command `0x1f` streams `DSP1ROM` as 16-bit words.

- **`_execute()` dispatch**: roughly 25 command groups (many `0x00/0x10/0x20/0x30`
  nibble variants alias the same handler):
  - `0x00`/`0x20`: multiply (Multiply / Multiply+1)
  - `0x10`/`0x30`: reciprocal (`dspInverse`)
  - `0x04`/`0x24`: Sin/Cos × radius
  - `0x0a`/`0x1a`: raster (Mode 7 per-scanline coefficient generation;
    `_rasterStep`/`_raster` return `[A,B,C,D]`)
  - `0x02/0x12/0x22/0x32`: parameter setup (Mode 7 projection setup — `CentreX/Y`,
    `VPlane_C/E`, `SinAas/CosAas`, etc.)
  - `0x06/0x16/0x26/0x36`: Project (object coordinates → screen coordinates;
    `_project` returns `[H,V,M]`)
  - `0x0e/0x1e/0x2e/0x3e`: Target (screen coordinates → world coordinates;
    `_target` returns `[X,Y]`)
  - attitude/objective/subjective matrix transforms (`_attitudeMatrix`/
    `_objective`/`_subjective`), 2D/3D rotation (`_polarRotate`), rotation
    angle correction (`_rotationCorrection`)
  - `0x1f`-family: firmware ROM dump (2048 bytes from `DSP1ROM`)

- **Lookup tables**:
  - `DSP1ROM` (`Uint16Array`, ~1024 entries): the real DSP-1's firmware ROM data
    (including Newton's-method initial values for reciprocal computation,
    normalization shift tables, and Sin-table regions).
  - `MUL_TABLE` (`Int16Array[256]`): a multiplicative correction table used by the
    `dspSin`/`dspCos` interpolation.
  - `SIN_TABLE` (`Int16Array[256]`): a sine-curve table.

- **Math helpers**: `dspSin`/`dspCos` (table lookup + linear interpolation),
  `dspInverse` (normalization + fixed-point reciprocal via Newton-Raphson),
  `dspNormalize`/`dspNormalizeDouble` (normalization and shift-count computation
  for 16-bit/32-bit values), and `dspTruncate`/`dspShiftR` (saturating/fixed-point
  shifts). These combine to implement the 3D rotation/projection math used by
  `_attitudeMatrix` and similar commands.

---

## 7. Save States (`src/SaveState.js`)

`captureState(snes)` / `restoreState(snes, state)` implement a "flat field
snapshot" approach for each component.

- **`snapshotFlat(obj, skip)`**: walks `Object.keys(obj)`. Primitive values are
  copied as-is; `TypedArray`s are Base64-encoded via `encodeTypedArray`
  (`{__ta: "Uint8Array", b64: "..."}` format, encoded in 32KB chunks via
  `String.fromCharCode`→`btoa`); plain arrays are copied with `.slice()`.
  Anything else (nested objects, functions, cross-references) is ignored.
- **`restoreFlat(obj, data)`**: restores `__ta` fields via `decodeTypedArray` and
  writes them into the existing arrays with `.set()` (avoiding reallocation of
  typed arrays and preserving the cross-references between `MMU`↔`PPU`↔`DSP`).

Top-level structure:
```js
{
  version: 1,
  frameCount,
  cpu: { ...flat(cpu, ['bus','P']), P: flat(cpu.P) },
  ppu: flat(ppu, PPU_SKIP),
  mmu: { ...flat(mmu, MMU_SKIP), dma: mmu.dma.map(flat) },
  apu: { ...flat(apu, APU_SKIP), timers: apu.timers.map(t=>({ticks,counter})) },
  dsp: { ...flat(dsp, DSP_SKIP), voices: dsp.voices.map(flat) },
}
```

**Excluded fields (skip lists)**:
- `PPU_SKIP`: `frameBuffer/zBuffer/layerBuffer/objBuffer/objPrioBuffer/objPalHighBuffer`
  — scratch buffers rebuilt every frame.
- `MMU_SKIP`: `ppu/apu/rom/dma` — cross-references and the immutable ROM image
  (`dma` is restored separately as an array).
- `APU_SKIP`: `dsp/bootRom/timers` — `dsp` is restored recursively, `bootRom` is a
  constant, and `timers` is restored separately.
- `DSP_SKIP`: `apu_ram/gauss/sampleBufferL/sampleBufferR/voices` — `apu_ram` is
  re-linked to `apu.ram`, `gauss` is a constant table, the sample buffers are
  scratch audio buffers, and `voices` is restored individually.

`restoreState` throws if `version!==1`. The Voice array is restored field-by-field
via `restoreFlat` while preserving each `Voice`'s methods, and `dsp.samplePos=0`
is reset after restoration.

---

## 8. UI and Main Loop (`src/main.js`)

### 8.1 Rendering

- A `new SNES()` instance is exposed as `globalThis.snes` (with
  `globalThis._snesCPU = snes.cpu` also exposed).
- The canvas is 512x224. `ctx.createImageData(512,224)`'s `data.buffer` is viewed
  as a `Uint32Array` (`buf32`), and every frame `buf32.set(snes.ppu.frameBuffer)`
  followed by `ctx.putImageData(...)` performs a fast blit.
- The main loop, `loop()`, is `requestAnimationFrame`-based and controlled by a
  `running` flag. `startEmulation()` will not start if `romLoaded` is `false`
  (and shows a Japanese-language message guiding the user).
- `console.log` is monkey-patched so that, while `globalThis._verbose` is `false`,
  tagged debug logs (e.g. `[APU]`) are suppressed.

### 8.2 Audio

- A `ScriptProcessorNode(2048, 0, 2)` (stereo output) feeding into a `GainNode`
  (2x boost).
- `audioRingL`/`audioRingR` (`Float32Array(65536)`) accumulate the output of
  `snes.getAudioSamples()` (samples are dropped if the ring is full).
- Inside `onaudioprocess`, **linear-interpolation resampling** converts from the
  DSP's native 32kHz to `audioContext.sampleRate`.
- Since `AudioContext` starts `suspended` until a user gesture, two paths call
  `resume()` and then `startEmulation()`: `tryAutoStartAfterLoad()` (after a ROM
  loads) and `handleFirstAudioActivation` (the first click/keypress).

### 8.3 ROM Loading UI

- Supported extensions: `.sfc`/`.smc`. `window.showDirectoryPicker()` (File System
  Access API) is preferred; if unsupported or it errors, it falls back to
  `<input type="file" webkitdirectory multiple>`. Drag-and-drop is also supported.
- The ROM list is sorted in **Japanese kana/alphabetical order**
  (`localeCompare(..., 'ja', {numeric:true, sensitivity:'base'})`) and displayed
  as a list of buttons.
- `loadRomBytes()` stops the running loop, calls `snes.loadRom()`, sets
  `romLoaded=true`, and attempts auto-start.

### 8.4 Input Handling

`keydown`/`keyup` are ignored if `document.activeElement !== canvas` (a focus
guard). Key mapping table:

| Key (`e.code`) | SNES button | Bitmask |
|---|---|---|
| `KeyZ` | B | `0x8000` |
| `KeyA` | Y | `0x4000` |
| `ShiftLeft`/`ShiftRight` | Select | `0x2000` |
| `Enter` | Start | `0x1000` |
| `ArrowUp` | Up | `0x0800` |
| `ArrowDown` | Down | `0x0400` |
| `ArrowLeft` | Left | `0x0200` |
| `ArrowRight` | Right | `0x0100` |
| `KeyX` | A | `0x0080` |
| `KeyS` | X | `0x0040` |
| `KeyQ` | L | `0x0020` |
| `KeyW` | R | `0x0010` |

On a `blur` event on `window`/`canvas`, `snes.mmu.joy1=0` is reset (so that, e.g.,
taking a screenshot doesn't leave a button stuck "pressed" when focus is lost).
F5/F8 perform quick-save/quick-load (10 slots, stored in `localStorage` keyed by
ROM name + slot number).

### 8.5 Debug / Developer Tools (`globalThis`)

- `dumpPriorityInfo()` — BG/sprite priority diagnostics (`PriorityDebug.js`,
  section 4.9).
- `dumpSaveState()` — downloads a `captureState()` JSON and a canvas screenshot
  PNG. **Automatically invoked on crash** (from the catch block in `loop()`),
  leaving behind data for offline bug reports.
- `portLogStart/Stop/Dump/Save` — logs CPU→APU communication-port writes.
- `spcDump(name)` — uses `dumpSpc()` from `spc_dump.js` to download the APU state
  in `.spc` format.

### 8.6 Crash Handling

In the catch block of `loop()`: log "Runtime Error" → automatically run
`dumpSaveState()` (logging `[dumpSaveState on crash] failed` on failure) → paint
the whole canvas red with "CRASH: ..." displayed, and set `running=false` (the
loop does not restart).

### 8.7 Other UI Features

- Toast notifications (`showToast`, shown for 1.8 seconds).
- Battery SRAM export/import (`.srm`/`.sav` files).
- A reset button (calls `snes.reset()`; does not restart the loop itself).
- Frame-counter diagnostics: every 60 frames (every frame for the first 120),
  logs PC/PB/INIDISP/MODE/TM/`stopped` state. If the PC has stayed at the same
  value for 180 frames, logs `nmitimen`/`INIDISP`/PC/`waiting` as a "stuck CPU"
  diagnostic.

---

## 9. Timing and Synchronization

- **One frame**: 262 scanlines × ~227 CPU cycles/line ≈ ~59,474 CPU cycles
  (a simplified model; an approximation of the real NTSC hardware's ~357,368
  master clocks).
- **CPU↔PPU**: the cycle count returned from `cpu.step()` updates
  `ppu.vcounter`/`ppu.hcounter`, and the HBlank (`lineCycles>=137`)/VBlank
  (`line>=225`) flags (`hvbjoy`) are updated accordingly.
- **CPU↔APU**: the APU is advanced toward a target of "CPU cycles progressed ×
  1024/3580" — a loosely coupled, fixed-ratio sync where `apu.step()` catches up.
- **APU↔DSP**: on the APU side, `dsp.step()` is called once every 32 APU cycles,
  producing a 32kHz sample stream.
- **HDMA**: `doHDMA()` runs during H-Blank on every visible line — this is
  directly tied to the accuracy of raster-timing-dependent effects (CGRAM/VRAM
  transfers, window animations, gradients, etc.).

---

## 10. Known Issues and Notes on Debug Instrumentation

- **Missing WRAM power-on pattern (regression)**: as noted in section 3.1, this
  was accidentally removed during a DSP-1-related refactor, so WRAM is currently
  zero-initialized (`test_wram_poweron.mjs` fails). The non-zero pattern
  introduced to fix Chrono Trigger's BRK-loop issue needs to be restored.
- **Mode 5/6 hi-res BG1 tile-adjacency assumption**: as noted in section 4.5, the
  `tileIdx+1` scheme assumes sequential tile placement and shows up as dark bands
  on RS3's character-creation screen (unfixed).
- **Debug instrumentation**: `CPU.js`/`MMU.js`/`PPU.js`/`main.js` retain a large
  amount of watchpoint/trace/logging code targeting specific ROMs and addresses
  (see sections 2.6 and 3.7). Much of it is gated behind `globalThis._xxx` flags,
  but some (e.g. ROM-loading logs) is unconditional. It is independent of core
  functionality and can be removed without affecting emulation results.
- **SA-1 coprocessor not implemented**: SA-1-equipped carts such as Kirby Super
  Star (Super Deluxe) are completely unsupported — the SA-1's second CPU core,
  I-RAM, and registers are entirely unimplemented, so the game halts in forced
  blank at boot. Supporting these would require implementing SA-1 as a new
  subsystem.
