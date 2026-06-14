// DSP-1 math coprocessor High-Level Emulation.
// Command set and fixed-point algorithms ported from the snes9x DSP1 HLE core
// (dsp1.cpp), which itself is the result of community reverse-engineering of
// the real NEC uPD96050-based DSP-1 chip used by Super Mario Kart, Pilotwings,
// Ace o Nerae!, etc.
//
// Register interface (as seen by the SNES CPU):
//   DR (Data Register)   - mirrored across $xx:6000-$xx:6FFF, read/write, byte granularity
//   SR (Status Register) - mirrored across $xx:7000-$xx:7FFF, read-only, always 0x80
//                           (bit7 set => Rqm=1 => "ready", so LDA/BPL polling loops exit immediately)

function i16(x) {
  return (x << 16) >> 16;
}

function i32(x) {
  return x | 0;
}

function readWord(arr, offset) {
  return arr[offset] | (arr[offset + 1] << 8);
}

function writeWord(arr, offset, value) {
  arr[offset] = value & 0xFF;
  arr[offset + 1] = (value >> 8) & 0xFF;
}

const DSP1ROM = new Uint16Array([
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0001, 0x0002, 0x0004, 0x0008, 0x0010, 0x0020,
  0x0040, 0x0080, 0x0100, 0x0200, 0x0400, 0x0800, 0x1000, 0x2000,
  0x4000, 0x7fff, 0x4000, 0x2000, 0x1000, 0x0800, 0x0400, 0x0200,
  0x0100, 0x0080, 0x0040, 0x0020, 0x0001, 0x0008, 0x0004, 0x0002,
  0x0001, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x8000, 0xffe5, 0x0100, 0x7fff, 0x7f02, 0x7e08,
  0x7d12, 0x7c1f, 0x7b30, 0x7a45, 0x795d, 0x7878, 0x7797, 0x76ba,
  0x75df, 0x7507, 0x7433, 0x7361, 0x7293, 0x71c7, 0x70fe, 0x7038,
  0x6f75, 0x6eb4, 0x6df6, 0x6d3a, 0x6c81, 0x6bca, 0x6b16, 0x6a64,
  0x69b4, 0x6907, 0x685b, 0x67b2, 0x670b, 0x6666, 0x65c4, 0x6523,
  0x6484, 0x63e7, 0x634c, 0x62b3, 0x621c, 0x6186, 0x60f2, 0x6060,
  0x5fd0, 0x5f41, 0x5eb5, 0x5e29, 0x5d9f, 0x5d17, 0x5c91, 0x5c0c,
  0x5b88, 0x5b06, 0x5a85, 0x5a06, 0x5988, 0x590b, 0x5890, 0x5816,
  0x579d, 0x5726, 0x56b0, 0x563b, 0x55c8, 0x5555, 0x54e4, 0x5474,
  0x5405, 0x5398, 0x532b, 0x52bf, 0x5255, 0x51ec, 0x5183, 0x511c,
  0x50b6, 0x5050, 0x4fec, 0x4f89, 0x4f26, 0x4ec5, 0x4e64, 0x4e05,
  0x4da6, 0x4d48, 0x4cec, 0x4c90, 0x4c34, 0x4bda, 0x4b81, 0x4b28,
  0x4ad0, 0x4a79, 0x4a23, 0x49cd, 0x4979, 0x4925, 0x48d1, 0x487f,
  0x482d, 0x47dc, 0x478c, 0x473c, 0x46ed, 0x469f, 0x4651, 0x4604,
  0x45b8, 0x456c, 0x4521, 0x44d7, 0x448d, 0x4444, 0x43fc, 0x43b4,
  0x436d, 0x4326, 0x42e0, 0x429a, 0x4255, 0x4211, 0x41cd, 0x4189,
  0x4146, 0x4104, 0x40c2, 0x4081, 0x4040, 0x3fff, 0x41f7, 0x43e1,
  0x45bd, 0x478d, 0x4951, 0x4b0b, 0x4cbb, 0x4e61, 0x4fff, 0x5194,
  0x5322, 0x54a9, 0x5628, 0x57a2, 0x5914, 0x5a81, 0x5be9, 0x5d4a,
  0x5ea7, 0x5fff, 0x6152, 0x62a0, 0x63ea, 0x6530, 0x6672, 0x67b0,
  0x68ea, 0x6a20, 0x6b53, 0x6c83, 0x6daf, 0x6ed9, 0x6fff, 0x7122,
  0x7242, 0x735f, 0x747a, 0x7592, 0x76a7, 0x77ba, 0x78cb, 0x79d9,
  0x7ae5, 0x7bee, 0x7cf5, 0x7dfa, 0x7efe, 0x7fff, 0x0000, 0x0324,
  0x0647, 0x096a, 0x0c8b, 0x0fab, 0x12c8, 0x15e2, 0x18f8, 0x1c0b,
  0x1f19, 0x2223, 0x2528, 0x2826, 0x2b1f, 0x2e11, 0x30fb, 0x33de,
  0x36ba, 0x398c, 0x3c56, 0x3f17, 0x41ce, 0x447a, 0x471c, 0x49b4,
  0x4c3f, 0x4ebf, 0x5133, 0x539b, 0x55f5, 0x5842, 0x5a82, 0x5cb4,
  0x5ed7, 0x60ec, 0x62f2, 0x64e8, 0x66cf, 0x68a6, 0x6a6d, 0x6c24,
  0x6dca, 0x6f5f, 0x70e2, 0x7255, 0x73b5, 0x7504, 0x7641, 0x776c,
  0x7884, 0x798a, 0x7a7d, 0x7b5d, 0x7c29, 0x7ce3, 0x7d8a, 0x7e1d,
  0x7e9d, 0x7f09, 0x7f62, 0x7fa7, 0x7fd8, 0x7ff6, 0x7fff, 0x7ff6,
  0x7fd8, 0x7fa7, 0x7f62, 0x7f09, 0x7e9d, 0x7e1d, 0x7d8a, 0x7ce3,
  0x7c29, 0x7b5d, 0x7a7d, 0x798a, 0x7884, 0x776c, 0x7641, 0x7504,
  0x73b5, 0x7255, 0x70e2, 0x6f5f, 0x6dca, 0x6c24, 0x6a6d, 0x68a6,
  0x66cf, 0x64e8, 0x62f2, 0x60ec, 0x5ed7, 0x5cb4, 0x5a82, 0x5842,
  0x55f5, 0x539b, 0x5133, 0x4ebf, 0x4c3f, 0x49b4, 0x471c, 0x447a,
  0x41ce, 0x3f17, 0x3c56, 0x398c, 0x36ba, 0x33de, 0x30fb, 0x2e11,
  0x2b1f, 0x2826, 0x2528, 0x2223, 0x1f19, 0x1c0b, 0x18f8, 0x15e2,
  0x12c8, 0x0fab, 0x0c8b, 0x096a, 0x0647, 0x0324, 0x7fff, 0x7ff6,
  0x7fd8, 0x7fa7, 0x7f62, 0x7f09, 0x7e9d, 0x7e1d, 0x7d8a, 0x7ce3,
  0x7c29, 0x7b5d, 0x7a7d, 0x798a, 0x7884, 0x776c, 0x7641, 0x7504,
  0x73b5, 0x7255, 0x70e2, 0x6f5f, 0x6dca, 0x6c24, 0x6a6d, 0x68a6,
  0x66cf, 0x64e8, 0x62f2, 0x60ec, 0x5ed7, 0x5cb4, 0x5a82, 0x5842,
  0x55f5, 0x539b, 0x5133, 0x4ebf, 0x4c3f, 0x49b4, 0x471c, 0x447a,
  0x41ce, 0x3f17, 0x3c56, 0x398c, 0x36ba, 0x33de, 0x30fb, 0x2e11,
  0x2b1f, 0x2826, 0x2528, 0x2223, 0x1f19, 0x1c0b, 0x18f8, 0x15e2,
  0x12c8, 0x0fab, 0x0c8b, 0x096a, 0x0647, 0x0324, 0x0000, 0xfcdc,
  0xf9b9, 0xf696, 0xf375, 0xf055, 0xed38, 0xea1e, 0xe708, 0xe3f5,
  0xe0e7, 0xdddd, 0xdad8, 0xd7da, 0xd4e1, 0xd1ef, 0xcf05, 0xcc22,
  0xc946, 0xc674, 0xc3aa, 0xc0e9, 0xbe32, 0xbb86, 0xb8e4, 0xb64c,
  0xb3c1, 0xb141, 0xaecd, 0xac65, 0xaa0b, 0xa7be, 0xa57e, 0xa34c,
  0xa129, 0x9f14, 0x9d0e, 0x9b18, 0x9931, 0x975a, 0x9593, 0x93dc,
  0x9236, 0x90a1, 0x8f1e, 0x8dab, 0x8c4b, 0x8afc, 0x89bf, 0x8894,
  0x877c, 0x8676, 0x8583, 0x84a3, 0x83d7, 0x831d, 0x8276, 0x81e3,
  0x8163, 0x80f7, 0x809e, 0x8059, 0x8028, 0x800a, 0x6488, 0x0080,
  0x03ff, 0x0116, 0x0002, 0x0080, 0x4000, 0x3fd7, 0x3faf, 0x3f86,
  0x3f5d, 0x3f34, 0x3f0c, 0x3ee3, 0x3eba, 0x3e91, 0x3e68, 0x3e40,
  0x3e17, 0x3dee, 0x3dc5, 0x3d9c, 0x3d74, 0x3d4b, 0x3d22, 0x3cf9,
  0x3cd0, 0x3ca7, 0x3c7f, 0x3c56, 0x3c2d, 0x3c04, 0x3bdb, 0x3bb2,
  0x3b89, 0x3b60, 0x3b37, 0x3b0e, 0x3ae5, 0x3abc, 0x3a93, 0x3a69,
  0x3a40, 0x3a17, 0x39ee, 0x39c5, 0x399c, 0x3972, 0x3949, 0x3920,
  0x38f6, 0x38cd, 0x38a4, 0x387a, 0x3851, 0x3827, 0x37fe, 0x37d4,
  0x37aa, 0x3781, 0x3757, 0x372d, 0x3704, 0x36da, 0x36b0, 0x3686,
  0x365c, 0x3632, 0x3609, 0x35df, 0x35b4, 0x358a, 0x3560, 0x3536,
  0x350c, 0x34e1, 0x34b7, 0x348d, 0x3462, 0x3438, 0x340d, 0x33e3,
  0x33b8, 0x338d, 0x3363, 0x3338, 0x330d, 0x32e2, 0x32b7, 0x328c,
  0x3261, 0x3236, 0x320b, 0x31df, 0x31b4, 0x3188, 0x315d, 0x3131,
  0x3106, 0x30da, 0x30ae, 0x3083, 0x3057, 0x302b, 0x2fff, 0x2fd2,
  0x2fa6, 0x2f7a, 0x2f4d, 0x2f21, 0x2ef4, 0x2ec8, 0x2e9b, 0x2e6e,
  0x2e41, 0x2e14, 0x2de7, 0x2dba, 0x2d8d, 0x2d60, 0x2d32, 0x2d05,
  0x2cd7, 0x2ca9, 0x2c7b, 0x2c4d, 0x2c1f, 0x2bf1, 0x2bc3, 0x2b94,
  0x2b66, 0x2b37, 0x2b09, 0x2ada, 0x2aab, 0x2a7c, 0x2a4c, 0x2a1d,
  0x29ed, 0x29be, 0x298e, 0x295e, 0x292e, 0x28fe, 0x28ce, 0x289d,
  0x286d, 0x283c, 0x280b, 0x27da, 0x27a9, 0x2777, 0x2746, 0x2714,
  0x26e2, 0x26b0, 0x267e, 0x264c, 0x2619, 0x25e7, 0x25b4, 0x2581,
  0x254d, 0x251a, 0x24e6, 0x24b2, 0x247e, 0x244a, 0x2415, 0x23e1,
  0x23ac, 0x2376, 0x2341, 0x230b, 0x22d6, 0x229f, 0x2269, 0x2232,
  0x21fc, 0x21c4, 0x218d, 0x2155, 0x211d, 0x20e5, 0x20ad, 0x2074,
  0x203b, 0x2001, 0x1fc7, 0x1f8d, 0x1f53, 0x1f18, 0x1edd, 0x1ea1,
  0x1e66, 0x1e29, 0x1ded, 0x1db0, 0x1d72, 0x1d35, 0x1cf6, 0x1cb8,
  0x1c79, 0x1c39, 0x1bf9, 0x1bb8, 0x1b77, 0x1b36, 0x1af4, 0x1ab1,
  0x1a6e, 0x1a2a, 0x19e6, 0x19a1, 0x195c, 0x1915, 0x18ce, 0x1887,
  0x183f, 0x17f5, 0x17ac, 0x1761, 0x1715, 0x16c9, 0x167c, 0x162e,
  0x15df, 0x158e, 0x153d, 0x14eb, 0x1497, 0x1442, 0x13ec, 0x1395,
  0x133c, 0x12e2, 0x1286, 0x1228, 0x11c9, 0x1167, 0x1104, 0x109e,
  0x1036, 0x0fcc, 0x0f5f, 0x0eef, 0x0e7b, 0x0e04, 0x0d89, 0x0d0a,
  0x0c86, 0x0bfd, 0x0b6d, 0x0ad6, 0x0a36, 0x098d, 0x08d7, 0x0811,
  0x0736, 0x063e, 0x0519, 0x039a, 0x0000, 0x7fff, 0x0100, 0x0080,
  0x021d, 0x00c8, 0x00ce, 0x0048, 0x0a26, 0x277a, 0x00ce, 0x6488,
  0x14ac, 0x0001, 0x00f9, 0x00fc, 0x00ff, 0x00fc, 0x00f9, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff
]);

