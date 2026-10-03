import { describe, expect, it } from "vitest";
import { FLASH_BASE, IMAGE_SIZE } from "./constants";
import { CortexM, MEMAP_TAR, MEMAP_TAR_WRAP, type DumpProgressFn } from "./cortexM";
import type { SwdHost } from "./swd";

class RecAp {
  tars: number[] = [];
  async writeDp(): Promise<void> {}
  async writeAp(addr: number, value: number): Promise<void> {
    if (addr === MEMAP_TAR) this.tars.push(value >>> 0);
  }
  async readAp(): Promise<number> {
    return 0x03020100;
  }
  async readDp(): Promise<number> {
    return 0;
  }
}

function memOf(ap: RecAp): CortexM {
  return new CortexM(ap as unknown as SwdHost);
}

describe("CortexM.readMem TAR wrap", () => {
  it("rewrites TAR at every 1 KB boundary", async () => {
    const ap = new RecAp();
    await memOf(ap).readMem(FLASH_BASE, 0x800);
    expect(ap.tars).toEqual([FLASH_BASE, FLASH_BASE + MEMAP_TAR_WRAP]);
  });

  it("rewrites TAR 64 times for a 64 KB dump", async () => {
    const ap = new RecAp();
    const progress: number[] = [];
    const onProgress: DumpProgressFn = (done) => progress.push(done);
    await memOf(ap).readMem(FLASH_BASE, IMAGE_SIZE, onProgress);
    expect(ap.tars).toHaveLength(IMAGE_SIZE / MEMAP_TAR_WRAP);
    expect(ap.tars[0]).toBe(FLASH_BASE);
    expect(ap.tars[63]).toBe(FLASH_BASE + 63 * MEMAP_TAR_WRAP);
  });

  it("rewrites TAR when a window starts unaligned then crosses 1 KB", async () => {
    const ap = new RecAp();
    const start = FLASH_BASE + 4;
    await memOf(ap).readMem(start, MEMAP_TAR_WRAP);
    expect(ap.tars[0]).toBe(start);
    expect(ap.tars).toContain(FLASH_BASE + MEMAP_TAR_WRAP);
  });
});
