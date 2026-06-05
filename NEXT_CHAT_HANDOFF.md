# CPU Cycle Hardening Handoff

## Goal
- Continue improving 65816 CPU timing accuracy in [src/CPU.js](src/CPU.js) while keeping semantic behavior stable.

## What Was Completed
- Added/fixed cycle accounting for interrupts/flow/control/stack/transfer classes.
- Added/fixed cycle accounting for:
  - ORA/AND/EOR all major addressing variants.
  - ADC/SBC/CMP all major addressing variants.
  - LDA/LDX/LDY and STA/STX/STY/STZ uncovered variants.
  - RMW memory ops (INC/DEC/ASL/LSR/ROL/ROR).
  - TRB/TSB.
  - BIT/CPX/CPY direct-page w-penalty handling.
- Added page-cross aware helpers and applied them where required.
- Fixed MVN/MVP block move semantics and timing:
  - Execute one byte per instruction step.
  - Decrement 16-bit A per moved byte.
  - Rewind PC by 3 while A != $FFFF to continue block move loop.
  - Keep total 7 cycles per moved byte.
- Fixed step() cycle accounting edge cases:
  - `prevCycles` is now captured before WAI/interrupt paths so returned cycle deltas include wake/interruption cost.
  - STP stopped-state stepping now advances `cycles` by 1 per step (instead of returning 1 with no cycle advance).
- Fixed status-restore width semantics (`PLP`/`RTI` path via `P_set`):
  - When `P.X=1` (8-bit index), `X`/`Y` high bytes are now truncated immediately.
  - In emulation mode (`E=1`), force `M=X=1` and keep `SP` high byte at `$01`.

## Key Files Touched
- [src/CPU.js](src/CPU.js)
- [test_cpu_cycles.mjs](test_cpu_cycles.mjs)

## Regression Status
- Latest full run is all PASS:
  - node test_cpu_cycles.mjs
  - node test_cpu_interrupt_stack.mjs
  - node test_cpu_flow_stack.mjs
  - node test_cpu_accuracy.mjs
- Added dedicated MVN/MVP cycle+semantics tests in test_cpu_cycles.mjs.
- Added regression tests for cycle-return consistency in WAI->NMI wake path and STP stopped-state stepping.
- Added regression tests that verify `PLP`/`RTI` truncation of index high bytes when restored status sets `X=1`.

## Runtime Investigation (Chrono Trigger BRK Loop)
- CPU regressions are green, but runtime still reaches one BRK around frame ~131 and then loops at `00:FF18`.
- At the fault site:
  - `PB:PC = 7E:3998`, opcode `FC 50 09` (`JSR (abs,X)`).
  - `X=0000`, so pointer read is from `7E:0950/0951`.
  - Observed bytes are `FF FF` (also mirrored in bank 00 at that moment), target becomes `FFFF`, then opcode `00` (BRK).
- Deeper writer trace (including bank-00 WRAM mirror) pinned actual provenance:
  - `C0:5929..595B` writes `FF` into `7E:0920..092F` (first at frame ~27; repeats later).
  - `C3:0950..095D` runs `MVN 00,00` with `X=0920`, `Y=0950`, `A=001F`, copying 32 bytes from `0920..093F` to `0950..096F`.
  - Therefore `0950..095F` becoming `FF` is not missing write; it is copied from `0920..092F`.
- `7E:398A..39AF` code is runtime-generated (written at frame ~63 from `C3:0651/C3:0677` via `$2180`), and bytes are intentionally:
  - `... BD 50 09 F0 0B ... FC 50 09 ... E0 20 00 D0 E9 ...`
  - i.e. dispatcher scans from `0950` and calls `JSR (0950,X)` on non-zero entries.
- Since copied entries at `0950` are `FFFF`, first dispatch call jumps to `FFFF` and BRKs.
- Seed/path comparison:
  - Baseline path reaches BRK and has `0950..095F = FF ...`.
  - Seed00-style (`$0101:$0100=01:00`) does not BRK in the same window and shows valid non-`FFFF` entries at `0950` (e.g. `80 06 ...`).
