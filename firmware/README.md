# Stock HEX (not in this repository)

Tongsheng's motor firmware is vendor copyright. Place your own dump at the repo root as:

```
original firmware thonghsheng.hex
```

That filename is kept so local tests and the patcher UI match an existing dump name. The manufacturer spelling is **Tongsheng**.

## Expected image

| Field | Value |
|---|---|
| MCU | Infineon XMC1xxx (Cortex-M0) |
| Flash load address | `0x10001000` |
| Image size | 65536 bytes |
| SHA-256 | `c47ae4b505782fa1e0ceb24be27cb605323584686282b47cdad14a03a8418a58` |

Verify:

```bash
shasum -a 256 "original firmware thonghsheng.hex"
```

The patcher also refuses to write if mapped stock bytes (UART `0x59`, 25 km/h ceiling, PAS percents, …) do not match. A matching hash without those bytes is still the wrong build.

## Flash

64 KB at `0x10001000`. Do not reflash the J-Link.

```bash
./jlink-flash.sh flash path/to-patched.hex
```

Windows: double-click [`../jlink-flash.bat`](../jlink-flash.bat) (menu) or `jlink-flash.bat flash path\to-patched.hex`. PowerShell: [`../jlink-flash.ps1`](../jlink-flash.ps1).

Experimental WebUSB in the patcher is off unless you open it with `?webusb=1`. Details in [`../tools/jlink_flasher/README.md`](../tools/jlink_flasher/README.md).
