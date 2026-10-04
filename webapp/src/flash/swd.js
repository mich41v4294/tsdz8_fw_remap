import { bitsToInt, intToBits, packBits, parity32, u32and, unpackBits } from "./bits.js";
import { JLinkError } from "./jlinkUsb.js";
import { t } from "../i18n.js";

const ACK_OK = 0b001;
const ACK_WAIT = 0b010;
const ACK_FAULT = 0b100;

const CTRLSTAT_CDBGPWRUPACK = 0x20000000;
const CTRLSTAT_CSYSPWRUPACK = 0x80000000;
const CTRLSTAT_POWERED = (CTRLSTAT_CDBGPWRUPACK | CTRLSTAT_CSYSPWRUPACK) >>> 0;

export class SwdError extends Error {
  constructor(message) {
    super(message);
    this.name = "SwdError";
  }
}

export function ctrlStatPowered(stat) {
  return u32and(stat, CTRLSTAT_POWERED) === CTRLSTAT_POWERED;
}

export function requestByte(ap, read, a23) {
  const a2 = (a23 >> 2) & 1;
  const a3 = (a23 >> 3) & 1;
  const apn = ap ? 1 : 0;
  const rnw = read ? 1 : 0;
  const parity = apn ^ rnw ^ a2 ^ a3;
  return 1 | (apn << 1) | (rnw << 2) | (a2 << 3) | (a3 << 4) | (parity << 5) | (1 << 7);
}

export class SwdHost {
  constructor(io) {
    this.io = io;
    this.clearingFault = false;
  }

  async transfer(dir, data) {
    const packedDir = packBits(dir);
    const packedData = packBits(data);
    const resp = await this.io.swdIo(packedDir, packedData, dir.length);
    return unpackBits(resp, dir.length);
  }

  async lineResetAndSwitch() {
    const ones = Array(56).fill(true);
    const zeros = Array(8).fill(false);
    const switchBits = intToBits(0xe79e, 16);
    const seq = [...ones, ...switchBits, ...ones, ...zeros];
    const dir = seq.map(() => true);
    await this.transfer(dir, seq);
  }

  async idle(n = 8) {
    const bits = Array(n).fill(false);
    await this.transfer(
      bits.map(() => true),
      bits,
    );
  }

  async rawTxn(ap, read, a23, wdata) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const req = intToBits(requestByte(ap, read, a23), 8);
      const dir = [];
      const out = [];
      const pushOut = (bits) => {
        for (const b of bits) {
          dir.push(true);
          out.push(b);
        }
      };
      const pushIn = (count) => {
        for (let i = 0; i < count; i++) {
          dir.push(false);
          out.push(false);
        }
      };
      pushOut(req);
      pushIn(1);
      pushIn(3);
      if (read) {
        pushIn(32);
        pushIn(1);
        pushIn(1);
      } else {
        pushIn(1);
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
      if (ack === ACK_FAULT) {
        if (!this.clearingFault) {
          this.clearingFault = true;
          try {
            await this.writeDp(0x00, 0x1e);
          } catch {
            /* still throw FAULT */
          } finally {
            this.clearingFault = false;
          }
        }
        throw new SwdError(t("swd.fault"));
      }
      if (ack !== ACK_OK) throw new SwdError(t("swd.ack", { ack: ack.toString(2) }));
      if (!read) {
        await this.idle();
        return 0;
      }
      const dataBits = captured.slice(ackStart + 3, ackStart + 3 + 32);
      const parBit = captured[ackStart + 3 + 32];
      const value = bitsToInt(dataBits);
      if (parity32(value) !== parBit) throw new SwdError(t("swd.parity"));
      await this.idle();
      return value;
    }
    throw new SwdError(t("swd.wait"));
  }

  async readDp(addr) {
    return this.rawTxn(false, true, addr);
  }

  async writeDp(addr, value) {
    await this.rawTxn(false, false, addr, value);
  }

  async readAp(addr) {
    await this.rawTxn(true, true, addr);
    return this.readDp(0x0c);
  }

  async writeAp(addr, value) {
    await this.rawTxn(true, false, addr, value);
  }

  async connectDebug() {
    await this.lineResetAndSwitch();
    const idcode = await this.readDp(0x00);
    if ((idcode & 0x0fff) === 0) {
      throw new SwdError(t("swd.badDpidr", { idcode: idcode.toString(16) }));
    }
    await this.writeDp(0x00, 0x1e);
    await this.writeDp(0x04, 0x50000000);
    for (let i = 0; i < 20; i++) {
      const stat = await this.readDp(0x04);
      if (ctrlStatPowered(stat)) return idcode;
    }
    throw new SwdError(t("swd.power"));
  }
}

export { JLinkError };
