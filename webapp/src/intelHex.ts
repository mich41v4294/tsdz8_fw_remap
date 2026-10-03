export type HexRecordType = 0 | 1 | 2 | 3 | 4 | 5;

export interface HexRecord {
  raw: string;
  length: number;
  address: number;
  type: HexRecordType;
  data: Uint8Array;
  checksum: number;
}

export class HexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HexError";
  }
}

export function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  return (~sum + 1) & 0xff;
}

export function parseHexLine(line: string): HexRecord {
  const trimmed = line.trim();
  if (!trimmed.startsWith(":")) {
    throw new HexError(`Line does not start with ':': ${trimmed.slice(0, 20)}`);
  }
  const hex = trimmed.slice(1);
  if (hex.length < 10 || hex.length % 2 !== 0) {
    throw new HexError(`Invalid record length: ${trimmed}`);
  }
  const rawBytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < rawBytes.length; i++) {
    rawBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const length = rawBytes[0];
  const address = (rawBytes[1] << 8) | rawBytes[2];
  const type = rawBytes[3] as HexRecordType;
  if (rawBytes.length !== length + 5) {
    throw new HexError(`Count mismatch on record at ${address.toString(16)}`);
  }
  const data = rawBytes.slice(4, 4 + length);
  const recorded = rawBytes[4 + length];
  const expected = checksum(rawBytes.slice(0, 4 + length));
  if (recorded !== expected) {
    throw new HexError(
      `Checksum ${recorded.toString(16)} != ${expected.toString(16)} at ${address.toString(16)}`,
    );
  }
  return { raw: trimmed, length, address, type, data, checksum: recorded };
}

export function formatRecord(record: Omit<HexRecord, "raw" | "checksum">): HexRecord {
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
  readonly records: HexRecord[];
  readonly newline: "\n" | "\r\n";

  constructor(records: HexRecord[], newline: "\n" | "\r\n" = "\n") {
    this.records = records;
    this.newline = newline;
  }

  static parse(text: string): IntelHex {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const records: HexRecord[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      records.push(parseHexLine(line));
    }
    if (records.length === 0) {
      throw new HexError("Empty HEX file");
    }
    if (records[records.length - 1].type !== 1) {
      throw new HexError("HEX file does not end with an EOF record");
    }
    return new IntelHex(records, newline);
  }

  serialize(): string {
    return this.records.map((r) => r.raw).join(this.newline) + this.newline;
  }

  private locate(absAddr: number): { index: number; offset: number } | null {
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

  getByte(absAddr: number): number | undefined {
    const hit = this.locate(absAddr);
    if (!hit) return undefined;
    return this.records[hit.index].data[hit.offset];
  }

  setByte(absAddr: number, value: number): void {
    const hit = this.locate(absAddr);
    if (!hit) {
      throw new HexError(`Address 0x${absAddr.toString(16)} is not in this HEX image`);
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

  readBytes(absAddr: number, size: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < size; i++) {
      const b = this.getByte(absAddr + i);
      if (b === undefined) {
        throw new HexError(`Address 0x${(absAddr + i).toString(16)} is missing`);
      }
      out.push(b);
    }
    return out;
  }
}
