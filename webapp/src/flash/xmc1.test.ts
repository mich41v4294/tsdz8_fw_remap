import { describe, expect, it } from "vitest";
import {
  FLASH_BASE,
  IMAGE_SIZE,
  NVM_PAGE_SIZE,
  NVMPROG,
  NVMPROG_IDLE,
  NVMPROG_PAGE_ERASE,
  NVMPROG_WRITE,
  NVMSTATUS,
  NVMSTATUS_VERR_MASK,
  SRAM_CODE,
} from "./constants";
import type { MemIf } from "./cortexM";
import { checkVerr, flashXmc1, nvmVerr, SRAM_ERASE_THUMB, SRAM_WRITE_THUMB, SRAM_WRITE_DONE_OFF, SRAM_WRITE_FAIL_OFF, SRAM_ERASE_DONE_OFF, SRAM_ERASE_FAIL_OFF, assertSramHalt } from "./xmc1";

class FakeNvm implements MemIf {
  flash = new Uint8Array(IMAGE_SIZE).fill(0xff);
  prog = 0;
  forceVerr = false;
  nvmstatusReads = 0;

  async read32(addr: number): Promise<number> {
    if (addr === NVMSTATUS) {
      this.nvmstatusReads += 1;
      if (this.forceVerr) return NVMSTATUS_VERR_MASK;
      return 0;
    }
    if (addr === NVMPROG) return this.prog;
    if (addr >= FLASH_BASE && addr < FLASH_BASE + IMAGE_SIZE) {
      const o = addr - FLASH_BASE;
      return (
        (this.flash[o]! |
          (this.flash[o + 1]! << 8) |
          (this.flash[o + 2]! << 16) |
          (this.flash[o + 3]! << 24)) >>>
        0
      );
    }
    return 0;
  }
  async write32(addr: number, value: number): Promise<void> {
    if (addr === NVMPROG) {
      this.prog = value & 0xff;
      return;
    }
    if (addr < FLASH_BASE || addr >= FLASH_BASE + IMAGE_SIZE) return;
    const o = addr - FLASH_BASE;
    if (this.prog === NVMPROG_PAGE_ERASE) {
      const page = Math.floor(o / NVM_PAGE_SIZE) * NVM_PAGE_SIZE;
      this.flash.fill(0xff, page, page + NVM_PAGE_SIZE);
      return;
    }
    if (this.prog === NVMPROG_WRITE) {
      this.flash[o] = value & 0xff;
      this.flash[o + 1] = (value >> 8) & 0xff;
      this.flash[o + 2] = (value >> 16) & 0xff;
      this.flash[o + 3] = (value >> 24) & 0xff;
    }
  }
  async read16(addr: number): Promise<number> {
    return (await this.read32(addr)) & 0xffff;
  }
  async write16(addr: number, value: number): Promise<void> {
    if (addr === NVMPROG) this.prog = value & 0xff;
  }
  async read8(): Promise<number> {
    return 0;
  }
  async write8(): Promise<void> {}
}

describe("XMC1 NVM programmer", () => {
  it("erases and programs a 64 KB image", async () => {
    const nvm = new FakeNvm();
    nvm.flash.fill(0x5a);
    const image = Uint8Array.from({ length: IMAGE_SIZE }, (_, i) => (i * 13) & 0xff);
    await flashXmc1(nvm, image);
    expect(nvm.prog).toBe(NVMPROG_IDLE);
    expect(nvm.flash).toEqual(image);
  });

  it("fails on VERR and leaves NVMPROG idle", async () => {
    const nvm = new FakeNvm();
    nvm.forceVerr = true;
    const image = new Uint8Array(IMAGE_SIZE);
    await expect(flashXmc1(nvm, image)).rejects.toThrow(/VERR/);
    expect(nvm.prog).toBe(NVMPROG_IDLE);
  });

  it("decodes VERR from NVMSTATUS[3:2]", () => {
    expect(nvmVerr(0)).toBe(0);
    expect(nvmVerr(0x4)).toBe(1);
    expect(nvmVerr(0xc)).toBe(3);
    expect(() => checkVerr(NVMSTATUS_VERR_MASK)).toThrow(/VERR=3/);
  });

  it("ships original Thumb helpers (not empty)", () => {
    expect(SRAM_WRITE_THUMB.length).toBeGreaterThan(8);
    expect(SRAM_ERASE_THUMB.length).toBeGreaterThan(8);
    expect(SRAM_WRITE_THUMB.at(-2)).toBe(0x01);
    expect(SRAM_WRITE_THUMB.at(-1)).toBe(0xbe);
    expect(SRAM_WRITE_FAIL_OFF).toBeGreaterThan(SRAM_WRITE_DONE_OFF + 4);
    expect(SRAM_ERASE_FAIL_OFF).toBeGreaterThan(SRAM_ERASE_DONE_OFF + 4);
  });

  it("treats success PC in the done window and fail PC / r0 as VERR", () => {
    assertSramHalt(
      { pc: SRAM_CODE + SRAM_WRITE_DONE_OFF + 2, r0: 0 },
      SRAM_WRITE_DONE_OFF,
      SRAM_WRITE_FAIL_OFF,
      "write",
    );
    expect(() =>
      assertSramHalt(
        { pc: SRAM_CODE + SRAM_WRITE_FAIL_OFF, r0: 0 },
        SRAM_WRITE_DONE_OFF,
        SRAM_WRITE_FAIL_OFF,
        "write",
      ),
    ).toThrow(/VERR/);
    expect(() =>
      assertSramHalt(
        { pc: SRAM_CODE + SRAM_WRITE_DONE_OFF, r0: 0xff },
        SRAM_WRITE_DONE_OFF,
        SRAM_WRITE_FAIL_OFF,
        "write",
      ),
    ).toThrow(/VERR/);
    expect(() =>
      assertSramHalt({ pc: SRAM_CODE + 8, r0: 1 }, SRAM_WRITE_DONE_OFF, SRAM_WRITE_FAIL_OFF, "write"),
    ).toThrow(/halted at PC/);
  });
});