const MUL_TABLE = new Int16Array([
  0x0000, 0x0003, 0x0006, 0x0009, 0x000c, 0x000f, 0x0012, 0x0015,
  0x0019, 0x001c, 0x001f, 0x0022, 0x0025, 0x0028, 0x002b, 0x002f,
  0x0032, 0x0035, 0x0038, 0x003b, 0x003e, 0x0041, 0x0045, 0x0048,
  0x004b, 0x004e, 0x0051, 0x0054, 0x0057, 0x005b, 0x005e, 0x0061,
  0x0064, 0x0067, 0x006a, 0x006d, 0x0071, 0x0074, 0x0077, 0x007a,
  0x007d, 0x0080, 0x0083, 0x0087, 0x008a, 0x008d, 0x0090, 0x0093,
  0x0096, 0x0099, 0x009d, 0x00a0, 0x00a3, 0x00a6, 0x00a9, 0x00ac,
  0x00af, 0x00b3, 0x00b6, 0x00b9, 0x00bc, 0x00bf, 0x00c2, 0x00c5,
  0x00c9, 0x00cc, 0x00cf, 0x00d2, 0x00d5, 0x00d8, 0x00db, 0x00df,
  0x00e2, 0x00e5, 0x00e8, 0x00eb, 0x00ee, 0x00f1, 0x00f5, 0x00f8,
  0x00fb, 0x00fe, 0x0101, 0x0104, 0x0107, 0x010b, 0x010e, 0x0111,
  0x0114, 0x0117, 0x011a, 0x011d, 0x0121, 0x0124, 0x0127, 0x012a,
  0x012d, 0x0130, 0x0133, 0x0137, 0x013a, 0x013d, 0x0140, 0x0143,
  0x0146, 0x0149, 0x014d, 0x0150, 0x0153, 0x0156, 0x0159, 0x015c,
  0x015f, 0x0163, 0x0166, 0x0169, 0x016c, 0x016f, 0x0172, 0x0175,
  0x0178, 0x017c, 0x017f, 0x0182, 0x0185, 0x0188, 0x018b, 0x018e,
  0x0192, 0x0195, 0x0198, 0x019b, 0x019e, 0x01a1, 0x01a4, 0x01a8,
  0x01ab, 0x01ae, 0x01b1, 0x01b4, 0x01b7, 0x01ba, 0x01be, 0x01c1,
  0x01c4, 0x01c7, 0x01ca, 0x01cd, 0x01d0, 0x01d4, 0x01d7, 0x01da,
  0x01dd, 0x01e0, 0x01e3, 0x01e6, 0x01ea, 0x01ed, 0x01f0, 0x01f3,
  0x01f6, 0x01f9, 0x01fc, 0x0200, 0x0203, 0x0206, 0x0209, 0x020c,
  0x020f, 0x0212, 0x0216, 0x0219, 0x021c, 0x021f, 0x0222, 0x0225,
  0x0228, 0x022c, 0x022f, 0x0232, 0x0235, 0x0238, 0x023b, 0x023e,
  0x0242, 0x0245, 0x0248, 0x024b, 0x024e, 0x0251, 0x0254, 0x0258,
  0x025b, 0x025e, 0x0261, 0x0264, 0x0267, 0x026a, 0x026e, 0x0271,
  0x0274, 0x0277, 0x027a, 0x027d, 0x0280, 0x0284, 0x0287, 0x028a,
  0x028d, 0x0290, 0x0293, 0x0296, 0x029a, 0x029d, 0x02a0, 0x02a3,
  0x02a6, 0x02a9, 0x02ac, 0x02b0, 0x02b3, 0x02b6, 0x02b9, 0x02bc,
  0x02bf, 0x02c2, 0x02c6, 0x02c9, 0x02cc, 0x02cf, 0x02d2, 0x02d5,
  0x02d8, 0x02db, 0x02df, 0x02e2, 0x02e5, 0x02e8, 0x02eb, 0x02ee,
  0x02f1, 0x02f5, 0x02f8, 0x02fb, 0x02fe, 0x0301, 0x0304, 0x0307,
  0x030b, 0x030e, 0x0311, 0x0314, 0x0317, 0x031a, 0x031d, 0x0321
]);

