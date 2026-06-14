# SNES (スーパーファミコン) エミュレータ 実装設計書

## 1. システム全体概要 (System Architecture)

本エミュレータ（JSSNES）は、JavaScript環境上で動作するSNESエミュレータです。
`SNES.frame()` を呼ぶたびに1フレーム（262スキャンライン）分のCPU/PPU/APU処理を実行し、
内部で各サブシステムがクロックサイクル/スキャンライン単位で同期しながら動作します。

### 1.1 ソースファイル構成

| ファイル | 行数 | 役割 |
|---|---|---|
| `src/SNES.js` | ~190 | トップレベルオーケストレーション。`frame()`のメインループ |
| `src/CPU.js` | ~2230 | S-CPU (65816) コア。レジスタ、命令ディスパッチ、割り込み |
| `src/MMU.js` | ~975 | メモリマッピング、DMA/HDMA、ROMマッパー判定、DSP-1連携 |
| `src/PPU.js` | ~1210 | グラフィック描画（BGモード、ウィンドウ、カラー演算、Mode7、スプライト） |
| `src/APU.js` | ~625 | SPC700サウンドCPUコア |
| `src/DSP.js` | ~595 | 音声合成DSP（BRR、ADSR/GAIN、エコー） |
| `src/DSP1.js` | ~1190 | DSP-1数学コプロセッサ（HLE、snes9x dsp1.cpp ポート） |
| `src/SaveState.js` | ~120 | セーブステートのシリアライズ/デシリアライズ |
| `src/PriorityDebug.js` | ~345 | BG/スプライト優先度デバッグツール |
| `src/main.js` | ~690 | UI、Canvas描画、音声出力、入力、ROM読み込み |
| `src/spc_dump.js` | ~40 | APU状態を `.spc` 形式でダンプするデバッグツール |
| `src/APUTable.js` | ~14 | 未使用のデッドコード（旧オペコード表の試作） |

### 1.2 サブシステム構成

- **SNES (Core)**: 全体のオーケストレーション、1フレーム単位の進行管理 (`src/SNES.js`)
- **S-CPU (Ricoh 5A22)**: メインCPU（16ビット 65816 カスタムコア）
- **MMU**: メモリマッピング、バスの調停、DMA/HDMA、DSP-1コプロセッサ
- **PPU**: グラフィック描画プロセッサ（バックグラウンド、スプライト、ウィンドウ、Mode7等）
- **APU / SPC700**: オーディオ用サブプロセッサ
- **DSP**: 音声合成・エフェクト（BRRデコード、ADSR、エコー等）
- **DSP-1**: カートリッジ搭載の数学コプロセッサ（HLE、Super Mario Kart等）

### 1.3 メインループ (`SNES.frame()`)

`frame()` は1フレーム = 262スキャンラインのループです（NTSC想定）。各スキャンラインで以下を行います。

```js
const scanlinesPerFrame = 262;
const cyclesPerScanline = Math.floor(1364 / 6); // ~227 CPUサイクル/ライン

for (let line = 0; line < scanlinesPerFrame; line++) {
    // line===225: VBlank開始 — RDNMI($4210)のVBlankフラグセット、OAMアドレスをリロード、
    //             NMITIMEN($4200)の有効時はcpu.nmiPending=true、Auto-Joypad読み込み実行
    // line===0:   VBlankフラグクリア、field（偶奇フィールド）トグル、HDMAEN有効ならinitHDMA()

    let lineCycles = 0;
    while (lineCycles < cyclesPerScanline) {
        // H/V-IRQ判定 (NMITIMEN bit4/5 = IRQモード, vtime/htimeとの比較)
        // HBlank検出 (lineCycles>=137でhvbjoy |= 0x40)
        const cyclesTaken = this.cpu.step();
        lineCycles += cyclesTaken;

        // APUをCPUサイクル比 1024:3580 で追従させる
        this.apuTargetCycles += cyclesTaken * 1024 / 3580;
        while (this.apu.cycles < this.apuTargetCycles) this.apu.step();

        this.ppu.vcounter = line;
        this.ppu.hcounter = Math.floor(lineCycles * (1364 / cyclesPerScanline));
    }

    if (line < 224) this.ppu.renderLine(line);          // 可視ラインのみ描画
    if (line < 225 && this.mmu.hdmaen) this.mmu.doHDMA(); // H-Blank時にHDMA転送
}
```

- **NMI**: line===225でNMITIMEN bit7が立っていれば `cpu.nmiPending=true`。CPU側は命令実行後に `checkInterrupts()` でこれを検出する。
- **IRQ (H/V-Timer)**: `NMITIMEN & 0x30` でモード判定（`0x30`=H+V一致、`0x20`=V一致のみ、`0x10`=H一致のみ）。`vtime`/`htime` ($4209-$420C) と現在の line/dot を比較し、一致時に `mmu.timeUp=true` と `cpu.irqPending=true` をセット。
- **Auto-Joypad読み込み**: line===225で `joy1`/`joy2` のビットを `$4218-$421F` (autoJoy[0..7]) にコピー。
- **オーディオ同期**: APUは「CPUサイクル×1024/3580」を目標値として、CPUが進んだ分だけ `apu.step()` を追いつかせる（固定比率の疎結合シンクロ）。

---

## 2. S-CPU (Ricoh 5A22 / 65816)

16ビットアーキテクチャの65816プロセッサのエミュレーションです (`src/CPU.js`)。

### 2.1 レジスタと状態管理

- `A`/`X`/`Y`/`SP`/`DP`/`PC` は16ビット整数として保持（`this.A` などプレーンなインスタンスフィールド）。
- `DB`（Data Bank）/`PB`（Program Bank）は8ビット。
- ステータスフラグ `P` はビットフィールドではなく、フラグ名をキーとしたオブジェクト：
  ```js
  this.P = { C:0, Z:0, I:1, D:0, X:1, M:1, V:0, N:0, E:1 };
  ```
  `getP()` で1バイトにパックし（PHP/割り込み時のスタックpush）、`P_set(val)` で1バイトから復元（PLP/RTI）。`P_set` は65816の不変条件も強制する：エミュレーションモード(`E=1`)では `M=1,X=1` を強制しSPの上位バイトを`0x01`に固定し、`X=1`（8bitインデックス）の場合は `X`/`Y` を `&0xFF` でマスクする。
- **8/16ビット幅の切り替え**は、各命令ハンドラが `this.P.M`（A/メモリ幅）または `this.P.X`（X/Y幅）を見て `fetchByte()/fetchWord()` や `read()/readWord()` を分岐させる方式。物理的にレジスタを毎回切り詰めるのではなく、命令ごとに幅依存の読み書きを行う。
- `XCE`（`case 0xFB`）はCフラグとEフラグを交換し、エミュレーションモードに入る際に `M=1,X=1` を強制し、SPの上位バイトを `0x01` に固定する。

### 2.2 命令ディスパッチとアドレッシングモード

