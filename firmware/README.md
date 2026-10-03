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

Flashing is out of band: J-Link / J-Flash at `0x10001000`.