const SIN_TABLE = new Int16Array([
  0x0000, 0x0324, 0x0647, 0x096a, 0x0c8b, 0x0fab, 0x12c8, 0x15e2,
  0x18f8, 0x1c0b, 0x1f19, 0x2223, 0x2528, 0x2826, 0x2b1f, 0x2e11,
  0x30fb, 0x33de, 0x36ba, 0x398c, 0x3c56, 0x3f17, 0x41ce, 0x447a,
  0x471c, 0x49b4, 0x4c3f, 0x4ebf, 0x5133, 0x539b, 0x55f5, 0x5842,
  0x5a82, 0x5cb4, 0x5ed7, 0x60ec, 0x62f2, 0x64e8, 0x66cf, 0x68a6,
  0x6a6d, 0x6c24, 0x6dca, 0x6f5f, 0x70e2, 0x7255, 0x73b5, 0x7504,
  0x7641, 0x776c, 0x7884, 0x798a, 0x7a7d, 0x7b5d, 0x7c29, 0x7ce3,
  0x7d8a, 0x7e1d, 0x7e9d, 0x7f09, 0x7f62, 0x7fa7, 0x7fd8, 0x7ff6,
  0x7fff, 0x7ff6, 0x7fd8, 0x7fa7, 0x7f62, 0x7f09, 0x7e9d, 0x7e1d,
  0x7d8a, 0x7ce3, 0x7c29, 0x7b5d, 0x7a7d, 0x798a, 0x7884, 0x776c,
  0x7641, 0x7504, 0x73b5, 0x7255, 0x70e2, 0x6f5f, 0x6dca, 0x6c24,
  0x6a6d, 0x68a6, 0x66cf, 0x64e8, 0x62f2, 0x60ec, 0x5ed7, 0x5cb4,
  0x5a82, 0x5842, 0x55f5, 0x539b, 0x5133, 0x4ebf, 0x4c3f, 0x49b4,
  0x471c, 0x447a, 0x41ce, 0x3f17, 0x3c56, 0x398c, 0x36ba, 0x33de,
  0x30fb, 0x2e11, 0x2b1f, 0x2826, 0x2528, 0x2223, 0x1f19, 0x1c0b,
  0x18f8, 0x15e2, 0x12c8, 0x0fab, 0x0c8b, 0x096a, 0x0647, 0x0324,
  -0x0000, -0x0324, -0x0647, -0x096a, -0x0c8b, -0x0fab, -0x12c8, -0x15e2,
  -0x18f8, -0x1c0b, -0x1f19, -0x2223, -0x2528, -0x2826, -0x2b1f, -0x2e11,
  -0x30fb, -0x33de, -0x36ba, -0x398c, -0x3c56, -0x3f17, -0x41ce, -0x447a,
  -0x471c, -0x49b4, -0x4c3f, -0x4ebf, -0x5133, -0x539b, -0x55f5, -0x5842,
  -0x5a82, -0x5cb4, -0x5ed7, -0x60ec, -0x62f2, -0x64e8, -0x66cf, -0x68a6,
  -0x6a6d, -0x6c24, -0x6dca, -0x6f5f, -0x70e2, -0x7255, -0x73b5, -0x7504,
  -0x7641, -0x776c, -0x7884, -0x798a, -0x7a7d, -0x7b5d, -0x7c29, -0x7ce3,
  -0x7d8a, -0x7e1d, -0x7e9d, -0x7f09, -0x7f62, -0x7fa7, -0x7fd8, -0x7ff6,
  -0x7fff, -0x7ff6, -0x7fd8, -0x7fa7, -0x7f62, -0x7f09, -0x7e9d, -0x7e1d,
  -0x7d8a, -0x7ce3, -0x7c29, -0x7b5d, -0x7a7d, -0x798a, -0x7884, -0x776c,
  -0x7641, -0x7504, -0x73b5, -0x7255, -0x70e2, -0x6f5f, -0x6dca, -0x6c24,
  -0x6a6d, -0x68a6, -0x66cf, -0x64e8, -0x62f2, -0x60ec, -0x5ed7, -0x5cb4,
  -0x5a82, -0x5842, -0x55f5, -0x539b, -0x5133, -0x4ebf, -0x4c3f, -0x49b4,
  -0x471c, -0x447a, -0x41ce, -0x3f17, -0x3c56, -0x398c, -0x36ba, -0x33de,
  -0x30fb, -0x2e11, -0x2b1f, -0x2826, -0x2528, -0x2223, -0x1f19, -0x1c0b,
  -0x18f8, -0x15e2, -0x12c8, -0x0fab, -0x0c8b, -0x096a, -0x0647, -0x0324
]);

