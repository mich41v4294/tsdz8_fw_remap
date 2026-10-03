import { bitsToInt, intToBits, packBits, parity32, unpackBits } from "./bits";
import { JLinkError } from "./jlinkUsb";

export interface SwdIo {
  swdIo(direction: Uint8Array, data: Uint8Array, bitCount: number): Promise<Uint8Array>;
}

const ACK_OK = 0b001;
const ACK_WAIT = 0b010;
const ACK_FAULT = 0b100;

export class SwdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwdError";
  }
}

function requestByte(ap: boolean, read: boolean, a23: number): number {
  const a2 = (a23 >> 2) & 1;
  const a3 = (a23 >> 3) & 1;
  const apn = ap ? 1 : 0;
  const rnw = read ? 1 : 0;
  const parity = apn ^ rnw ^ a2 ^ a3;
  return 1 | (apn << 1) | (rnw << 2) | (a2 << 3) | (a3 << 4) | (parity << 5) | (1 << 7);
}

export class SwdHost {
  constructor(private readonly io: SwdIo) {}

  private async transfer(dir: boolean[], data: boolean[]): Promise<boolean[]> {
    const packedDir = packBits(dir);
    const packedData = packBits(data);
    const resp = await this.io.swdIo(packedDir, packedData, dir.length);
    return unpackBits(resp, dir.length);
  }

  async lineResetAndSwitch(): Promise<void> {
    const ones = Array(56).fill(true) as boolean[];
    const zeros = Array(8).fill(false) as boolean[];
    const switchBits = intToBits(0xe79e, 16);
    const seq = [...ones, ...switchBits, ...ones, ...zeros];
    const dir = seq.map(() => true);
    await this.transfer(dir, seq);
  }

  async idle(n = 8): Promise<void> {
    const bits = Array(n).fill(false) as boolean[];
    await this.transfer(bits.map(() => true), bits);
  }

  private async rawTxn(ap: boolean, read: boolean, a23: number, wdata?: number): Promise<number> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const req = intToBits(requestByte(ap, read, a23), 8);
      const dir: boolean[] = [];
      const out: boolean[] = [];
      const pushOut = (bits: boolean[]) => {
        for (const b of bits) {
          dir.push(true);
          out.push(b);
        }
      };
      const pushIn = (count: number) => {
        for (let i = 0; i < count; i++) {
          dir.push(false);
          out.push(false);
        }
      };
      pushOut(req);
      pushIn(1); // turnaround
      pushIn(3); // ACK
      if (read) {
        pushIn(32);
        pushIn(1); // parity
        pushIn(1); // turnaround
      } else {
        pushIn(1); // turnaround after ACK
        const payload = wdata ?? 0;
        pushOut(intToBits(payload, 32));
        pushOut([parity32(payload)]);
      }
      const captured = await this.transfer(dir, out);
      const ackStart = 8 + 1;
      const ack = bitsToInt(captured.slice(ackStart, ackStart + 3));
      if (ack === ACK_WAIT) {
        await this.idle();
        continue;
      }
      if (ack === ACK_FAULT) throw new SwdError("SWD FAULT");
      if (ack !== ACK_OK) throw new SwdError(`SWD ACK 0b${ack.toString(2)}`);
      if (!read) {
        await this.idle();
        return 0;
      }
      const dataBits = captured.slice(ackStart + 3, ackStart + 3 + 32);
      const parBit = captured[ackStart + 3 + 32];
      const value = bitsToInt(dataBits);
      if (parity32(value) !== parBit) throw new SwdError("SWD parity");
      await this.idle();
      return value;
    }
    throw new SwdError("SWD WAIT timeout");
  }

  async readDp(addr: number): Promise<number> {
    return this.rawTxn(false, true, addr);
  }

  async writeDp(addr: number, value: number): Promise<void> {
    await this.rawTxn(false, false, addr, value);
  }

  async readAp(addr: number): Promise<number> {
    await this.rawTxn(true, true, addr);
    return this.readDp(0x0c); // RDBUFF
  }

  async writeAp(addr: number, value: number): Promise<void> {
    await this.rawTxn(true, false, addr, value);
  }

  async connectDebug(): Promise<number> {
    await this.lineResetAndSwitch();
    const idcode = await this.readDp(0x00);
    if ((idcode & 0x0fff) === 0) {
      throw new SwdError(`Bad DPIDR 0x${idcode.toString(16)}`);
    }
    await this.writeDp(0x00, 0x1e); // ABORT sticky flags
    await this.writeDp(0x04, 0x50000000); // CTRL/STAT CSYSPWRUPREQ | CDBGPWRUPREQ
    for (let i = 0; i < 20; i++) {
      const stat = await this.readDp(0x04);
      if ((stat & 0xa0000000) === 0xa0000000) return idcode;
    }
    throw new SwdError("Debug power-up failed");
  }
}

export { requestByte };