- `execute(opcode, pc, pb)` は **256個の `case 0x..`** を持つ巨大な `switch` 文（複数のオペコードが同じ `case` を共有する例: `case 0x24: case 0x2C:` でBIT dp/absを共通処理）。未実装オペコードは `default:` でログを出し `this.stopped=true` にする。
- アドレッシングモードは個別のヘルパーメソッドとして実装（約17種）:
  - `addr_abs`, `addr_absl`（絶対24bit）, `addr_dp`, `addr_dp_ind`, `addr_dp_ind_long`, `addr_dp_ind_long_y`
  - `addr_abs_x`/`addr_abs_y`、`addr_dp_x`/`addr_dp_y`、`addr_dp_ind_x`/`addr_dp_ind_y`（ページ跨ぎ判定用に `{addr, pageCrossed}` を返す `_info` 版を併設）
  - `addr_sr`/`addr_sr_ind_y`（スタック相対アドレッシング）
- ダイレクトページのラップアラウンドは2種類に分離: `dpAddrOld`（エミュレーションモードでDPの下位バイトが0のときの6502的ラップ）と `dpAddrNew`（`[dp]`系のロングインダイレクトでラップしない）。
- ALU共通処理は補助メソッドに分離: `adc(val)`, `sbc(val)`, `cmp_reg(reg, val, is16bit)`, `setZN(val, is16bit)`。CMP/CPX/CPY系の各アドレッシングモードは `cmp_reg` を共有する。

### 2.3 サイクルカウントモデル

固定サイクル表は使わず、`step()` がベースとして `this.cycles++` を1回行い、各 `case` がデルタを `this.cycles += N` の形で加算する方式：

- **幅依存の増分**: 16bit操作では `cycles += 4 - (this.P.M ? 1 : 0)` のように、Mフラグで補正。
- **ダイレクトページペナルティ**: DPの下位バイトが非ゼロなら `+ ((this.DP & 0xFF) ? 1 : 0)`。ADC/SBC/CMP/BIT/CPX/CPY の dp系アドレッシングすべてに適用される。
- **ページ跨ぎペナルティ**: `addr_*_info()` が返す `pageCrossed` をもとに、Xフラグ（インデックス幅）に応じて `+1`。
- **分岐命令** (`branch8`): 「不成立=+1、成立=+2、エミュレーションモードでページ跨ぎ成立=+3」。
- **MVN/MVP** (`case 0x44/0x54`): 1バイト転送ごとに `step()` を1回消費する自己ループ命令として実装。1バイトごとにAをデクリメントし、`A !== 0xFFFF` なら `PC -= 3` で同じオペコードを再実行。1バイトあたり `cycles += 6`（`step()`のベース+1と合わせて計7サイクル＝実機と一致）。
- **デシマルモード (Dフラグ)**: `adc()`/`sbc()`にBCD補正パスを実装（8bit/16bit双方）。Vフラグは実機同様、デシマルモードでもバイナリ演算結果から計算する。

### 2.4 割り込み処理 (Interrupts)

- **Reset** (`reset()`): `E=1, M=1, X=1, I=1, D=0, DB=PB=0, SP=0x01FF, DP=0` を強制し、`$FFFC/$FFFD` からリセットベクタを読む。ベクタが `0`または`0xFFFF`なら `Error("Invalid Reset Vector")` をthrow。
- **NMI** (`nmi()`) / **IRQ** (`irq()`): PCと（ネイティブモードならPBも）、パックしたPをスタックにpushし、`P.I=1, P.D=0` を設定してベクタへジャンプ。
  - NMI: エミュレーション `$FFFA/FFFB`、ネイティブ `$FFEA/FFEB`
  - IRQ: エミュレーション `$FFFE/FFFF`、ネイティブ `$FFEE/FFEF`
  - コストは `P.E ? 7 : 8` サイクル。`waiting=false`（WAIから復帰）し、対応する `*Pending` フラグをクリア。
- **`checkInterrupts()`**: `step()` で `execute()` の**後**に1回呼ばれる（実機同様、NMIは命令終了時にサンプリングされる）。NMIが無条件優先、IRQは `irqPending && !P.I` のときのみ発火。
- **WAI** (`0xCB`): `this.waiting=true`。待機中は毎ステップ `checkInterrupts()` を実行し、IRQが来れば `P.I=1` でも復帰（WAIの仕様通り）。待機中は1サイクル/ステップを消費。
- **STP** (`0xDB`): `this.stopped=true`。以降 `step()` はサイクルを増やし続けるだけ（「時間は進むが完全に停止」）。
- **BRK** (`0x00`) / **COP** (`0x02`): PB(ネイティブ時)/PC/Pをpushし、`D=0,I=1,PB=0` を設定。ベクタは BRK: ネイティブ `$FFE6/E7` / エミュレーション `$FFFE/FFFF`、COP: ネイティブ `$FFE4/E5` / エミュレーション `$FFF4/F5`。**ベクタが `0x0000` の場合は致命的エラーとみなし**、`this.stopped=true` → `dumpTrace()` → `throw new Error("Invalid BRK Vector")`。

### 2.5 クラッシュ診断（命令トレースバッファ）

- `this.trace`（リングバッファ、`traceSize=32`）に、毎 `step()` で `{pb, pc, op, a, x, y, sp, dp, db, e, m}` をpush（32件を超えたら古いものをshift）。
- `dumpTrace()` は直近32命令を `console.error` で16進ダンプする。BRKベクタ無効時のみ呼ばれる、post-mortem解析用のツール。

### 2.6 デバッグ計装について

`step()` の本体（約128行）のうち、約60%（約78行）は **ROM特定のデバッグ計装**で占められている：`globalThis._pcVisited` をキーにした特定PCアドレス（`$9326`, `$8082`, `$8A0E`, `$935F`, `$938E`, `$8674`, バンク4の `$DBA0`/`$DB60`/`$DBB6`, `$A0C4` 等）に対する一回限りのウォッチポイントログ（`[WP]`/`[WP-B4]`/`[B4-VISIT]`）、および「PCが32バイト範囲内に2000ステップ留まったら `[STUCK]` を出力する」スタックループ検出器。これらはコア機能（フェッチ→トレース記録→`cycles++`→`execute()`→`checkInterrupts()`）の上に乗った、削除可能な調査用コードである。

---

## 3. MMU (Memory Management Unit)

S-CPUからの24ビットアドレス（Bank + Offset）を各物理メモリやI/Oにマッピングします (`src/MMU.js`)。

### 3.1 メモリ領域

- **WRAM**: `Uint8Array(128 * 1024)`（128KB、`$7E0000-$7FFFFF`に連続配置、`$00-$3F`/`$80-$BF`バンクの`$0000-$1FFF`にミラー）。
- **SRAM**: `Uint8Array(128 * 1024)`（カートリッジ battery-backed RAM）。
- **ROM**: `loadRom()` で設定される `Uint8Array`。

> **既知の回帰**: コンストラクタには元々 `for (...) wram[i] = (0x88 + i*17) & 0xFF` というWRAM初期化パターン（Chrono TriggerのBRKループ問題を修正するための非ゼロ初期化）があったが、DSP-1関連のリファクタ時に誤って削除され、現在WRAMは全ゼロで初期化される（`test_wram_poweron.mjs` 失敗、未修正）。

### 3.2 ROM読み込みとマッパー判定 (`loadRom()`)