function dspSin(angle) {
  angle = i16(angle);
  if (angle < 0) {
    if (angle === -32768) return 0;
    return i16(-dspSin(-angle));
  }
  let s = SIN_TABLE[angle >> 8] + ((MUL_TABLE[angle & 0xff] * SIN_TABLE[0x40 + (angle >> 8)]) >> 15);
  if (s > 32767) s = 32767;
  return i16(s);
}

function dspCos(angle) {
  angle = i16(angle);
  if (angle < 0) {
    if (angle === -32768) return -32768;
    angle = -angle;
  }
  let s = SIN_TABLE[0x40 + (angle >> 8)] - ((MUL_TABLE[angle & 0xff] * SIN_TABLE[angle >> 8]) >> 15);
  if (s < -32768) s = -32767;
  return i16(s);
}

// Returns [iCoefficient, iExponent]
function dspInverse(coefficient, exponent) {
  coefficient = i16(coefficient);
  exponent = i16(exponent);
  let iCoefficient, iExponent;

  if (coefficient === 0) {
    iCoefficient = 0x7fff;
    iExponent = 0x002f;
  } else {
    let sign = 1;

    if (coefficient < 0) {
      if (coefficient < -32767) coefficient = -32767;
      coefficient = -coefficient;
      sign = -1;
    }

    while (coefficient < 0x4000) {
      coefficient = i16(coefficient << 1);
      exponent = i16(exponent - 1);
    }

    if (coefficient === 0x4000) {
      if (sign === 1) {
        iCoefficient = 0x7fff;
      } else {
        iCoefficient = -0x4000;
        exponent = i16(exponent - 1);
      }
    } else {
      let idx = (((coefficient - 0x4000) >> 7) + 0x0065) & 1023;
      let v = DSP1ROM[idx];

      let t1 = (coefficient * v) >> 15;
      let t2 = (-v * t1) >> 15;
      v = i16((v + t2) << 1);

      t1 = (coefficient * v) >> 15;
      t2 = (-v * t1) >> 15;
      v = i16((v + t2) << 1);

      iCoefficient = i16(v * sign);
    }

    iExponent = i16(1 - exponent);
  }

  return [iCoefficient, iExponent];
}

// Returns [coefficient, exponent] where exponent = exp - e
function dspNormalize(m, exp) {
  m = i16(m);
  let e = 0;
  let i = 0x4000;

  if (m < 0) {
    while ((m & i) && i) { i >>= 1; e++; }
  } else {
    while (!(m & i) && i) { i >>= 1; e++; }
  }

  let coefficient;
  if (e > 0) {
    coefficient = i16((m * DSP1ROM[0x21 + e]) << 1);
  } else {
    coefficient = m;
  }

  return [coefficient, i16(exp - e)];
}

// Returns [coefficient, exponent] where exponent = e (output only, not relative)
function dspNormalizeDouble(product) {
  product = i32(product);
  let n = i16(product & 0x7fff);
  let m = i16(product >> 15);
  let e = 0;
  let i = 0x4000;

  if (m < 0) {
    while ((m & i) && i) { i >>= 1; e++; }
  } else {
    while (!(m & i) && i) { i >>= 1; e++; }
  }

  let coefficient;
  if (e > 0) {
    coefficient = i16((m * DSP1ROM[0x0021 + e]) << 1);

    if (e < 15) {
      coefficient = i16(coefficient + ((n * DSP1ROM[0x0040 - e]) >> 15));
    } else {
      i = 0x4000;
      if (m < 0) {
        while ((n & i) && i) { i >>= 1; e++; }
      } else {
        while (!(n & i) && i) { i >>= 1; e++; }
      }

      if (e > 15) {
        coefficient = i16((n * DSP1ROM[0x0012 + e]) << 1);
      } else {
        coefficient = i16(coefficient + n);
      }
    }
  } else {
    coefficient = m;
  }

  return [coefficient, e];
}

function dspTruncate(c, e) {
  c = i16(c);
  e = i16(e);
  if (e > 0) {
    if (c > 0) return 32767;
    if (c < 0) return -32767;
    return c;
  } else if (e < 0) {
    return i16((c * DSP1ROM[0x0031 + e]) >> 15);
  }
  return c;
}

function dspShiftR(c, e) {
  return i16((c * DSP1ROM[0x0031 + e]) >> 15);
}

export class DSP1 {
  constructor() {
    this.reset();
  }

  reset() {
    this.waiting4command = true;
    this.firstParameter = true;
    this.command = 0;
    this.inCount = 0;
    this.inIndex = 0;
    this.outCount = 0;
    this.outIndex = 0;
    this.parameters = new Uint8Array(512);
    this.output = new Uint8Array(2048 + 16);

    // Projection state (set by Op02, consumed by Op0A/Op06/Op0E)
    this.CentreX = 0; this.CentreY = 0; this.VOffset = 0;
    this.VPlane_C = 0; this.VPlane_E = 0;
    this.SinAas = 0; this.CosAas = 0; this.SinAzs = 0; this.CosAzs = 0;
    this.SinAZS = 0; this.CosAZS = 0;
    this.SecAZS_C1 = 0; this.SecAZS_E1 = 0; this.SecAZS_C2 = 0; this.SecAZS_E2 = 0;
    this.Nx = 0; this.Ny = 0; this.Nz = 0;
    this.Gx = 0; this.Gy = 0; this.Gz = 0;
    this.C_Les = 0; this.E_Les = 0; this.G_Les = 0;

    // Attitude matrices (Op01/11/21), 3x3 each
    this.matrixA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    this.matrixB = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    this.matrixC = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

    // Raster iteration counter (Op0A)
    this.Op0AVS = 0;
    this.Op0AA = 0; this.Op0AB = 0; this.Op0AC = 0; this.Op0AD = 0;

    // Op1C rotation persistent state
    this.Op1CXBR = 0; this.Op1CYBR = 0; this.Op1CZBR = 0;
  }

