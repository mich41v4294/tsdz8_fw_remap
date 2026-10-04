export function packBits(bits) {
  const out = new Uint8Array(Math.ceil(bits.length / 8) || 1);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}

export function unpackBits(bytes, count) {
  const bits = [];
  for (let i = 0; i < count; i++) {
    bits.push(((bytes[i >> 3] >> (i & 7)) & 1) === 1);
  }
  return bits;
}

export function bitsToInt(bits) {
  let v = 0;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) v |= 1 << i;
  }
  return v >>> 0;
}

export function intToBits(value, width) {
  const bits = [];
  for (let i = 0; i < width; i++) bits.push(((value >>> i) & 1) === 1);
  return bits;
}

export function u32and(value, mask) {
  return (value & mask) >>> 0;
}

export function parity32(value) {
  let p = 0;
  let v = value >>> 0;
  while (v) {
    p ^= v & 1;
    v >>>= 1;
  }
  return p === 1;
}
