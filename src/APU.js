export class APU {
  constructor() {
    this.ram = new Uint8Array(64 * 1024); // 64KB Audio RAM
    // SPC700 specific registers
    this.PC = 0;
    this.A = 0;
    this.X = 0;
    this.Y = 0;
    this.SP = 0;
    this.PSW = 0;
    
    // Communication Ports ($2140-$2143)
    this.cpuPorts = new Uint8Array(4); // CPU Writes, APU Reads
    this.apuPorts = new Uint8Array(4); // APU Writes, CPU Reads
    
    // Initialize for handshake simulation (AA, BB)
    this.apuPorts[0] = 0xAA;
    this.apuPorts[1] = 0xBB;
  }
  
  reset() {
      // console.log("APU Reset: Setting ports to AA/BB");
      this.apuPorts.fill(0);
      this.cpuPorts.fill(0);
      this.apuPorts[0] = 0xAA;
      this.apuPorts[1] = 0xBB;
      
      // Also ensure the "fake" read buffer is set if using simple RAM?
      // No, MMU calls read().
  }

  read(addr) {
      // CPU reads APU ports (from APU)
      let val = this.apuPorts[addr & 3];
      // Dummy APU Hack for games waiting for APU responses
      // If CPU is polling, usually it compares it with some internal WRAM value.
      // We can try to randomly return non-zero maybe? No, that breaks boot.
      if (globalThis._snesCPU && this.booted) {
          const pc = globalThis._snesCPU.PC;
          // Zelda N-SPC Audio command ack wait loops (0x80e4: CMP $0133, 0x810b: CMP $0134)
          if ((addr & 3) === 0 && (pc === 0x80e1 || pc === 0x80e4)) {
             if (globalThis._snesMMU) val = globalThis._snesMMU.wram[0x0133];
          }
          if ((addr & 3) === 1 && (pc === 0x8108 || pc === 0x810b)) {
             if (globalThis._snesMMU) val = globalThis._snesMMU.wram[0x0134];
          }
      }
      return val;
  }
  
  write(addr, val) {
      this.cpuPorts[addr & 3] = val;
      let port = addr & 3;
      
      if (!this.booted && port === 0 && val === 0xCC) {
          this.booted = true;
      }
      
      if (this.booted) {
          this.apuPorts[port] = val;
      } else {
          // not booted yet, ignore 0 writes to preserve AA/BB
          if (val !== 0) {
              this.apuPorts[port] = val;
          }
      }
  }

  step() {
    // Run SPC700 instruction
  }
}