  // ---- DSP1SetByte/DSP1GetByte protocol (ported from snes9x dsp1.cpp) ----

  setByte(byte) {
    byte &= 0xFF;

    if ((this.command === 0x0a || this.command === 0x1a) && this.outCount !== 0) {
      this.outCount--;
      this.outIndex++;
      return;
    }

    if (this.waiting4command) {
      this.command = byte;
      this.inIndex = 0;
      this.waiting4command = false;
      this.firstParameter = true;

      switch (byte) {
        case 0x00: this.inCount = 2; break;
        case 0x30:
        case 0x10: this.inCount = 2; break;
        case 0x20: this.inCount = 2; break;
        case 0x24:
        case 0x04: this.inCount = 2; break;
        case 0x08: this.inCount = 3; break;
        case 0x18: this.inCount = 4; break;
        case 0x28: this.inCount = 3; break;
        case 0x38: this.inCount = 4; break;
        case 0x2c:
        case 0x0c: this.inCount = 3; break;
        case 0x3c:
        case 0x1c: this.inCount = 6; break;
        case 0x32:
        case 0x22:
        case 0x12:
        case 0x02: this.inCount = 7; break;
        case 0x0a: this.inCount = 1; break;
        case 0x3a:
        case 0x2a:
        case 0x1a:
          this.command = 0x1a;
          this.inCount = 1;
          break;
        case 0x16:
        case 0x26:
        case 0x36:
        case 0x06: this.inCount = 3; break;
        case 0x1e:
        case 0x2e:
        case 0x3e:
        case 0x0e: this.inCount = 2; break;
        case 0x05:
        case 0x35:
        case 0x31:
        case 0x01: this.inCount = 4; break;
        case 0x15:
        case 0x11: this.inCount = 4; break;
        case 0x25:
        case 0x21: this.inCount = 4; break;
        case 0x09:
        case 0x39:
        case 0x3d:
        case 0x0d: this.inCount = 3; break;
        case 0x19:
        case 0x1d: this.inCount = 3; break;
        case 0x29:
        case 0x2d: this.inCount = 3; break;
        case 0x33:
        case 0x03: this.inCount = 3; break;
        case 0x13: this.inCount = 3; break;
        case 0x23: this.inCount = 3; break;
        case 0x3b:
        case 0x0b: this.inCount = 3; break;
        case 0x1b: this.inCount = 3; break;
        case 0x2b: this.inCount = 3; break;
        case 0x34:
        case 0x14: this.inCount = 6; break;
        case 0x07:
        case 0x0f: this.inCount = 1; break;
        case 0x27:
        case 0x2f: this.inCount = 1; break;
        case 0x17:
        case 0x37:
        case 0x3f:
          this.command = 0x1f;
        // fall through
        case 0x1f: this.inCount = 1; break;
        default:
        case 0x80:
          this.inCount = 0;
          this.waiting4command = true;
          this.firstParameter = true;
          break;
      }

      this.inCount <<= 1;
    } else {
      this.parameters[this.inIndex] = byte;
      this.firstParameter = false;
      this.inIndex++;
    }

    if (this.waiting4command || (this.firstParameter && byte === 0x80)) {
      this.waiting4command = true;
      this.firstParameter = false;
    } else if (this.firstParameter && (this.inCount !== 0 || (this.inCount === 0 && this.inIndex === 0))) {
      // Waiting for more parameter bytes before the command can run.
    } else if (this.inCount) {
      if (--this.inCount === 0) {
        this.waiting4command = true;
        this.outIndex = 0;
        this._execute();
      }
    }
  }

  getByte() {
    let t;

    if (this.outCount) {
      t = this.output[this.outIndex];
      this.outIndex++;

      if (--this.outCount === 0) {
        if (this.command === 0x0a || this.command === 0x1a) {
          this._rasterStep();
          this.outCount = 8;
          this.outIndex = 0;
          writeWord(this.output, 0, this.Op0AA);
          writeWord(this.output, 2, this.Op0AB);
          writeWord(this.output, 4, this.Op0AC);
          writeWord(this.output, 6, this.Op0AD);
        }

        if (this.command === 0x1f) {
          if ((this.outIndex % 2) !== 0) {
            t = DSP1ROM[this.outIndex >> 1] & 0xFF;
          } else {
            t = (DSP1ROM[this.outIndex >> 1] >> 8) & 0xFF;
          }
        }
      }

      this.waiting4command = true;
    } else {
      t = 0x80;
    }

    return t & 0xFF;
  }

  // ---- Command dispatch ----

