# jssnes

A JavaScript-based Super Nintendo Entertainment System (SNES) emulator.

## Overview
This project is an experimental SNES emulator written entirely in JavaScript. It aims to accurately emulate the core components of the hardware, including the CPU, PPU (graphics, background scrolling, color math), MMU (memory mapping, LoROM/HiROM), and APU.

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (for dependency management)

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/deepneko/jssnes.git
   cd jssnes
   ```
2. Install dependencies:
   ```bash
   npm install
   ```

### Usage
1. Create a `rom/` directory in the root of the project (if it doesn't exist).
2. Place your legally obtained SNES ROM files (`.sfc` or `.smc`) inside the `rom/` directory.
3. Open or serve `index.html` using a local web server to run the emulator in your browser.

## Project Structure
- `src/` - Core emulator source code (`CPU.js`, `PPU.js`, `MMU.js`, `APU.js`, etc.)
- `rom/` - Directory for placing ROMs (ignored by Git)
- `index.html` - Main web interface for the emulator

## Disclaimer
This project is for educational and research purposes. It does not include any copyrighted ROMs or assets. Please only use ROMs of games you legally own.
