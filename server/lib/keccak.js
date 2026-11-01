// Minimal Keccak-256 (Ethereum flavour, 0x01 padding) used to derive 4-byte function selectors.
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const M = (1n << 64n) - 1n;
const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M;

function f(s) {
  for (let r = 0; r < 24; r++) {
    const c = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[y + x] ^= d;
    }
    let t = s[1];
    for (let i = 0; i < 24; i++) { const j = PI[i]; const b = s[j]; s[j] = rotl(t, ROT[i]); t = b; }
    for (let y = 0; y < 25; y += 5) {
      const row = s.slice(y, y + 5);
      for (let x = 0; x < 5; x++) s[y + x] = row[x] ^ (~row[(x + 1) % 5] & M & row[(x + 2) % 5]);
    }
    s[0] ^= RC[r];
  }
}

export function keccak256(input) {
  const msg = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  const rate = 136;
  const padLen = rate - (msg.length % rate);
  const p = Buffer.concat([msg, Buffer.alloc(padLen)]);
  p[msg.length] ^= 0x01;
  p[p.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < p.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) s[i] ^= p.readBigUInt64LE(off + i * 8);
    f(s);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
  return out.toString('hex');
}
export const selector = (sig) => keccak256(sig).slice(0, 8);