  _execute() {
    const P = this.parameters;
    const rs = (off) => i16(readWord(P, off));
    const ru = (off) => readWord(P, off);

    switch (this.command) {
      case 0x1f: // Firmware ROM dump
        this.outCount = 2048;
        break;

      case 0x00: { // Multiply
        const result = i16((rs(0) * rs(2)) >> 15);
        this.outCount = 2;
        writeWord(this.output, 0, result);
        break;
      }

      case 0x20: { // Multiply, +1
        const result = i16(i16((rs(0) * rs(2)) >> 15) + 1);
        this.outCount = 2;
        writeWord(this.output, 0, result);
        break;
      }

      case 0x30:
      case 0x10: { // Inverse
        const [c, e] = dspInverse(rs(0), rs(2));
        this.outCount = 4;
        writeWord(this.output, 0, c);
        writeWord(this.output, 2, e);
        break;
      }

      case 0x24:
      case 0x04: { // Sin/Cos * radius
        const angle = rs(0);
        const radius = ru(2);
        this.outCount = 4;
        writeWord(this.output, 0, i16((dspSin(angle) * radius) >> 15));
        writeWord(this.output, 2, i16((dspCos(angle) * radius) >> 15));
        break;
      }

      case 0x08: { // Squared length (32-bit)
        const x = rs(0), y = rs(2), z = rs(4);
        const size = (x * x + y * y + z * z) << 1;
        this.outCount = 4;
        writeWord(this.output, 0, size & 0xffff);
        writeWord(this.output, 2, (size >>> 16) & 0xffff);
        break;
      }

      case 0x18: { // Range check
        const x = rs(0), y = rs(2), z = rs(4), r = rs(6);
        const d = i16((x * x + y * y + z * z - r * r) >> 15);
        this.outCount = 2;
        writeWord(this.output, 0, d);
        break;
      }

      case 0x38: { // Range check, +1
        const x = rs(0), y = rs(2), z = rs(4), r = rs(6);
        const d = i16(((x * x + y * y + z * z - r * r) >> 15) + 1);
        this.outCount = 2;
        writeWord(this.output, 0, d);
        break;
      }

      case 0x28: { // Distance (vector length)
        const x = rs(0), y = rs(2), z = rs(4);
        const radius = x * x + y * y + z * z;
        let result = 0;
        if (radius !== 0) {
          let [c, e] = dspNormalizeDouble(radius);
          if (e & 1) c = i16((c * 0x4000) >> 15);
          const pos = i16((c * 0x0040) >> 15);
          const node1 = DSP1ROM[0x00d5 + pos];
          const node2 = DSP1ROM[0x00d6 + pos];
          result = i16((((node2 - node1) * (c & 0x1ff)) >> 9) + node1);
          result = i16(result >> (e >> 1));
        }
        this.outCount = 2;
        writeWord(this.output, 0, result);
        break;
      }

      case 0x2c:
      case 0x0c: { // 2D rotate
        const a = rs(0), x1 = rs(2), y1 = rs(4);
        const sinA = dspSin(a), cosA = dspCos(a);
        const x2 = i16(((y1 * sinA) >> 15) + ((x1 * cosA) >> 15));
        const y2 = i16(((y1 * cosA) >> 15) - ((x1 * sinA) >> 15));
        this.outCount = 4;
        writeWord(this.output, 0, x2);
        writeWord(this.output, 2, y2);
        break;
      }

      case 0x3c:
      case 0x1c: { // 3D polar rotate
        const [xar, yar, zar] = this._polarRotate(rs(0), rs(2), rs(4), rs(6), rs(8), rs(10));
        this.outCount = 6;
        writeWord(this.output, 0, xar);
        writeWord(this.output, 2, yar);
        writeWord(this.output, 4, zar);
        break;
      }

      case 0x32:
      case 0x22:
      case 0x12:
      case 0x02: { // Parameter (Mode7 projection setup)
        const [vof, vva, cx, cy] = this._parameter(rs(0), rs(2), rs(4), rs(6), rs(8), rs(10), rs(12));
        this.outCount = 8;
        writeWord(this.output, 0, vof);
        writeWord(this.output, 2, vva);
        writeWord(this.output, 4, cx);
        writeWord(this.output, 6, cy);
        break;
      }

      case 0x1a: // 0x3a/0x2a aliased to 0x1a in setByte()
      case 0x0a: { // Raster (Mode7 per-scanline coefficients)
        this.Op0AVS = rs(0);
        this._rasterStep();
        this.outCount = 8;
        writeWord(this.output, 0, this.Op0AA);
        writeWord(this.output, 2, this.Op0AB);
        writeWord(this.output, 4, this.Op0AC);
        writeWord(this.output, 6, this.Op0AD);
        this.inIndex = 0;
        break;
      }

      case 0x16:
      case 0x26:
      case 0x36:
      case 0x06: { // Project object onto screen
        const [h, v, m] = this._project(rs(0), rs(2), rs(4));
        this.outCount = 6;
        writeWord(this.output, 0, h);
        writeWord(this.output, 2, v);
        writeWord(this.output, 4, m);
        break;
      }

      case 0x1e:
      case 0x2e:
      case 0x3e:
      case 0x0e: { // Target (screen -> world)
        const [x, y] = this._target(rs(0), rs(2));
        this.outCount = 4;
        writeWord(this.output, 0, x);
        writeWord(this.output, 2, y);
        break;
      }

      case 0x05:
      case 0x35:
      case 0x31:
      case 0x01: // Set attitude matrix A
        this.matrixA = this._attitudeMatrix(rs(0), rs(2), rs(4), rs(6));
        break;

      case 0x15:
      case 0x11: // Set attitude matrix B
        this.matrixB = this._attitudeMatrix(rs(0), rs(2), rs(4), rs(6));
        break;

      case 0x25:
      case 0x21: // Set attitude matrix C
        this.matrixC = this._attitudeMatrix(rs(0), rs(2), rs(4), rs(6));
        break;

      case 0x09:
      case 0x39:
      case 0x3d:
      case 0x0d: { // Objective matrix A (world -> local)
        const [f, l, u] = this._objective(this.matrixA, rs(0), rs(2), rs(4));
        this.outCount = 6;
        writeWord(this.output, 0, f);
        writeWord(this.output, 2, l);
        writeWord(this.output, 4, u);
        break;
      }

      case 0x19:
      case 0x1d: { // Objective matrix B
        const [f, l, u] = this._objective(this.matrixB, rs(0), rs(2), rs(4));
        this.outCount = 6;
        writeWord(this.output, 0, f);
        writeWord(this.output, 2, l);
        writeWord(this.output, 4, u);
        break;
      }

      case 0x29:
      case 0x2d: { // Objective matrix C
        const [f, l, u] = this._objective(this.matrixC, rs(0), rs(2), rs(4));
        this.outCount = 6;
        writeWord(this.output, 0, f);
        writeWord(this.output, 2, l);
        writeWord(this.output, 4, u);
        break;
      }

      case 0x33:
      case 0x03: { // Subjective matrix A (local -> world)
        const [x, y, z] = this._subjective(this.matrixA, rs(0), rs(2), rs(4));
        this.outCount = 6;
        writeWord(this.output, 0, x);
        writeWord(this.output, 2, y);
        writeWord(this.output, 4, z);
        break;
      }

      case 0x13: { // Subjective matrix B
        const [x, y, z] = this._subjective(this.matrixB, rs(0), rs(2), rs(4));
        this.outCount = 6;
        writeWord(this.output, 0, x);
        writeWord(this.output, 2, y);
        writeWord(this.output, 4, z);
        break;
      }

      case 0x23: { // Subjective matrix C
        const [x, y, z] = this._subjective(this.matrixC, rs(0), rs(2), rs(4));
        this.outCount = 6;
        writeWord(this.output, 0, x);
        writeWord(this.output, 2, y);
        writeWord(this.output, 4, z);
        break;
      }

      case 0x3b:
      case 0x0b: { // Scalar projection onto matrix A row 0
        const s = this._scalarProject(this.matrixA, rs(0), rs(2), rs(4));
        this.outCount = 2;
        writeWord(this.output, 0, s);
        break;
      }

      case 0x1b: { // Scalar projection onto matrix B row 0
        const s = this._scalarProject(this.matrixB, rs(0), rs(2), rs(4));
        this.outCount = 2;
        writeWord(this.output, 0, s);
        break;
      }

      case 0x2b: { // Scalar projection onto matrix C row 0
        const s = this._scalarProject(this.matrixC, rs(0), rs(2), rs(4));
        this.outCount = 2;
        writeWord(this.output, 0, s);
        break;
      }

      case 0x34:
      case 0x14: { // Rotation angle correction
        const [zrr, xrr, yrr] = this._rotationCorrection(rs(0), rs(2), rs(4), rs(6), rs(8), rs(10));
        this.outCount = 6;
        writeWord(this.output, 0, zrr);
        writeWord(this.output, 2, xrr);
        writeWord(this.output, 4, yrr);
        break;
      }

      case 0x27:
      case 0x2f: // Unknown / firmware size
        this.outCount = 2;
        writeWord(this.output, 0, 0x100);
        break;

      case 0x07:
      case 0x0f: // RAM test
        this.outCount = 2;
        writeWord(this.output, 0, 0x0000);
        break;

      default:
        break;
    }
  }

  // ---- Op helpers (ported from snes9x DSP1_OpXX) ----

  _rasterStep() {
    const [a, b, c, d] = this._raster(this.Op0AVS);
    this.Op0AA = a;
    this.Op0AB = b;
    this.Op0AC = c;
    this.Op0AD = d;
    this.Op0AVS = i16(this.Op0AVS + 1);
  }