1. **ヘッダーストリップ判定**: `data.length % 1024 === 512` ならコピーROMヘッダ（512バイト）として先頭をスキップ。
2. **LoROM/HiROM判定** はスコアリング方式（`loScore`/`hiScore`）:
   - **ヘッダ文字列の印字可能性**: `checkHeader()` が `$7FC0`(LoROM)/`$FFC0`(HiROM)のタイトル領域の0x20-0x7Eの割合をスコア化。
   - **マップモードバイト**: `rom[0x7FD5] & 0x0F === 0x00` → `loScore += 5`、`rom[0xFFD5] & 0x0F === 0x01` → `hiScore += 5`。
   - **割り込みベクタの妥当性**: `countValidVectors(base)` が NMI/Reset/IRQ ベクタ（`base+4..+14`）のうち `0x8000 < vec < 0xFFFF` を満たす個数を数え、LoROM候補(`$7FE0`)とHiROM候補(`$FFE0`)を比較。優れている方に `+10`。
   - `this.isHiRom = (hiScore > loScore)`（同点ならLoROM優先）。
3. **DSP-1検出**: `headerBase = isHiRom ? 0xFFC0 : 0x7FC0` のカートタイプバイト（`headerBase+0x16`）が `0x03`（ROM+DSP）または `0x05`（ROM+RAM+Battery+DSP）なら `this.hasDSP1=true`、`this.dsp1 = new DSP1()`。

### 3.3 アドレスデコード / メモリマップ

`bank = (addr>>16)&0xFF`, `offset = addr&0xFFFF` に分解し、`read()`/`write()`で以下の順に判定：

| アドレス範囲 | 内容 |
|---|---|
| Bank `00-3F`,`80-BF` の `$0000-$1FFF` | WRAM下位8KBのミラー |
| Bank `7E-7F` の全域 | WRAM本体（`((bank&1)<<16)\|offset`） |
| DSP-1搭載時、Bank `00-1F`/`80-9F` の `$6000-$7FFF` | DSP-1 DR/SRポート（後述） |
| LoROM: `(bank&0x7F)<=0x7D` かつ `offset>=0x8000` | `romAddr = (((bank&0x7F)<<15)\|(offset&0x7FFF)) % rom.length` |
| HiROM: Bank `≥0xC0`、または `≥0x80`かつ`offset≥0x8000`、または`<0x40`かつ`offset≥0x8000`、または`0x40-0x7D`全域 | `romAddr = ((bank&0x3F)<<16)\|offset` |
| `(bank&0x40)===0` の `$2000-$5FFF` | I/Oレジスタ（下記） |

I/Oレジスタの主な内訳:
- `$2100-$213F`: PPU I/O（`ppu.read/write`に委譲）
- `$2140-$217F`（`offset&3`で4バイト周期ミラー）: APU通信ポート（`apu.readCPU/writeCPU`）
- `$2180-$2183`: WMDATA/WMADDL/WMADDH（WRAMへの17bitアドレス間接アクセスポート、`wmaddh<<16|wmaddl` を `0x1FFFF` でラップしながら自動インクリメント）
- `$4016/$4017`: ジョイパッドread/strobe
- `$4200`: NMITIMEN、`$4202-$4206`: ハードウェア乗除算、`$4207-$420A`: H/Vタイマー、`$4210`: RDNMI、`$4211`: TIMEUP、`$4212`: HVBJOY、`$4214-$4217`: 乗除算結果、`$4218-$421F`: Auto-Joypadレジスタ
- `$4300-$437F`: DMA/HDMAチャンネルレジスタ

### 3.4 DMA (汎用DMA)

`this.dma[]` は8チャンネルの配列で、各チャンネルは以下のフィールドを持つ:

- `dmap`（コントロール）, `bbad`（転送先 `$21xx`）, `a1t`（16bit転送元アドレス）, `a1b`（転送元バンク）, `das`（サイズ/インダイレクトバンク）, `dasb`（HDMAインダイレクトアドレス上位）
- HDMA実行時状態: `tableAddress`, `tableBank`, `indirectAddress`, `repeat`, `doTransfer`, `completed`, `a2a`（ラインカウンタ）, `repeatData[4]`

`$4300-$437F` への書き込みは `channel=(offset>>4)&7`, `reg=offset&0xF` で各フィールドにマップ（reg0=dmap, 1=bbad, 2/3=a1t下位/上位, 4=a1b, 5/6=das下位/上位, 7=dasb, 8/9=a2a下位/上位）。

`$420B`（MDMAEN）書き込みで `executeDMA()` が起動し、有効ビットの立っているチャンネルそれぞれに `doDMA(i)` を実行後、そのビットをクリア。`doDMA()`:

- `mode = dmap & 7` をBバスオフセットのパターンにデコード: mode0=`[0]`, 1=`[0,1]`, 2=`[0,0]`, 3=`[0,0,1,1]`, 4=`[0,1,2,3]`, 5=`[0,1,0,1]`。
- `direction = dmap & 0x80`（0=CPU→PPU, 1=PPU→CPU）、`stepDec = dmap & 0x10`、`stepFixed = dmap & 0x08`。
- `count = das || 0x10000` 回、1バイトずつ転送しながら `workSrcAddr` を進める。完了後 `das=0`、`a1t=workSrcAddr`。

### 3.5 HDMA（H-Blank DMA）

**`initHDMA()`**（フレーム先頭、line===0で `hdmaen` が立っていれば呼ばれる）:
- 各有効チャンネルで `tableAddress=a1t`, `tableBank=a1b` を設定し、最初の1バイト（ラインカウントバイト）を読んで `a2a` に格納、`tableAddress` を1進める。
- `d.repeat = (a2a & 0x80) !== 0`、`a2a &= 0x7F`、`completed = (a2a===0)`。
- **インダイレクトHDMA**（`dmap`のbit6）: 完了していなければ続けて2バイト（下位/上位）を読み `indirectAddress` に格納。
- **ダイレクトREPEAT**（インダイレクトでなく `repeat && !completed`）: `nBytes = [1,2,2,4,4,4,2,4][dmap&7]` バイトを先読みして `repeatData[]` に格納（テーブルアドレスはその分進む）。これがプロジェクトノートにある「ダイレクトREPEATの事前読み込み」実装。
- `doTransfer = true` を設定。

**`doHDMA()`**（各可視ラインのH-Blankで呼ばれる）:
- `doTransfer` が true のチャンネルについて、`doDMA`と同じモードパターンで各オフセットに値を書き込む:
  - **インダイレクト**: `(dasb<<16)|indirectAddress` から読み、`indirectAddress`をインクリメント。
  - **ダイレクト**: `repeat` なら **メモリを読まず** `repeatData[byteIdx]` から取得（=EACHモードでは1回読んだ値をN-1ライン保持し続ける動作を再現）。`repeat=false`（EACHモード）なら `(tableBank<<16)|tableAddress` から直接読み、`tableAddress`をインクリメント。
- `a2a` をデクリメントし、0になったら次のラインカウントバイトを読んで `repeat`/`completed` を再計算し、（未完了なら）`indirectAddress` または `repeatData[]` を再読み込み。
- `a2a !== 0` の場合: `doTransfer = d.repeat` —— これが **EACH/REPEATモードの分岐点**。REPEATモード（bit7=1）では常に `doTransfer=true` のまま転送が続き、EACHモード（bit7=0）では新しいラインカウントバイトを読んだそのラインのみ転送される。

### 3.6 DSP-1コプロセッサ連携