- Current hypothesis: this is now primarily path/state divergence in runtime orchestration (table-content contract violation), not core opcode semantics for `FC`/`MVN`.

### New Upstream Divergence Findings (latest)
- Confirmed this is not a direct call into `C0:CC50`; `CC50` is reached by internal fallthrough/returns within the `C0:CCxx` block.
- Failing baseline never enters `C0:CCxx` at all before BRK (`entries=0`), while seed00 enters repeatedly.
- Seed00 dynamic entries into `CCxx` come via return/fallthrough from:
  - `C0:CBDB -> C0:CC01`
  - `C0:E972 -> C0:CC10`
  - `C0:E934 -> C0:CC67`
- Backtracing one level up:
  - Baseline: `C0:CBxx` is never reached before BRK.
  - Seed00: `C0:CB01` is entered repeatedly from branch at `C0:CAF3` (`F0 0C`, taken).
- Backtracing another level up:
  - Baseline reaches `C0:CA76` via `C0:00D6` (`20 76 CA`) but does not reach `C0:CAD9/CAF3/CB01` path.
  - Seed00 reaches both `C0:CA76` and additionally `C0:CAD9` from `C0:B109` (`20 D9 CA`), then proceeds through `CAF3 -> CB01 -> CCxx` where `0950` is built to non-`FFFF` values.
- Practical conclusion: the concrete gate difference is now narrowed to upstream control flow that determines whether execution reaches `C0:CAD9..CAF3..CB01..CCxx` (seed00) versus remaining on `CA76`-only path (baseline), which directly decides whether `0950` gets valid handlers or remains `FFFF` via MVN copy.

### Earliest Concrete Branch Split Found
- Seed00 reaches `C0:B109` (`20 D9 CA`) and then `C0:CAD9`, but baseline does not hit `B109`/`CAD9` in failing windows.
- Upstream gating branch is at `C0:B0FA` (`F0 1E`):
  - Baseline observed path: `A=2107`, zero flag set, branch taken to `C0:B11A`.
  - Seed00 observed mixed path: many `A=0905/0904/2104...` cases where branch is not taken to `B11A`, continuing into `B0FC/B0FF/B101/.../B109` and then `CAD9`.
- Additional gate at `C0:B0FF` (`90 19`): when carry is set (observed in seed00), flow continues to `B101` and can reach `B109`; when clear, it falls back to `B11A`.
- Interpretation: baseline appears stuck on the `B11A` side of the dispatcher setup sequence, while seed00 intermittently satisfies conditions to execute deeper setup path (`B101->B109->CAD9->CAF3->CB01->CCxx`).

### New Root-Cause Narrowing (7F:2000 Span Divergence)
- The practical gate into the broad `C0:5910` dispatch fan-out is now traced to `7F:2000` value used at `C0:58E8`:
  - baseline: `7F:2000` observed `01` then `02`.
  - seed00: `7F:2000` observed `33`.
- `C0:58E8` computes loop limit (`$BD = 2 * [7F:2000]`), so this directly changes how many entries are scanned from `1100/1180` tables and therefore which IDs reach `C0:5910`.
- Resulting effect on `C0:5910` IDs:
  - baseline mostly dispatches only `0170` and `0094` (rarely anything else), never reaching `00D4/00D8/0104` cluster.
  - seed00 dispatches many IDs including `00D4/00D8/00DA/0104...`, which enter `4204/420C/4214/4590` and populate `1100/1200` runtime tables.
- `7F:2000` writer PCs captured:
  - baseline: `C3:0888` writes `01` (later `02` similarly), first write frame ~27.
  - seed00: `C3:082D` writes `33`, first write frame ~87.
- Therefore the high-leverage issue is now upstream of `58E8`: why baseline goes through the narrow `C3:0888` value path while seed00 reaches the broader `C3:082D` path.

