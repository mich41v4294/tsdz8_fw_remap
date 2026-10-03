export function packBits(bits: boolean[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits.length / 8) || 1);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}

export function unpackBits(bytes: Uint8Array, count: number): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i < count; i++) {
    bits.push(((bytes[i >> 3] >> (i & 7)) & 1) === 1);
  }
  return bits;
}

export function bitsToInt(bits: boolean[]): number {
  let v = 0;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) v |= 1 << i;
  }
  return v >>> 0;
}

export function intToBits(value: number, width: number): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i < width; i++) bits.push(((value >> i) & 1) === 1);
  return bits;
}

export function parity32(value: number): boolean {
  let p = 0;
  let v = value >>> 0;
  while (v) {
    p ^= v & 1;
    v >>>= 1;
  }
  return p === 1;
}
