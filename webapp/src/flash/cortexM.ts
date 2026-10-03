import {
  AIRCR,
  AIRCR_SYSRESETREQ,
  AIRCR_VECTKEY,
  DCRDR,
  DCRSR,
  DHCSR,
  DHCSR_C_DEBUGEN,
  DHCSR_C_HALT,
  DHCSR_DBGKEY,
  DHCSR_S_HALT,
  DHCSR_S_REGRDY,
  SRAM_CODE,
} from "./constants";
import { SwdError, SwdHost } from "./swd";

const CSW = 0x00;
export const MEMAP_TAR = 0x04;
const TAR = MEMAP_TAR;
const DRW = 0x0c;
const SELECT = 0x08;

/** AHB-AP AddrInc wraps TAR[9:0]; rewrite TAR at this stride. */
export const MEMAP_TAR_WRAP = 0x400;

/** 32-bit, AddrInc single, DeviceEn, MasterType */
const CSW_32 = 0xa2000012;
const CSW_16 = 0xa2000011;
const CSW_8 = 0xa2000010;

const REG_PC = 15;
const REG_XPSR = 16;
const XPSR_THUMB = 0x01000000;

export interface MemIf {
  read32(addr: number): Promise<number>;
  write32(addr: number, value: number): Promise<void>;
  read16(addr: number): Promise<number>;
  write16(addr: number, value: number): Promise<void>;
  read8(addr: number): Promise<number>;
  write8(addr: number, value: number): Promise<void>;
}

export type DumpProgressFn = (done: number, total: number) => void;

export class CortexM implements MemIf {
  private select = 0xffffffff;
  private csw = 0xffffffff;

  constructor(private readonly swd: SwdHost) {}

  private async setSelect(apSel: number, bank: number): Promise<void> {
    const v = ((apSel & 0xff) << 24) | ((bank & 0xf) << 4);
    if (v === this.select) return;
    await this.swd.writeDp(SELECT, v);
    this.select = v;
  }

  private async setCsw(value: number): Promise<void> {
    await this.setSelect(0, 0);
    if (value === this.csw) return;
    await this.swd.writeAp(CSW, value);
    this.csw = value;
  }

  async read32(addr: number): Promise<number> {
    await this.setCsw(CSW_32);
    await this.swd.writeAp(TAR, addr >>> 0);
    return this.swd.readAp(DRW);
  }

  async write32(addr: number, value: number): Promise<void> {
    await this.setCsw(CSW_32);
    await this.swd.writeAp(TAR, addr >>> 0);
    await this.swd.writeAp(DRW, value >>> 0);
  }

  async read16(addr: number): Promise<number> {
    await this.setCsw(CSW_16);
    await this.swd.writeAp(TAR, addr >>> 0);
    return (await this.swd.readAp(DRW)) & 0xffff;
  }

  async write16(addr: number, value: number): Promise<void> {
    await this.setCsw(CSW_16);
    await this.swd.writeAp(TAR, addr >>> 0);
    await this.swd.writeAp(DRW, value & 0xffff);
  }

  async read8(addr: number): Promise<number> {
    await this.setCsw(CSW_8);
    await this.swd.writeAp(TAR, addr >>> 0);
    return (await this.swd.readAp(DRW)) & 0xff;
  }

  async write8(addr: number, value: number): Promise<void> {
    await this.setCsw(CSW_8);
    await this.swd.writeAp(TAR, addr >>> 0);
    await this.swd.writeAp(DRW, value & 0xff);
  }

  async halt(): Promise<void> {
    await this.write32(DHCSR, DHCSR_DBGKEY | DHCSR_C_DEBUGEN | DHCSR_C_HALT);
    for (let i = 0; i < 50; i++) {
      const s = await this.read32(DHCSR);
      if (s & DHCSR_S_HALT) return;
    }
    throw new SwdError("Core did not halt");
  }

  async go(): Promise<void> {
    await this.write32(DHCSR, DHCSR_DBGKEY | DHCSR_C_DEBUGEN);
  }

  async resetRun(): Promise<void> {
    await this.write32(AIRCR, AIRCR_VECTKEY | AIRCR_SYSRESETREQ);
    await this.write32(DHCSR, DHCSR_DBGKEY);
  }

  async writeReg(reg: number, value: number): Promise<void> {
    await this.write32(DCRDR, value >>> 0);
    await this.write32(DCRSR, (1 << 16) | (reg & 0x1f));
    for (let i = 0; i < 20; i++) {
      if ((await this.read32(DHCSR)) & DHCSR_S_REGRDY) return;
    }
    throw new SwdError("DCRSR write timeout");
  }

  async readReg(reg: number): Promise<number> {
    await this.write32(DCRSR, reg & 0x1f);
    for (let i = 0; i < 20; i++) {
      if ((await this.read32(DHCSR)) & DHCSR_S_REGRDY) {
        return this.read32(DCRDR);
      }
    }
    throw new SwdError("DCRSR read timeout");
  }

  async readMem(addr: number, length: number, onProgress?: DumpProgressFn): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let i = 0;
    const words = length & ~3;
    if (words >= 4) {
      await this.setCsw(CSW_32);
      let tarValid = false;
      while (i + 4 <= words) {
        const abs = (addr + i) >>> 0;
        if (!tarValid || (abs & (MEMAP_TAR_WRAP - 1)) === 0) {
          await this.swd.writeAp(TAR, abs);
          tarValid = true;
        }
        const w = await this.swd.readAp(DRW);
        out[i] = w & 0xff;
        out[i + 1] = (w >> 8) & 0xff;
        out[i + 2] = (w >> 16) & 0xff;
        out[i + 3] = (w >> 24) & 0xff;
        i += 4;
        if (onProgress && (i === words || (i & 0x3ff) === 0)) onProgress(i, length);
      }
    }
    while (i < length) {
      out[i] = await this.read8(addr + i);
      i++;
    }
    onProgress?.(length, length);
    return out;
  }

  async writeMem(addr: number, data: Uint8Array): Promise<void> {
    let i = 0;
    while (i + 4 <= data.length) {
      const w = data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24);
      await this.write32(addr + i, w >>> 0);
      i += 4;
    }
    while (i < data.length) {
      await this.write8(addr + i, data[i]!);
      i++;
    }
  }

  /**
   * Load Thumb at SRAM_CODE, set r0–r3 and PC, run until BKPT halt.
   */
  async runFromSram(
    code: Uint8Array,
    args: { r0: number; r1: number; r2: number; r3: number },
    timeoutMs = 4000,
  ): Promise<{ pc: number; r0: number }> {
    await this.halt();
    await this.writeMem(SRAM_CODE, code);
    await this.writeReg(0, args.r0 >>> 0);
    await this.writeReg(1, args.r1 >>> 0);
    await this.writeReg(2, args.r2 >>> 0);
    await this.writeReg(3, args.r3 >>> 0);
    await this.writeReg(REG_XPSR, XPSR_THUMB);
    await this.writeReg(14, (SRAM_CODE + code.length) | 1);
    await this.writeReg(REG_PC, SRAM_CODE | 1);
    await this.go();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await this.read32(DHCSR);
      if (s & DHCSR_S_HALT) {
        const pc = (await this.readReg(REG_PC)) & ~1;
        const r0 = await this.readReg(0);
        return { pc, r0 };
      }
    }
    throw new SwdError("SRAM helper did not halt (BKPT timeout)");
  }
}

export function isSramHost(mem: MemIf): mem is CortexM {
  return mem instanceof CortexM;
}