- DSP-1搭載カートでは、Bank `$00-$1F`/`$80-$9F` の `$6000-$7FFF` がDSP-1のレジスタポートとして横取りされる（ROM/SRAMマッピングより手前で判定）。
- **DR (Data Register, `$6000-$6FFF`)**: read → `dsp1.getByte()`、write → `dsp1.setByte(value)`。
- **SR (Status Register, `$7000-$7FFF`)**: read は常に `0x80`（Rqm=準備完了固定、DSP1へは委譲しない）。write は無視。これにより、SRをポーリングするROM側のループは即座に抜ける。

### 3.7 デバッグ計装について

MMU.jsには `[ROM-BUF]`, `[ROM-POST]`, `[ROM-CHECK]`, `[MMU]`, `[WRAM]`, `[WRAM-141x]`, `[PAL-BUF]`, `[WRAM-PAL0]`, `[WRAM-WIN]`, `[WWATCH]`, `[DP72]`, `[DP77]`, `[DP15]`, `[13BF]`, `[HDMA]`, `[HDMA-STATE]`, `[HDMA-ALL]`, `[HDMA-CG]`, `[DMA-CGRAM]`, `[DMA-VRAM]` 等のタグを持つデバッグログが多数存在する。多くは `globalThis._dmaLog` / `_wramWatch` / `_forceNav` / `_navHook` / `_ctMirror7fTo7e` 等のフラグで条件付けされているが、ROMロード時のログ（`[ROM-BUF]`/`[ROM-POST]`/`[ROM-CHECK]`等）は無条件出力。

---

## 4. PPU (Picture Processing Unit)

グラフィックの描画を担当します (`src/PPU.js`)。1フレーム262スキャンライン、可視ラインは0-223です。

### 4.1 内部メモリと512pxフレームバッファ

- **VRAM**: `Uint8Array(64*1024)`（64KB） — タイル（キャラクター）データ、タイルマップ（BGマップ）。
- **CGRAM**: `Uint8Array(512)`（256色 × 2バイト、BGR555）。
- **OAM**: `Uint8Array(544)`（メインテーブル512バイト = 4バイト×128スプライト + 高位テーブル32バイト = 2bit×128スプライト）。

実機の高解像度（512px）出力を正確に表現するため、フレームバッファ群はすべて**512px幅**で確保される:

```js
this.frameBuffer      = new Uint32Array(512 * 224); // ABGR
this.zBuffer          = new Uint8Array(512);
this.layerBuffer      = new Uint8Array(512); // 0=Backdrop, 1-4=BG1-4, 5=OBJ
this.objBuffer        = new Uint32Array(512);
this.objPrioBuffer    = new Uint8Array(512);  // OBJ優先度0-3
this.objPalHighBuffer = new Uint8Array(512);  // 1=OBJパレット4-7（カラー演算対象）
// subFrameBuffer / subLayerBuffer も同様に512幅（renderLine初回呼び出し時に確保）
```

- **非高解像度コンテンツ**は1論理ピクセルを2倍書き（`o0=x256*2, o1=o0+1`）でピクセルダブリングする。
- **Mode 5/6の高解像度BGレイヤー**のみ、16個のネイティブ列を直接512幅バッファへ書き込む（4.5節）。

### 4.2 レンダリングパイプライン

`renderLine(line)`:
1. メイン画面・サブ画面それぞれについて `zBuffer`/`layerBuffer` をクリアし、バックドロップ色で初期化。
2. `renderPass(line, layers, mode, bg3Prio, outputOffset)` を呼び、BGレイヤーとスプライトを合成（メイン画面は`frameBuffer`/`layerBuffer`、サブ画面は`subFrameBuffer`/`subLayerBuffer`へ）。
3. `cgadsub & 0x3F` が有効なら `applyColorMath()`。
4. `applyBrightness()`（INIDISP $2100の輝度設定）。

### 4.3 BGモードとレイヤー優先度（zテーブル）

`renderPass` は `mode = bgmode & 0x07` で分岐し、各BGレイヤーを `renderLayer(line, bgIndex, mode, zLow, zHigh)` で描画する。各モードのz値（優先度）テーブルは以下の通り（数値が大きいほど手前）:

- **Mode 0**: BG4→BG3→BG2→BG1の順に描画。`BG1=[40,80] BG2=[30,70] BG3=[20,60] BG4=[10,50]`。OBJ z = `[20,50,80,100]`。
- **Mode 1**（2026-06-13のSやIren鳥居スプライト優先度修正で確定した値）:
  ```js
  let zBg3L = 10, zBg3H = bg3Prio ? 110 : 30;
  let zBg1L = 60, zBg1H = 90;
  let zBg2L = 50, zBg2H = 80;
  ```
  OBJ z = `[20,40,70,100]`（Mode1専用）。`bg3Prio`（BGMODE bit3）が立っている場合のみ、BG3高優先度タイルが最前面（110）になる。
- **Mode 2 / 3-6**: `BG1=[30,60] BG2=[20,50]`。OBJ z = `[20,50,80,100]`。
- **Mode 7**: `renderMode7(line)` のみが呼ばれる（BG1が固定でz=15、`layerBuffer=1`）。

スプライト合成は全モード共通で、各OBJピクセルのz値（優先度0-3 → 上記OBJ zテーブルの該当値）と `zBuffer[x]`（その時点でのBG最前面z）を比較し、勝った方を`frameBuffer`/`layerBuffer`に書き込む。

### 4.4 `renderLayer` の内部処理

- **BG別パラメータ**: `scBase`(タイルマップベース), `charBase`(キャラクタデータベース), `bpp`, `paletteOffset`, `hScroll`/`vScroll` を算出。BPPルール: BG1はMode0で2bpp/Mode3,4で8bpp/その他4bpp、BG2はMode0,4,5で2bpp/その他4bpp、BG3はMode0,1で2bpp/その他4bpp、BG4は常に2bpp。
- **タイルサイズ**: `large = !!((bgmode >> (3+bgIndex)) & 1)`（bit4=BG1...bit7=BG4が16x16指定）。`large`時は16x16タイルを4枚の8x8サブタイルとして扱い、`tileIdx = tileIdxBase + subY*16 + subX`（flipX/flipYに応じてsubX/subYを反転）。
- **タイルマップ参照**: `screenSize`（0=32x32,1=64x32,2=32x64,3=64x64）に応じたページオフセットを加算し、`mapAddr = scBase + mapOff + (tileY*32+tileX)*2` からエントリを取得。エントリは `tileIdxBase`(bit0-9), `palIdx`(bit10-12), `prio`(bit13), `flipX`(bit14), `flipY`(bit15) を含む。
- **`getTilePixel(tileIdx, x, y, bpp, charBase)`**: `tileAddr = charBase + tileIdx*8*bpp`。プレーン0/1（常時）、bpp≥4ならプレーン2/3（+16バイト）、bpp==8ならプレーン4-7（+32/+48バイト）を読んでビットプレーンを合成し、8bitパレットインデックスを返す。
- **`colorFor`クロージャ**: bpp8はインデックスそのもの（256色直接）、bpp4は `paletteOffset + palIdx*16 + idx`、bpp2は `paletteOffset + palIdx*4 + idx`。
- **OPT（Offset-Per-Tile, Mode 2/4/6）**: BG3タイルマップの2行（`optHRow=(bg3vofs>>3)%g3MRows`, `optVRow=optHRow+1`）を事前読み込みし、画面列ごと（`ci`=0-31）にH/Vスクロールを上書きする。
  - **BG3列+1クォーク**: `g3c = ((g3Hofs>>3) + ci + 1) % g3MCols`（`ci`単独ではなく+1する必要がある — 実機のOPT列参照仕様）。
  - **有効ビット**: H/Vエントリそれぞれ `validBit = bgIndex===1 ? 0x2000 : 0x4000`（bit13=BG1有効, bit14=BG2有効）。有効なら `entry & 0x1FF` をスクロール値として使用、無効ならそのレイヤーのグローバルスクロールにフォールバック。

