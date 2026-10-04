import { t } from "./i18n.js";

export class HexError extends Error {
  constructor(message) {
    super(message);
    this.name = "HexError";
  }
}

export function checksum(bytes) {
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  return (~sum + 1) & 0xff;
}

export function parseHexLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith(":")) {
    throw new HexError(t("hex.noColon", { preview: trimmed.slice(0, 20) }));
  }
  const hex = trimmed.slice(1);
  if (hex.length < 10 || hex.length % 2 !== 0) {
    throw new HexError(t("hex.badLength", { line: trimmed }));
  }
  const rawBytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < rawBytes.length; i++) {
    rawBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const length = rawBytes[0];
  const address = (rawBytes[1] << 8) | rawBytes[2];
  const type = rawBytes[3];
  if (rawBytes.length !== length + 5) {
    throw new HexError(t("hex.countMismatch", { addr: address.toString(16) }));
  }
  const data = rawBytes.slice(4, 4 + length);
  const recorded = rawBytes[4 + length];
  const expected = checksum(rawBytes.slice(0, 4 + length));
  if (recorded !== expected) {
    throw new HexError(
      t("hex.checksum", {
        recorded: recorded.toString(16),
        expected: expected.toString(16),
        addr: address.toString(16),
      }),
    );
  }
  return { raw: trimmed, length, address, type, data, checksum: recorded };
}

export const FLASH_BASE = 0x10001000;
export const IMAGE_SIZE = 65536;
export const RECORD_DATA_LEN = 32;

export function formatRecord(record) {
  const payload = new Uint8Array(4 + record.data.length);
  payload[0] = record.data.length;
  payload[1] = (record.address >> 8) & 0xff;
  payload[2] = record.address & 0xff;
  payload[3] = record.type;
  payload.set(record.data, 4);
  const sum = checksum(payload);
  const hex = [...payload, sum].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join("");
  return {
    raw: `:${hex}`,
    length: record.data.length,
    address: record.address,
    type: record.type,
    data: record.data,
    checksum: sum,
  };
}

export class IntelHex {
  constructor(records, newline = "\n") {
    this.records = records;
    this.newline = newline;
  }

  static parse(text) {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const records = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      records.push(parseHexLine(line));
    }
    if (records.length === 0) {
      throw new HexError(t("hex.empty"));
    }
    if (records[records.length - 1].type !== 1) {
      throw new HexError(t("hex.noEof"));
    }
    return new IntelHex(records, newline);
  }

  serialize() {
    return this.records.map((r) => r.raw).join(this.newline) + this.newline;
  }

  locate(absAddr) {
    let ela = 0;
    for (let i = 0; i < this.records.length; i++) {
      const rec = this.records[i];
      if (rec.type === 4 && rec.data.length === 2) {
        ela = ((rec.data[0] << 8) | rec.data[1]) << 16;
        continue;
      }
      if (rec.type !== 0) continue;
      const start = ela + rec.address;
      const end = start + rec.data.length;
      if (absAddr >= start && absAddr < end) {
        return { index: i, offset: absAddr - start };
      }
    }
    return null;
  }

  getByte(absAddr) {
    const hit = this.locate(absAddr);
    if (!hit) return undefined;
    return this.records[hit.index].data[hit.offset];
  }

  setByte(absAddr, value) {
    const hit = this.locate(absAddr);
    if (!hit) {
      throw new HexError(t("hex.notInImage", { addr: absAddr.toString(16) }));
    }
    const rec = this.records[hit.index];
    if (rec.data[hit.offset] === value) return;
    const data = new Uint8Array(rec.data);
    data[hit.offset] = value & 0xff;
    this.records[hit.index] = formatRecord({
      length: data.length,
      address: rec.address,
      type: rec.type,
      data,
    });
  }

  readBytes(absAddr, size) {
    const out = [];
    for (let i = 0; i < size; i++) {
      const b = this.getByte(absAddr + i);
      if (b === undefined) {
        throw new HexError(t("hex.missingAddr", { addr: (absAddr + i).toString(16) }));
      }
      out.push(b);
    }
    return out;
  }

  toFlatImage(base = FLASH_BASE, size = IMAGE_SIZE) {
    const image = new Uint8Array(size);
    const seen = new Uint8Array(size);
    let ela = 0;
    for (const rec of this.records) {
      if (rec.type === 4 && rec.data.length === 2) {
        ela = ((rec.data[0] << 8) | rec.data[1]) << 16;
        continue;
      }
      if (rec.type === 2 && rec.data.length === 2) {
        ela = ((rec.data[0] << 8) | rec.data[1]) << 4;
        continue;
      }
      if (rec.type !== 0) continue;
      const start = ela + rec.address;
      for (let i = 0; i < rec.data.length; i++) {
        const absAddr = start + i;
        if (absAddr < base || absAddr >= base + size) {
          throw new HexError(
            t("hex.outside", {
              addr: absAddr.toString(16),
              base: base.toString(16),
              size: String(size),
            }),
          );
        }
        const off = absAddr - base;
        image[off] = rec.data[i];
        seen[off] = 1;
      }
    }
    for (let i = 0; i < size; i++) {
      if (seen[i] === 0) {
        throw new HexError(t("hex.holes", { addr: (base + i).toString(16) }));
      }
    }
    return image;
  }

  static fromFlatImage(image, base = FLASH_BASE, recLen = RECORD_DATA_LEN) {
    const records = [];
    let currentEla = -1;
    let offset = 0;
    while (offset < image.length) {
      const absAddr = base + offset;
      const ela = (absAddr >>> 16) & 0xffff;
      const recAddr = absAddr & 0xffff;
      if (ela !== currentEla) {
        records.push(
          formatRecord({
            length: 2,
            address: 0,
            type: 4,
            data: Uint8Array.from([(ela >> 8) & 0xff, ela & 0xff]),
          }),
        );
        currentEla = ela;
      }
      const take = Math.min(recLen, image.length - offset, 0x10000 - recAddr);
      records.push(
        formatRecord({
          length: take,
          address: recAddr,
          type: 0,
          data: image.subarray(offset, offset + take),
        }),
      );
      offset += take;
    }
    records.push(formatRecord({ length: 0, address: 0, type: 1, data: new Uint8Array() }));
    return new IntelHex(records);
  }
}
