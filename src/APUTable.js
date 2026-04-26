// Table-driven opcode generator
export const OPCODES = new Array(256);

// Fill with unimplemented by default
for (let i = 0; i < 256; i++) {
    OPCODES[i] = function(apu) {
        // console.warn(`Unimplemented opcode ${i.toString(16)}`);
        apu.cycles += 2;
    };
}

// Define helper for addressing modes to fetch/write
// Actually, since we rewrite, maybe bind the methods.
// I will implement a more advanced one.