### 4.5 高解像度 Mode 5/6 BGレンダリング

`hires = (mode===5 && (bgIndex===1 || bgIndex===2)) || (mode===6 && bgIndex===1)`。

実機のMode5/6は512px幅で出力され、1つの8x8タイルマップセルが**16ピクセル幅**の領域（2枚の連続VRAMタイル `tileIdx`, `tileIdx+1` 分）に対応する。高解像度時は、512幅出力の各サブピクセル（`within256` = 0 or 1）に対し:

```js
let nativeCol = 2 * (rX & 7) + within256;
if (flipX) nativeCol = 15 - nativeCol;
const tile = nativeCol < 8 ? tileIdx : (tileIdx + 1) & 0x3FF;
const lx = nativeCol & 7;
```

として、16個のネイティブ列を512幅バッファの対応する出力列に直接書き込む（ダウンサンプリング/間引きを行わない）。非高解像度のBG（および他の全レイヤー）は1論理ピクセルを `o0=x256*2`/`o1=o0+1` の2出力列にコピーするピクセルダブリング方式。

> **既知の課題（未修正）**: RS3キャラクター作成画面のBG1（Mode5高解像度）には、上記の `tileIdx+1` 方式に起因する暗い縦帯が表示される。この方式は連続するVRAMタイル配置を前提とするが、RS3のBG1タイルマップは必ずしも連番でない（例: `tileIdx`列が `...,34,12,13,13,14,14,15,...`）ため、`(tileIdx+1)&0x3FF` が無関係/空白タイルを指してしまう。

### 4.6 ウィンドウマスクシステム

- **`inWindowRange(x, left, right)`**: `x>=left && x<=right` の単純な包含範囲判定。`left>right`（degenerate range）は常に`false`（ラップアラウンドなし）。

- **BGレイヤーのウィンドウ判定**（`renderLayer`内、`renderLayer`セットアップ部）: `w12sel=this.wbg12`($2123), `w34sel=this.wbg34`($2124), `wbglog=this.wbgobj`($212A) を参照。BG1の例:
  ```js
  w1E = (w12sel & 0x01)!==0; w1I = (w12sel & 0x08)===0;
  w2E = (w12sel & 0x04)!==0; w2I = (w12sel & 0x02)===0; logic = wbglog & 0x03;
  ```
  すなわち各BGに対応するニブルのビットを `(w1E,w1I,w2E,w2I) = (bit0, !bit3, bit2, !bit1)` として解釈する（BG2は`w12sel`の上位ニブル、BG3/BG4は`w34sel`の下位/上位ニブル、`logic`はBG1-4それぞれ`wbglog`の2bitフィールド）。
  - ピクセルごとに `in1 = w1E ? (w1I ? !inWindowRange(...) : inWindowRange(...)) : false`（in2も同様）。
  - 結合: `w1E&&!w2E → masked=in1`、`!w1E&&w2E → masked=in2`、両方有効なら `logic` に従い **0=AND, 1=OR, 2=XOR, 3=XNOR**。

- **OBJ/カラー演算ウィンドウ**（`renderPass`内、別ブロック）: `wobjsel=this.wobjsel`($2125), `wobjlog=this.wcolmath`($212B) を参照。BGとは異なるビット配置:
  ```js
  w1E = (wobjsel & 0x02)!==0; w1I = (wobjsel & 0x01)!==0;
  w2E = (wobjsel & 0x08)!==0; w2I = (wobjsel & 0x04)!==0;
  logic = wobjlog & 0x03;
  ```
  （`(bit1,bit0,bit3,bit2)`、かつ`w1I`/`w2I`は反転せず直接使用）。結合ロジックのコードも**BG側と逆**: **0=OR, 1=AND, 2=XOR, 3=XNOR**。

> この formula（`(bit0,!bit3,bit2,!bit1)` + AND/OR/XOR/XNOR=0/1/2/3）は、RS1の地図テラインマスキング欠落・境界ノイズ問題（2026-06-14d）とRS2のBARシーン全暗転問題（2026-06-14e、`w2I`の極性のみを反転）の修正を経て確定したもの。RS1/RS3/FF4/SMW/RS2の全ウィンドウ構成で検証済み。

### 4.7 カラー演算 (`applyColorMath`)

- **CGADSUB ($2131)**: bit7=減算(`isSub`)、bit6=ハーフカラー、bit0-5=対象レイヤー有効マスク（Backdrop=bit5, BG1=bit0, BG2=bit1, BG3=bit2, BG4=bit3, OBJパレット4-7=bit4。OBJパレット0-3は`objPalHighBuffer`により常に対象外）。
- **CGWSEL ($2130)**: bit4-5=演算有効条件（0=常に無効,1=ウィンドウ外のみ,2=ウィンドウ内のみ,3=常時）、bit6-7=クリップ条件（同パターン）、bit1=サブスクリーン使用フラグ（オフならCOLDATA固定色を使用）。
- カラー演算ウィンドウは4.6節のOBJ/カラー演算ウィンドウブロックを再利用。
- 演算は5bit空間（`r5=r>>3`等）で実施: 減算は0でクランプ、加算は31でクランプ。ハーフカラーは`>>1`（サブスクリーンが透明な場合はスキップ）。固定色COLDATAは `$2132` (`coldataR/G/B`) から構成。

### 4.8 Mode 7

レジスタ: `m7a/b/c/d`（`$211B-$211E`、16bit符号付き）、`m7x/m7y`（`$211F/$2120`、中心座標、13bit符号付き）、`m7hofs/m7vofs`（`$210D/$210E`）。

ピクセルごとの座標変換:
```js
let xx = ((actualSx+hScroll-cx)*a + (actualSy+vScroll-cy)*b) >> 8; xx += cx;
let yy = ((actualSx+hScroll-cx)*c + (actualSy+vScroll-cy)*d) >> 8; yy += cy;
```

**マップラップ修正**（2026-06-13、FF4飛空艇画面の崩壊修正）: `let tx = xx & 1023; let ty = yy & 1023;` —— 変換後座標を必ず1024x1024（128x128タイル）のマップ範囲に折り込む。これにより `repeatMode`(`(m7sel>>6)&3`) 0/1（ラップ）でも範囲外タイルコードを読まない。`repeatMode===2`（範囲外は透明、`pixelColorIdx=0`）、`repeatMode===3`（範囲外はタイル0）はラップ済みの`tx`/`ty`に加えて、未ラップの`xx`/`yy`から計算した`isOutOfBounds`で分岐する。出力はピクセルダブリング（`o0=sx*2, o1=o0+1`）、z=15固定、`layerBuffer=1`（BG1扱い）。