  _raster(Vs) {
    const arg = i16(((Vs * this.SinAzs) >> 15) + this.VOffset);
    let [C, E] = dspInverse(arg, 7);
    E = i16(E + this.VPlane_E);

    const C1 = i16((C * this.VPlane_C) >> 15);
    let E1 = i16(E + this.SecAZS_E2);

    [C, E] = dspNormalize(C1, E);
    C = dspTruncate(C, E);

    const An = i16((C * this.CosAas) >> 15);
    const Cn = i16((C * this.SinAas) >> 15);

    [C, E1] = dspNormalize(i16((C1 * this.SecAZS_C2) >> 15), E1);
    C = dspTruncate(C, E1);

    const Bn = i16((C * -this.SinAas) >> 15);
    const Dn = i16((C * this.CosAas) >> 15);

    return [An, Bn, Cn, Dn];
  }

  _parameter(Fx, Fy, Fz, Lfe, Les, Aas, Azs) {
    const MaxAZS_Exp = [
      0x38b4, 0x38b7, 0x38ba, 0x38be, 0x38c0, 0x38c4, 0x38c7, 0x38ca,
      0x38ce, 0x38d0, 0x38d4, 0x38d7, 0x38da, 0x38dd, 0x38e0, 0x38e4,
    ];

    let AZS = Azs;

    this.SinAas = dspSin(Aas);
    this.CosAas = dspCos(Aas);
    this.SinAzs = dspSin(Azs);
    this.CosAzs = dspCos(Azs);

    this.Nx = i16((this.SinAzs * -this.SinAas) >> 15);
    this.Ny = i16((this.SinAzs * this.CosAas) >> 15);
    this.Nz = i16((this.CosAzs * 0x7fff) >> 15);

    const LfeNx = i16((Lfe * this.Nx) >> 15);
    const LfeNy = i16((Lfe * this.Ny) >> 15);
    const LfeNz = i16((Lfe * this.Nz) >> 15);

    this.CentreX = i16(Fx + LfeNx);
    this.CentreY = i16(Fy + LfeNy);
    const CentreZ = i16(Fz + LfeNz);

    const LesNx = i16((Les * this.Nx) >> 15);
    const LesNy = i16((Les * this.Ny) >> 15);
    const LesNz = i16((Les * this.Nz) >> 15);

    this.Gx = i16(this.CentreX - LesNx);
    this.Gy = i16(this.CentreY - LesNy);
    this.Gz = i16(CentreZ - LesNz);

    this.E_Les = 0;
    [this.C_Les, this.E_Les] = dspNormalize(Les, this.E_Les);
    this.G_Les = Les;

    let [C, E] = dspNormalize(CentreZ, 0);
    this.VPlane_C = C;
    this.VPlane_E = E;

    let MaxAZS = MaxAZS_Exp[-E];

    if (AZS < 0) {
      MaxAZS = -MaxAZS;
      if (AZS < MaxAZS + 1) AZS = MaxAZS + 1;
    } else {
      if (AZS > MaxAZS) AZS = MaxAZS;
    }

    this.SinAZS = dspSin(AZS);
    this.CosAZS = dspCos(AZS);

    [this.SecAZS_C1, this.SecAZS_E1] = dspInverse(this.CosAZS, 0);
    [C, E] = dspNormalize(i16((C * this.SecAZS_C1) >> 15), E);
    E = i16(E + this.SecAZS_E1);

    C = i16((dspTruncate(C, E) * this.SinAZS) >> 15);

    this.CentreX = i16(this.CentreX + ((C * this.SinAas) >> 15));
    this.CentreY = i16(this.CentreY - ((C * this.CosAas) >> 15));

    const Cx = this.CentreX;
    const Cy = this.CentreY;

    let Vof = 0;

    if (Azs !== AZS || Azs === MaxAZS) {
      if (Azs === -32768) Azs = -32767;

      C = i16(Azs - MaxAZS);
      if (C >= 0) C = i16(C - 1);
      let Aux = i16(~(C << 2));

      C = i16((Aux * DSP1ROM[0x0328]) >> 15);
      C = i16(((C * Aux) >> 15) + DSP1ROM[0x0327]);
      Vof = i16(Vof - (((C * Aux) >> 15) * Les >> 15));

      C = i16((Aux * Aux) >> 15);
      Aux = i16(((C * DSP1ROM[0x0324]) >> 15) + DSP1ROM[0x0325]);
      this.CosAZS = i16(this.CosAZS + (((C * Aux) >> 15) * this.CosAZS >> 15));
    }

    this.VOffset = i16((Les * this.CosAZS) >> 15);

    let CSec;
    [CSec, E] = dspInverse(this.SinAZS, 0);
    [C, E] = dspNormalize(this.VOffset, E);
    [C, E] = dspNormalize(i16((C * CSec) >> 15), E);

    if (C === -32768) {
      C = i16(C >> 1);
      E = i16(E + 1);
    }

    const Vva = dspTruncate(-C, E);

    [this.SecAZS_C2, this.SecAZS_E2] = dspInverse(this.CosAZS, 0);

    return [Vof, Vva, Cx, Cy];
  }

  _project(X, Y, Z) {
    let [Px, E4] = dspNormalizeDouble(X - this.Gx);
    let [Py, E] = dspNormalizeDouble(Y - this.Gy);
    let [Pz, E3] = dspNormalizeDouble(Z - this.Gz);

    Px = i16(Px >> 1); E4 = i16(E4 - 1);
    Py = i16(Py >> 1); E = i16(E - 1);
    Pz = i16(Pz >> 1); E3 = i16(E3 - 1);

    let refE = Math.min(E, E3, E4);

    Px = dspShiftR(Px, i16(E4 - refE));
    Py = dspShiftR(Py, i16(E - refE));
    Pz = dspShiftR(Pz, i16(E3 - refE));

    const C11 = i16(-((Px * this.Nx) >> 15));
    const C8 = i16(-((Py * this.Ny) >> 15));
    const C9 = i16(-((Pz * this.Nz) >> 15));
    const C12 = i16(C11 + C8 + C9);

    let aux4 = C12;
    refE = i16(16 - refE);
    if (refE >= 0) {
      aux4 = aux4 << refE;
    } else {
      aux4 = aux4 >> -refE;
    }
    if (aux4 === -1) aux4 = 0;
    aux4 = aux4 >> 1;

    const aux = (this.G_Les & 0xffff) + aux4;
    let [C10, E2] = dspNormalizeDouble(aux);
    E2 = i16(15 - E2);

    let [C4, E4b] = dspInverse(C10, 0);
    const C2 = i16((C4 * this.C_Les) >> 15);

    // H
    const t1 = (this.CosAas * 0x7fff) >> 15;
    const C16 = i16((Px * t1) >> 15);
    const t2 = (this.SinAas * 0x7fff) >> 15;
    const C20 = i16((Py * t2) >> 15);
    const C17 = i16(C16 + C20);

    const C18 = i16((C17 * C2) >> 15);
    const [C19, E7] = dspNormalize(C18, 0);
    const H = dspTruncate(C19, this.E_Les - E2 + refE + E7);

    // V
    const t3 = (this.CosAzs * -this.SinAas) >> 15;
    const C21 = i16((Px * t3) >> 15);
    const t4 = (this.CosAzs * this.CosAas) >> 15;
    const C22 = i16((Py * t4) >> 15);
    const t5 = (-this.SinAzs * 0x7fff) >> 15;
    const C23 = i16((Pz * t5) >> 15);
    const C24 = i16(C21 + C22 + C23);

    const C26 = i16((C24 * C2) >> 15);
    const [C25, E6] = dspNormalize(C26, 0);
    const V = dspTruncate(C25, this.E_Les - E2 + refE + E6);

    // M
    const [C6, E4c] = dspNormalize(C2, E4b);
    const M = dspTruncate(C6, E4c + this.E_Les - E2 - 7);

    return [H, V, M];
  }