### Data Provenance Snapshot At First 7F:2000 Write
- baseline first write:
  - PC `C3:0888`, value `01`, `X=0003`, `Y=2000`, `DB=DB` at that instant.
  - nearby source bytes from current `DB:X`: `01 20 00 F1 02 D0 B8 00 BC 00 FC 4A A1 02 7E 00`.
- seed00 first write:
  - PC `C3:082D`, value `33`, `X=556D`, `Y=2000`, `DB=FB`.
  - nearby source bytes from current `DB:X`: `00 33 60 06 70 06 9E 07 9F 01 02 B0 F4 07 F9 07`.
- This strongly suggests a different input stream/source-bank context for the same decode/writer machinery, not just late-stage table overwrite.

### Newly Confirmed Upstream Pointer Split (Before C3 Decoder)
- `DB` divergence at first `7F:2000` write is now explained by explicit pointer selection in `C0:56D8..56FF`:
  - baseline trace at `C0:56F3`: loaded `A=20DB` then wrote to `$0302`; `C3:05BC (PLB)` sets `DB=DB`.
  - seed00 trace at `C0:56F3`: loaded `A=20FB` then wrote to `$0302`; `C3:05BC (PLB)` sets `DB=FB`.
- Therefore `DB` mismatch (`DB` vs `FB`) is not currently evidence of PLB/stack/DBR CPU bug; it is data-selected by upstream descriptor table lookup.

### Exact Descriptor Path Difference (Frame Of First Write)
- Shared flow enters `C0:56D4` then computes descriptor index and pointer tuple for the C3 worker (`JSL C3:0002`).
- baseline key values:
  - `C0:56D8`: `X=0000`, `A=0017`
  - `C0:56E4`: table fetch produced `A=0045` (index into `A000+X` descriptor)
  - `C0:56E8`: base pointer `$0300=0000`
  - `C0:56F3`: bank byte path produced `A=20DB` (`$0302=DB`)
  - then `C3:05AA` indirect pointer fetch -> `A=00C6`, and first write route lands at `C3:0888` (`01`).
- seed00 key values:
  - `C0:56D8`: `X=0E00`, `A=0163`
  - `C0:56E4`: table fetch produced `A=0429`
  - `C0:56E8`: base pointer `$0300=556B`
  - `C0:56F3`: bank byte path produced `A=20FB` (`$0302=FB`)
  - then `C3:05AA` indirect pointer fetch -> `A=5F5D`, and first write route lands at `C3:082D` (`33`).

### New Immediate Highest-Leverage Question
- Why does the `C0:56D8` descriptor index source diverge (`X=0000` baseline vs `X=0E00` seed00) at the first `7F:2000` production opportunity?
- This is now earlier and cleaner than C3 internals for finding emulator-caused divergence vs expected game-state divergence.

### New Timing-Window Finding (`$0101` Injection Sweep)
- Per-frame injection test (`wram[0x0101]=1`) shows a sharp cutoff:
  - inject at frame `0..20`: no BRK in a 180-frame window and broader route coverage (including `CCxx` in many cases).
  - inject at frame `>=25`: behaves like failing baseline, BRK around frame ~130 with missing `CCxx` route.
- This isolates a narrow early bootstrap window (around frame 21-24) where state must already be set before route selection commits.

### Refined Latch Boundary (New 1->0 Clear Sweep)
- Starting from safe seed (`$0101=1` at power-on), then clearing `$0101` later gives an asymmetric result:
  - clear at frame `0..20`: BRK reproduces (~130), `CCxx` not reached.
  - clear at frame `>=21`: BRK does not reproduce in 180-frame window, `CCxx` route remains reachable.
- Interpretation: the decisive sample/latch of `$0101` occurs at about frame 21 (around the early `C0:092D` gate window). After that point, changing `$0101` does not flip the already-chosen route.

### Direct Instruction-Level Confirmation (`C0:092D`)
- `C0:092D` (`AND #$01` after `LDA $01`) is first hit at frame 21 in all tested runs.
- Behavior at first hit:
  - failing route: `A=0000`, `DP01=00`, flags lead to baseline branch pattern;
  - passing route: `A=0001`, `DP01=01`, passes into alternate setup.