### 4.9 スプライト (OBJ)

- OAM: メインテーブル512バイト（4バイト/スプライト: X下位, Y, タイル番号, 属性）+ 高位テーブル32バイト（スプライトごとにXの最上位ビット1bit + サイズビット1bit）。
- `nameBase = (obsel&7)<<14`、`page1Offset = (((obsel>>3)&3)+1)<<13`（2つ目のキャラクタページオフセット）。
- サイズテーブル（`sizeSel=(obsel>>5)&7`）は8通りの小/大サイズ組み合わせ（例: `sizeSel=0`→8x8/16x16, `sizeSel=6`→16x32/32x64の矩形サイズ等）。
- 優先度 = `(attr>>4)&3`（2bit、4レベル）。スプライトはOAMインデックス127→0の順に評価し、インデックスの小さいもの（後に処理されるもの）が`objBuffer`/`objPrioBuffer`/`objPalHighBuffer`を上書き（=勝つ）。
- `palHigh = ((attr>>1)&7)>=4` でパレット4-7使用を示し、カラー演算の対象になる。

### `PriorityDebug.js` — BG/スプライト優先度デバッグツール

`globalThis.dumpPriorityInfo()` から呼び出す読み取り専用の診断ツール。224ライン全てを再描画して `zBuffer`/`layerBuffer`/`objBuffer`/`objPrioBuffer` を取得し、スプライトが描画された各ピクセルについて、独立実装した `bgPixelAt`（タイルマップ参照+`getTilePixel`の再実装）と `expectedBgZ`/`objZTable`（4.3節のzテーブルを再現）を使って「本来勝つべきBGタイル」を再計算する。`layerWon===5`（スプライト勝利）かつ不透明なprio=1のBGタイルの`expectedZ`がそれを上回る場合を `suspects` としてフラグし、savestate JSON + スクリーンショットPNGをブラウザダウンロードする。

---

## 5. APU (SPC700 コプロセッサ) & DSP

メインCPUから独立して動作するサウンドサブシステムです (`src/APU.js`, `src/DSP.js`)。

### 5.1 SPC700 コア (`APU.js`)

- **メモリ**: `Uint8Array(64*1024)` の単一空間。IPLブートROM（64バイト）は `control`（`$F1`）のbit7セット時に `$FFC0-$FFFF` にマップされる。
- **I/Oポート (`$00F0-$00FF`)**:
  - **CPU間通信**: メインCPU `$2140-$2143` ↔ SPC `$00F4-$00F7`。`apuPorts[]`（SPC→CPU方向、SPCが`$F4-F7`に書いた値をCPUが`readCPU`で読む）、`cpuPorts[]`/`cpuPortsLatch[]`（CPU→SPC方向、CPUが`writeCPU`で書いた値をSPCが`$F4-F7`で読む）。
  - `$F1`（CONTROL）のbit4/5は、それぞれ`$F4/$F5`・`$F6/$F7`の`cpuPorts`/`cpuPortsLatch`/RAMミラーをゼロクリアする（IPLハンドシェイクのACK動作を再現）。
  - 全てのMMIO書き込みは `ram[addr]` にもミラーされる（Snes9xのSMP実装と同様）。
- **タイマー**: `timers[]`（Timer0/1/2）、`timerTargets`（`$FA/$FB/$FC`書き込み）、`counter0/1/2`（`$FD/$FE/$FF`で読み取り、読むと0にリセットされる）。Timer0/1は128 APUサイクルごとに内部`counter`を進め（≈8kHz）、Timer2は16サイクルごと（≈64kHz）。`counter >= target`で出力カウンタをインクリメント。タイマー有効化の立ち上がりエッジで `ticks`/`counter`/出力カウンタをリセット。
- **命令ディスパッチ**: `this.opcodes = new Array(256)`、`initOpcodes()`が`OP(code, fn)`で各クロージャを`.bind(this)`して登録する配列方式。各ハンドラが直接 `this.cycles += N` する。
- **DSP連携**: `step()`内で命令1個ごとの `delta` サイクルを `dspCycles` に積算し、`dspCycles >= 32` ごとに `dsp.step()` を呼ぶ（32 APUサイクル = 32kHzサンプルレートに相当）。
- **同期**: `syncToCpuCycles(cpuCycles)` がメインループから呼ばれ、APU:CPU = 1024:3580 比率（Snes9x方式）で `step()` をループ。
- **リセット**: RAM/ポート類をゼロクリア、`PC=0xFFC0`（IPL ROMエントリ）、`A=X=Y=0, SP=0xEF, PSW=0x02`（Zフラグセット）、`control=0x80`。

> `APUTable.js`（14行）は初期の表駆動オペコード実装の試作で、現在は**未使用のデッドコード**（どこからもimportされていない）。

### 5.2 DSP (`DSP.js`)

- **Voice（8ch）**: 各`Voice`インスタンスは `volL/volR`, `pitch`(14bit), `srcn`, `adcr`(ADSR1+ADSR2), `gain`, `envx/outx`, `state`(`'STOP'|'ATTACK'|'DECAY'|'SUSTAIN'|'RELEASE'`), BRRデコード状態(`decodeOffset`, `brrLoopPtr`, `decoded`(Int32Array(16)), `decodeIdx`, `s1/s2`フィルタ履歴), 補間用 `history`(Int32Array(4))/`historyIdx`, `pitchCounter`, `envCounter` を保持。

- **BRRデコード** (`decodeBRR`): 9バイトブロック（ヘッダ1バイト + データ8バイト=16ニブル）。ヘッダから `shift`(bit4-7), `filter`(bit2-3), `isEnd`(bit0), `isLoop`(bit1) を取得。各ニブルを符号拡張し `sample = (n<<shift)>>1`（`shift<=12`時、それ以外は`±2048`にクランプ）。フィルタ式:
  - filter1: `sample += s1 + ((-s1)>>4)`
  - filter2: `sample += s1*2 + ((-s1*3)>>5) - s2 + (s2>>4)`
  - filter3: `sample += s1*2 + ((-s1*13)>>6) - s2 + ((s2*3)>>4)`
  
  結果は16bit符号付きにクランプ。`isEnd`時は`endx`ビットをセットし、`isLoop`なら`brrLoopPtr`へループ、そうでなければ`state='STOP'`。

- **ADSR/GAINエンベロープ** (`Voice.stepEnvelope`): **KOF（キーオフ、レジスタ`0x5C`）チェックを関数の先頭で行う**——`state==='RELEASE'`なら `envx -= 0x80`（0以下で`STOP`へ）して即return。これにより、GAINモードかADSRモードかに関わらず、キーオフ後は固定レート(-8/サンプル)でリリースする（2026-06-13修正、Shiren2の音楽不協和音問題の根本原因だったKOF無視バグの修正）。
  - GAINモード（`adsr1&0x80===0`）: `mode=gain>>5`。モード0-3=直接値設定、4=線形減少(-0x200)、5=指数減少(`-(envx>>8)-1`)、6=線形増加(+0x200)、7=ベントライン増加（`0x6000`未満+0x200／以上+0x080）。
  - ADSRモード: ATTACK（レート`(adsr1&0xF)*2+1`、`envx>=0x7FFF`でDECAYへ）→DECAY（レート`((adsr1>>4)&7)*2+16`、指数減少、`envx<=(sl+1)<<12`でSUSTAINへ）→SUSTAIN（レート`adsr2&0x1F`、指数減少継続）。