  _target(H, V) {
    let arg = i16(((V * this.SinAzs) >> 15) + this.VOffset);
    let [C, E] = dspInverse(arg, 8);
    E = i16(E + this.VPlane_E);

    const C1 = i16((C * this.VPlane_C) >> 15);
    let E1 = i16(E + this.SecAZS_E1);

    H = i16(H << 8);

    [C, E] = dspNormalize(C1, E);
    C = i16((dspTruncate(C, E) * H) >> 15);

    let X = i16(this.CentreX + ((C * this.CosAas) >> 15));
    let Y = i16(this.CentreY - ((C * this.SinAas) >> 15));

    V = i16(V << 8);

    [C, E1] = dspNormalize(i16((C1 * this.SecAZS_C1) >> 15), E1);
    C = i16((dspTruncate(C, E1) * V) >> 15);

    X = i16(X + ((C * -this.SinAas) >> 15));
    Y = i16(Y + ((C * this.CosAas) >> 15));

    return [X, Y];
  }

  _attitudeMatrix(m, Zr, Yr, Xr) {
    const SinAz = dspSin(Zr), CosAz = dspCos(Zr);
    const SinAy = dspSin(Yr), CosAy = dspCos(Yr);
    const SinAx = dspSin(Xr), CosAx = dspCos(Xr);

    m = i16(m >> 1);

    const mCosAz = (m * CosAz) >> 15;
    const mSinAz = (m * SinAz) >> 15;
    const mCosAx = (m * CosAx) >> 15;
    const mSinAx = (m * SinAx) >> 15;
    const mSinAy = (m * SinAy) >> 15;

    const m00 = i16((mCosAz * CosAy) >> 15);
    const m01 = i16(-((mSinAz * CosAy) >> 15));
    const m02 = i16(mSinAy);

    const m10 = i16(((mSinAz * CosAx) >> 15) + (((mCosAz * SinAx) >> 15) * SinAy >> 15));
    const m11 = i16(((mCosAz * CosAx) >> 15) - (((mSinAz * SinAx) >> 15) * SinAy >> 15));
    const m12 = i16(-((mSinAx * CosAy) >> 15));

    const m20 = i16(((mSinAz * SinAx) >> 15) - (((mCosAz * CosAx) >> 15) * SinAy >> 15));
    const m21 = i16(((mCosAz * SinAx) >> 15) + (((mSinAz * CosAx) >> 15) * SinAy >> 15));
    const m22 = i16((mCosAx * CosAy) >> 15);

    return [[m00, m01, m02], [m10, m11, m12], [m20, m21, m22]];
  }

  _objective(matrix, X, Y, Z) {
    const F = i16(((X * matrix[0][0]) >> 15) + ((Y * matrix[0][1]) >> 15) + ((Z * matrix[0][2]) >> 15));
    const L = i16(((X * matrix[1][0]) >> 15) + ((Y * matrix[1][1]) >> 15) + ((Z * matrix[1][2]) >> 15));
    const U = i16(((X * matrix[2][0]) >> 15) + ((Y * matrix[2][1]) >> 15) + ((Z * matrix[2][2]) >> 15));
    return [F, L, U];
  }

  _subjective(matrix, F, L, U) {
    const X = i16(((F * matrix[0][0]) >> 15) + ((L * matrix[1][0]) >> 15) + ((U * matrix[2][0]) >> 15));
    const Y = i16(((F * matrix[0][1]) >> 15) + ((L * matrix[1][1]) >> 15) + ((U * matrix[2][1]) >> 15));
    const Z = i16(((F * matrix[0][2]) >> 15) + ((L * matrix[1][2]) >> 15) + ((U * matrix[2][2]) >> 15));
    return [X, Y, Z];
  }

  _scalarProject(matrix, X, Y, Z) {
    return i16((X * matrix[0][0] + Y * matrix[0][1] + Z * matrix[0][2]) >> 15);
  }

  _polarRotate(angZ, angY, angX, xbr0, ybr0, zbr0) {
    const sinZ = dspSin(angZ), cosZ = dspCos(angZ);
    const sinY = dspSin(angY), cosY = dspCos(angY);
    const sinX = dspSin(angX), cosX = dspCos(angX);

    // Rotate around Z
    let x1 = i16(((ybr0 * sinZ) >> 15) + ((xbr0 * cosZ) >> 15));
    let y1 = i16(((ybr0 * cosZ) >> 15) - ((xbr0 * sinZ) >> 15));
    let xbr = x1, ybr = y1, zbr = zbr0;

    // Rotate around Y
    let z1 = i16(((xbr * sinY) >> 15) + ((zbr * cosY) >> 15));
    x1 = i16(((xbr * cosY) >> 15) - ((zbr * sinY) >> 15));
    const xar = x1;
    zbr = z1;

    // Rotate around X
    y1 = i16(((zbr * sinX) >> 15) + ((ybr * cosX) >> 15));
    z1 = i16(((zbr * cosX) >> 15) - ((ybr * sinX) >> 15));
    const yar = y1;
    const zar = z1;

    this.Op1CXBR = xbr;
    this.Op1CYBR = ybr;
    this.Op1CZBR = zbr;

    return [xar, yar, zar];
  }

  _rotationCorrection(Zr, Xr, Yr, U, F, L) {
    const cosXr = dspCos(Xr);
    const sinXr = dspSin(Xr);
    const cosYr = dspCos(Yr);
    const sinYr = dspSin(Yr);

    let [CSec, ESec] = dspInverse(cosXr, 0);

    // Rotation around Z
    let [C, E] = dspNormalizeDouble(U * cosYr - F * sinYr);
    E = i16(ESec - E);
    [C, E] = dspNormalize(i16((C * CSec) >> 15), E);
    const Zrr = i16(Zr + dspTruncate(C, E));

    // Rotation around X
    const Xrr = i16(Xr + ((U * sinYr) >> 15) + ((F * cosYr) >> 15));

    // Rotation around Y
    [C, E] = dspNormalizeDouble(U * cosYr + F * sinYr);
    E = i16(ESec - E);
    let CSin;
    [CSin, E] = dspNormalize(sinXr, E);
    const CTan = i16((CSec * CSin) >> 15);
    [C, E] = dspNormalize(i16(-((C * CTan) >> 15)), E);
    const Yrr = i16(Yr + dspTruncate(C, E) + L);

    return [Zrr, Xrr, Yrr];
  }
}