- In failing runs, `C0:092D` is hit again around frame 47 after late state update (`$0101` already became `01`), but that second hit does not recover route.
- In passing runs, `C0:092D` is typically hit only once in this window, consistent with one-way early commit.

### Clarified `$0101` Evolution In Baseline
- Baseline is not permanently `$0101=00`:
  - starts as `00` with zeroed WRAM,
  - later becomes `01` at frame ~47 by in-game code at `C0:0CB8` (`00:0100=B1`, `00:0101=01`).
- This late correction is too late to recover; critical branch choices already happened.

### PCs Observed Reading `$0101`
- Runtime read sites in failing baseline: `C0:0069`, `C0:0B88`, `C0:092D`, `C0:A698`, `C0:A745`, `C0:0C9F`.
- The earliest high-impact gate remains `C0:092D` (`LDA $01` then `AND #$01`) which chooses between `0931..` and `0945..` setup flow.

### Countdown Mechanism That Locks The Route (`$0119`)
- Baseline executes a visible countdown loop at `C0:0C91` driven by `$0119`:
  - `C0:3AEB` sets `$0119=0F` (frame ~31),
  - `C0:0C91..0C99` decrements it once per frame until `00` (frames ~32..47),
  - at zero, flow enters `C0:0C9A..0CC4` and writes `00:0100/0101` (observed at `C0:0CB8` -> `B1/01`).
- Seed00 run in the same early window does not traverse this countdown block, i.e. route commitment already occurred earlier via startup-state gate.
- This aligns with the injection sweep cutoff: by the time countdown reaches zero and late writes happen, failing baseline route has already committed.

## Important Known Timing Notes
- BIT abs,X has no page-cross penalty in current model.
- Direct-page low-byte penalty (w) is applied for direct-page forms including BIT dp/dp,x and CPX/CPY dp.

## Remaining Work For Next Chat
- Continue machine-guided sweep for any remaining opcode semantics/timing gaps.
- Keep adding targeted tests for every touched CPU behavior.
- Continue BRK root-cause trace from data side:
  - trace why `C0:5929` seeds `0920..092F` with `FF` on the failing path, and why valid handlers are not placed into the first 16 bytes before `C3:0950` copy.
  - trace the upstream state transition difference that leads baseline to `CA76`-only flow while seed00 reaches `CAD9->CAF3->CB01->CCxx` and then non-`FFFF` dispatch entries.
  - keep validating that generated dispatcher bytes at `7E:398A` remain stable and map consistently to intended table contract.
  - correlate with known control variables (`7E:027C`, `7E:02AE`, `7F:01ED`) that remain zero in failing runs.
  - prioritize pre-frame-25 bootstrap decisions tied to `$0101`-gated branches; post-frame-47 `$0101` update does not prevent BRK.

## Safety/Workflow Notes
- Worktree is intentionally dirty with many unrelated image artifacts and renderer/APU/PPU edits; do not revert unrelated files.
- Restrict timing changes to [src/CPU.js](src/CPU.js) and matching tests unless a concrete dependency requires broader edits.

## Latest Emulator-State Fix
- Zero-filled WRAM at power-on was reproducing the Chrono Trigger BRK route.
- The current fix is in [src/MMU.js](src/MMU.js): WRAM now starts with a deterministic non-zero pattern instead of `Uint8Array`'s zero-filled default.
- In the traced window, this avoids the early `C0:092D` route commit that previously led to the `00:FF18` BRK loop.

## Handy References
- Current ALU timing block start: [src/CPU.js](src/CPU.js#L1136)
- Current arithmetic timing block start: [src/CPU.js](src/CPU.js#L1277)
- Current compare/bit direct-page timing area: [src/CPU.js](src/CPU.js#L1503)
- Newly added ALU general cycle tests: [test_cpu_cycles.mjs](test_cpu_cycles.mjs#L512)
- Direct-page penalty test examples: [test_cpu_cycles.mjs](test_cpu_cycles.mjs#L680)