- **ピッチ/PMON（ピッチモジュレーション）**: `v.pitch`は14bit。`pmon`レジスタのビット`i`が立っている場合、ボイス`i`のピッチは前ボイスの`outx`（`pmon_pitch`）を使って `pitch += (pitch * (pmon_pitch>>5)) >> 10` のように変調される。

- **エコー (EDL/ESA/EON/EVOL/EFB/FIR)**: `edl`（`$7D`書き込み）から `echoLength = edl>0 ? edl*512 : 1`（1 EDL単位=2KB=512ステレオサンプル対=16ms、2026-06-13修正で4倍に修正——旧実装は`edl*128`で4ms単位だった）。リングバッファ`echoBuf`（Int32Array(16)、8タップ×L/R）に対し、8タップFIR（`dsp.fir[]`、レジスタ`0x0F,0x1F,...,0x7F`）を適用: `firL/firR = Σ(echoBuf[...] * fir[fi]) >> 6`、さらに`>>1 & ~1`して16bitクランプ。`efb`（エコーフィードバック）が書き戻し値に混合される。

- **KON/KOF/レジスタディスパッチ** (`write(addr,val)`): `voiceIdx<8 && reg<0x0A`はボイス個別レジスタ（`0x00`volL...`0x07`gain）。グローバルレジスタ: `0x4C`=KON（`state='ATTACK'`、各種状態リセット、サンプルディレクトリ`(dir<<8)+srcn*4`から`decodeOffset`/`brrLoopPtr`ロード）、`0x5C`=KOF（非STOPボイスを`state='RELEASE'`へ）、`0x6C`=FLG（`noiseRate`含む）、`0x7C`=ENDXクリア、`0x0D`=EFB、`0x2D`=PMON、`0x3D`=NON、`0x4D`=EON、`0x5D`=DIR、`0x6D`=ESA、`0x7D`=EDL、`0x0F..0x7F`(step 0x10)=FIR係数。

- **出力**: `sampleBufferL/R`(Float32Array(8192))、`samplePos`。`step()`の末尾でマスターボリューム・エコー適用後の `mOutL/mOutR`（±32768クランプ）を `/32768.0` して1ステレオサンプル対として書き込む（32 APUサイクルごと=32kHz）。

---

## 6. DSP-1 数学コプロセッサ (HLE)

`src/DSP1.js`（snes9xの`dsp1.cpp`/`dsp1.h`からのポート、NEC µPD96050ベースのDSP-1チップのHLE実装）。Super Mario Kart、Pilotwings等が使用。

- **インターフェース**: `setByte(byte)`/`getByte()` によるバイトストリームプロトコル。MMUからDR(`$6000-$6FFF`)に書かれたバイトが`setByte`、読まれるバイトが`getByte`に対応する（SRは前述の通りMMU側で`0x80`固定）。
  - `setByte`: `waiting4command`時はバイトをコマンドオペコードとして解釈し、コマンドごとに必要パラメータワード数(`inCount`、後でバイト数に倍化)を設定する巨大switch。`0x3a/0x2a/0x1a`は`0x1a`の別名、`0x17/0x37/0x3f`は`0x1f`（ファームウェアダンプ）にフォールスルー。パラメータが`parameters[]`に集まり`inCount===0`で`_execute()`を呼ぶ。
  - `getByte`: `output[]`から出力。コマンド`0x0a`/`0x1a`は最後のバイト出力時に`_rasterStep()`を呼んで次の8バイトを補充する（Mode7ラスター係数のストリーミング）。コマンド`0x1f`は`DSP1ROM`を16bitワード単位でバイトストリーミング。

- **`_execute()` ディスパッチ**: 約25種のコマンドグループ（多くは`0x00/0x10/0x20/0x30`ニブルバリアントが同じハンドラの別名）:
  - `0x00`/`0x20`: 乗算（Multiply / Multiply+1）
  - `0x10`/`0x30`: 逆数（`dspInverse`）
  - `0x04`/`0x24`: Sin/Cos × radius
  - `0x0a`/`0x1a`: ラスター（Mode7毎スキャンライン係数生成、`_rasterStep`/`_raster`が`[A,B,C,D]`を返す）
  - `0x02/0x12/0x22/0x32`: パラメータ設定（Mode7投影セットアップ — `CentreX/Y`, `VPlane_C/E`, `SinAas/CosAas`等）
  - `0x06/0x16/0x26/0x36`: Project（オブジェクト座標→画面座標、`_project`が`[H,V,M]`を返す）
  - `0x0e/0x1e/0x2e/0x3e`: Target（画面座標→ワールド座標、`_target`が`[X,Y]`を返す）
  - 姿勢/客観/主観行列変換（`_attitudeMatrix`/`_objective`/`_subjective`）、2D/3D回転（`_polarRotate`）、回転角補正（`_rotationCorrection`）
  - `0x1f`系: ファームウェアROMダンプ（`DSP1ROM`から2048バイト）

- **ルックアップテーブル**:
  - `DSP1ROM`（`Uint16Array`、約1024要素）: 実機DSP-1のファームウェアROMデータ（逆数計算のNewton法初期値、正規化シフトテーブル、Sinテーブル領域等を含む）。
  - `MUL_TABLE`（`Int16Array[256]`）: `dspSin`/`dspCos`の補間に使う乗算補正テーブル。
  - `SIN_TABLE`（`Int16Array[256]`）: サインカーブテーブル。

- **数学ヘルパー**: `dspSin`/`dspCos`（テーブル+線形補間）、`dspInverse`（正規化+Newton-Raphson法による固定小数点逆数）、`dspNormalize`/`dspNormalizeDouble`（16bit/32bit値の正規化とシフト数計算）、`dspTruncate`/`dspShiftR`（飽和/固定小数点シフト）。これらを組み合わせて`_attitudeMatrix`等の3D回転・投影演算を実現している。

---

## 7. セーブステート (`src/SaveState.js`)

`captureState(snes)` / `restoreState(snes, state)` による、各コンポーネントの「フラットフィールドスナップショット」方式。

- **`snapshotFlat(obj, skip)`**: `Object.keys(obj)` を走査し、プリミティブ値はそのまま、`TypedArray`は`encodeTypedArray`でBase64エンコード（`{__ta: "Uint8Array", b64: "..."}`形式、32KBチャンクで`String.fromCharCode`→`btoa`）、プレーン配列は`.slice()`コピー。それ以外（ネストオブジェクト、関数、相互参照）は無視される。
- **`restoreFlat(obj, data)`**: `__ta`フィールドを`decodeTypedArray`で復元し、既存の配列に`.set()`で書き込む（型配列の再割当を避け、`MMU`↔`PPU`↔`DSP`間の相互参照を保ったまま復元）。

トップレベル構造:
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

