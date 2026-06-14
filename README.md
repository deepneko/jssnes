# jssnes

A browser-based Super Nintendo Entertainment System (SNES) emulator written in JavaScript and Vite.

A live demo is available at https://jssnes.dev/.

## Current Features

- **CPU**: Full Ricoh 5A22 / 65816 instruction set, with an instruction-level cycle model (direct-page and page-crossing penalties, MVN/MVP block moves, decimal mode, WAI/STP, NMI/IRQ/BRK/COP)
- **PPU**: BG Modes 0-7, including Mode 7 with map-wrap correction and high-resolution Mode 5/6, per-mode layer priority, window masking, and color math
- **MMU**: LoROM/HiROM auto-detection, general-purpose DMA, and H-Blank DMA (HDMA) with EACH/REPEAT support
- **APU/DSP**: SPC700 sound CPU and 8-voice DSP with BRR sample decoding, ADSR/GAIN envelopes, pitch modulation, and echo/FIR
- **DSP-1**: HLE math coprocessor support for titles such as Super Mario Kart and Pilotwings
- Quick Save/Load (10 slots, persisted in `localStorage`)
- Battery SRAM export/import (`.srm` / `.sav` files)
- Crash diagnostics: automatic save-state and screenshot dump on error

## Save System

This emulator has two independent save mechanisms:

- **Quick Save/Load**: <kbd>F5</kbd> saves and <kbd>F8</kbd> loads a full emulator
  snapshot (CPU/PPU/MMU/APU/DSP state) to `localStorage`, keyed by ROM name and slot.
- **Battery Save (SRAM)**: in-game battery-backed save data can be exported to and
  imported from `.srm` / `.sav` files for titles that use cartridge SRAM.

## Usage

1. Place your legally obtained SNES ROM files (`.sfc` or `.smc`) in a folder.
2. Open the emulator in your browser and choose that folder (via the folder
   picker, file input, or by dragging files onto the page).
3. Select a ROM from the list to load it.
4. Click the canvas once to enable audio (required by browser autoplay policies).

## Controls

| Key | SNES Input |
|---|---|
| Arrow keys | D-Pad |
| <kbd>Z</kbd> | B |
| <kbd>X</kbd> | A |
| <kbd>A</kbd> | Y |
| <kbd>S</kbd> | X |
| <kbd>Q</kbd> | L |
| <kbd>W</kbd> | R |
| <kbd>Enter</kbd> | Start |
| <kbd>Shift</kbd> | Select |
| <kbd>F5</kbd> / <kbd>F8</kbd> | Quick Save / Quick Load |

## Development

```bash
npm install      # install dependencies
npm run dev      # start the Vite dev server
npm run build    # production build
npm run preview  # preview the production build
npm start        # run server.js (used for Heroku deployment)
```

## Notes

- Folder loading uses the File System Access API (`showDirectoryPicker`), which
  is best supported in Chromium-based browsers; other browsers fall back to a
  standard file input or drag-and-drop.
- Audio playback only starts after a user gesture (click or key press), per
  browser autoplay restrictions.

## Tested Games

| | | |
|---|---|---|
| <img src="https://raw.githubusercontent.com/deepneko/jssnes/images/images/chrono_trigger.png" width="200"> | <img src="https://raw.githubusercontent.com/deepneko/jssnes/images/images/dq5.png" width="200"> | <img src="https://raw.githubusercontent.com/deepneko/jssnes/images/images/dq6.png" width="200"> |
| <img src="https://raw.githubusercontent.com/deepneko/jssnes/images/images/ff4.png" width="200"> | <img src="https://raw.githubusercontent.com/deepneko/jssnes/images/images/ff5.png" width="200"> | <img src="https://raw.githubusercontent.com/deepneko/jssnes/images/images/ff6.png" width="200"> |
| <img src="https://raw.githubusercontent.com/deepneko/jssnes/images/images/mario_world.png" width="200"> | <img src="https://raw.githubusercontent.com/deepneko/jssnes/images/images/rockmanx.png" width="200"> | <img src="https://raw.githubusercontent.com/deepneko/jssnes/images/images/rs1.png" width="200"> |
| <img src="https://raw.githubusercontent.com/deepneko/jssnes/images/images/rs2.png" width="200"> | <img src="https://raw.githubusercontent.com/deepneko/jssnes/images/images/secret_of_mana.png" width="200"> | <img src="https://raw.githubusercontent.com/deepneko/jssnes/images/images/torneko.png" width="200"> |
| <img src="https://raw.githubusercontent.com/deepneko/jssnes/images/images/zelda.png" width="200"> | | |

## References

- [fullsnes - SNES/Super Famicom Programming Manual](https://problemkaputt.de/fullsnes.htm)
- [SNES Development Wiki](https://snes.nesdev.org/wiki/Main_Page)

## Disclaimer

This project is for educational and research purposes. It does not include any
copyrighted ROMs or assets. Please only use ROMs of games you legally own.

## License

MIT. See [LICENSE](LICENSE).
