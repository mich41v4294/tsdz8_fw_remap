export const FLASH_BASE = 0x10001000;
export const IMAGE_SIZE = 65536;
export const IDCHIP_ADDR = 0x40010004;
export const IDCHIP_EXPECTED = 0xf1c0;

export const NVM_BASE = 0x40050000;
export const NVMSTATUS = NVM_BASE + 0x00;
export const NVMPROG = NVM_BASE + 0x04;
export const NVMSTATUS_BUSY = 1 << 0;
export const NVMPROG_IDLE = 0x00;
export const NVMPROG_WRITE = 0x51;
export const NVMPROG_PAGE_ERASE = 0x92;
export const NVM_BLOCK_SIZE = 16;
export const NVM_PAGE_SIZE = 256;

export const DHCSR = 0xe000edf0;
export const DHCSR_DBGKEY = 0xa05f0000;
export const DHCSR_C_DEBUGEN = 1;
export const DHCSR_C_HALT = 2;
export const DHCSR_S_HALT = 1 << 17;
export const DHCSR_S_REGRDY = 1 << 16;
export const DCRSR = 0xe000edf4;
export const DCRDR = 0xe000edf8;
export const AIRCR = 0xe000ed0c;
export const AIRCR_VECTKEY = 0x05fa0000;
export const AIRCR_SYSRESETREQ = 1 << 2;

export const SEGGER_VID = 0x1366;
export const DEFAULT_SWD_KHZ = 4000;

export function idchipField(word: number): number {
  return (word >>> 8) & 0xffff;
}