**除外フィールド（スキップリスト）**:
- `PPU_SKIP`: `frameBuffer/zBuffer/layerBuffer/objBuffer/objPrioBuffer/objPalHighBuffer` — 毎フレーム再構築されるスクラッチバッファ。
- `MMU_SKIP`: `ppu/apu/rom/dma` — クロスリファレンスと不変のROMイメージ（`dma`は別途配列で復元）。
- `APU_SKIP`: `dsp/bootRom/timers` — `dsp`は再帰的に復元、`bootRom`は定数、`timers`は別途復元。
- `DSP_SKIP`: `apu_ram/gauss/sampleBufferL/sampleBufferR/voices` — `apu_ram`は`apu.ram`への参照で再リンク、`gauss`は定数テーブル、サンプルバッファは一時オーディオスクラッチ、`voices`は個別復元。

`restoreState`は`version!==1`なら例外をthrow。Voice配列は`Voice`クラスのメソッドを保持したまま各フィールドのみ`restoreFlat`で復元し、復元後`dsp.samplePos=0`にリセットする。

---

## 8. UI・メインループ (`src/main.js`)

### 8.1 描画

- `new SNES()` を `globalThis.snes` として生成・公開（`globalThis._snesCPU = snes.cpu` も公開）。
- Canvasは512x224、`ctx.createImageData(512,224)` の`data.buffer`を`Uint32Array`(`buf32`)としてビューし、毎フレーム `buf32.set(snes.ppu.frameBuffer)` → `ctx.putImageData(...)` で高速blit。
- メインループ `loop()` は `requestAnimationFrame` ベース。`running`フラグで制御。`startEmulation()`は`romLoaded`が`false`なら開始しない（日本語メッセージで案内）。
- `console.log`をモンキーパッチし、`globalThis._verbose`が`false`の間はタグ付き（`[APU]`等）デバッグログを抑制。

### 8.2 オーディオ

- `ScriptProcessorNode(2048, 0, 2)`（ステレオ出力）+ `GainNode`（2倍ブースト）。
- `audioRingL`/`audioRingR`（`Float32Array(65536)`）に`snes.getAudioSamples()`の出力を蓄積（リングフル時はドロップ）。
- `onaudioprocess`内で、DSPのネイティブ32kHzから`audioContext.sampleRate`への**線形補間リサンプリング**を実施。
- `AudioContext`はユーザー操作前は`suspended`のため、`tryAutoStartAfterLoad()`（ROM読込後）と`handleFirstAudioActivation`（最初のクリック/キー入力）の2経路で`resume()`し、`startEmulation()`を呼ぶ。

### 8.3 ROM読み込みUI

- 対応拡張子: `.sfc`/`.smc`。`window.showDirectoryPicker()`（File System Access API）優先、非対応/エラー時は`<input type="file" webkitdirectory multiple>`にフォールバック。ドラッグ&ドロップにも対応。
- ROMリストは**五十音/アルファベット順**にソート（`localeCompare(..., 'ja', {numeric:true, sensitivity:'base'})`）してボタン一覧表示。
- `loadRomBytes()`が実行中ループを止めて`snes.loadRom()`を呼び、`romLoaded=true`にして自動起動を試みる。

### 8.4 入力処理

`keydown`/`keyup`は`document.activeElement !== canvas`の場合は無視する（フォーカスガード）。キー対応表:

| キー (`e.code`) | SNESボタン | ビットマスク |
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

`window`/`canvas`の`blur`イベントで`snes.mmu.joy1=0`にリセット（スクリーンショット操作等でフォーカスが外れてもボタン押下状態が残らないようにする）。F5/F8でクイックセーブ/ロード（10スロット、`localStorage`にROM名+スロット番号で保存）。

### 8.5 デバッグ/開発者ツール (`globalThis`)

- `dumpPriorityInfo()` — BG/スプライト優先度診断（`PriorityDebug.js`、4.9節）。
- `dumpSaveState()` — `captureState()`のJSONとcanvasスクリーンショットPNGをダウンロード。**クラッシュ時（`loop()`の catch節）に自動実行**され、オフラインバグ報告用のデータを残す。
- `portLogStart/Stop/Dump/Save` — CPU→APU通信ポート書き込みのロギング。
- `spcDump(name)` — `spc_dump.js`の`dumpSpc()`でAPU状態を`.spc`形式でダウンロード。

### 8.6 クラッシュ処理

`loop()`のcatch節で「Runtime Error」をログ→`dumpSaveState()`を自動実行（失敗時は`[dumpSaveState on crash] failed`をログ）→ Canvas全体を赤く塗り「CRASH: ...」を表示して`running=false`（ループは再開しない）。

### 8.7 その他のUI機能

- トースト通知（`showToast`、1.8秒表示）。
- バッテリーSRAMのエクスポート/インポート（`.srm`/`.sav`ファイル）。
- リセットボタン（`snes.reset()`を呼び出し、ループ自体は再起動しない）。
- フレームカウンタ診断: 60フレームごと（最初の120フレームは毎フレーム）にPC/PB/INIDISP/MODE/TM/stopped状態をログ。180フレーム同じPCに留まっていれば「スタックしたCPU」として`nmitimen`/`INIDISP`/PC/`waiting`をログ。

---

## 9. タイミングと同期 (Synchronization)

- **1フレーム**: 262スキャンライン × 約227 CPUサイクル/ライン ≈ 約59,474 CPUサイクル（簡略化モデル。実機NTSCの約357,368 master clocksに相当する近似値）。
- **CPU↔PPU**: `cpu.step()`の戻りサイクル数をもとに`ppu.vcounter`/`ppu.hcounter`を更新し、HBlank（`lineCycles>=137`）/VBlank（`line>=225`）のフラグ（`hvbjoy`）を都度更新。
- **CPU↔APU**: APUは「CPUが進んだサイクル数 × 1024/3580」を目標値として`apu.step()`を追いつかせる、固定比率の疎結合シンクロ。
- **APU↔DSP**: APU側で32 APUサイクルごとに`dsp.step()`を1回呼び、32kHzのサンプルストリームを生成。
- **HDMA**: 各可視ラインのH-Blankで`doHDMA()`を実行——CGRAM/VRAM転送等のラスタータイミング依存エフェクト（ウィンドウアニメーション、グラデーション等）の正確性に直結する。

---

## 10. 既知の課題・デバッグ計装に関する注記

- **WRAM電源投入時パターンの欠落（回帰）**: 3.1節記載の通り、DSP-1リファクタ時に誤って削除され、現在WRAMは全ゼロ初期化（`test_wram_poweron.mjs`失敗）。Chrono TriggerのBRKループ修正で導入された非ゼロパターンが必要。
- **Mode5/6高解像度BG1のタイル隣接仮定**: 4.5節記載の通り、`tileIdx+1`方式は連番タイル配置を前提とし、RS3キャラ作成画面で暗帯として現れる（未修正）。
- **デバッグ計装**: `CPU.js`/`MMU.js`/`PPU.js`/`main.js`には、特定ROM・特定アドレスを対象としたウォッチポイント/トレース/ロギングコードが多数残存している（2.6節・3.7節参照）。多くは`globalThis._xxx`フラグで条件化されているが、一部（ROM読み込み時のログ等）は無条件出力。コア機能とは独立しており、削除してもエミュレーション結果には影響しない。
- **SA-1コプロセッサ未実装**: 星のカービィ スーパーデラックス等のSA-1搭載カートは、SA-1の第2CPUコア/I-RAM/レジスタが完全に未実装のため、起動時に強制ブランクのまま停止する（対応する場合は新規サブシステムとして実装が必要）。
