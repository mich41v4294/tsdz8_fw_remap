# TSDZ8 stock parameter patcher

Browser tool and notes from a Ghidra pass over Tongsheng TSDZ8 stock motor firmware (Infineon XMC1xxx). It patches documented immediates (speed ceiling, PAS percents, walk target, FOC/stall/protect constants) and writes a checksum-correct Intel HEX.

It does **not** include vendor firmware or a Ghidra project. Flashing is a host CLI ([`tools/jlink_flasher/`](tools/jlink_flasher/)) and a Chrome WebUSB client in the patcher.

**Off-road / private property only.** Raising the motor speed or current cap can make the bike illegal on public roads. That is your responsibility.

## What is here

| Path | Contents |
|---|---|
| [`webapp/`](webapp/) | Vite + TypeScript patcher. Load a HEX, edit rider/advanced fields, download or flash a patched HEX. |
| [`webapp/src/parameter_map.json`](webapp/src/parameter_map.json) | Addresses, encodings, original bytes, fingerprints. |
| [`analysis/coverage/`](analysis/coverage/) | Function-coverage notes from the reverse-engineering pass. |
| [`firmware/`](firmware/) | How to supply your own stock dump (SHA-256, filename). |
| [`tools/jlink_flasher/`](tools/jlink_flasher/) | pylink CLI: dump / flash / verify at `0x10001000`. |

Not committed: `original firmware thonghsheng.hex`, `tsdz8_motor.gpr` / `.rep` (local Ghidra DB).

## Use

```bash
cd webapp
npm install
npm test
npm run dev
```

Drop your stock HEX onto the page. Download is refused if known stock bytes do not match. Flash from Chrome/Edge over WebUSB (J-Link stock firmware, no probe reflash) or:

```bash
python3 -m pip install -r tools/jlink_flasher/requirements.txt
python3 -m tools.jlink_flasher flash your-patched.hex
```

Close J-Flash / JLinkExe before WebUSB. On Windows the SEGGER driver often keeps the interface; use the CLI then. VTref is sense-only unless you opt into probe power — do not power from the battery and the J-Link at the same time. See [`tools/jlink_flasher/README.md`](tools/jlink_flasher/README.md).

Tests that need the real dump are skipped when the HEX is absent. With the file at the repo root they run against the mapped fingerprints.

## License

This repository's source and notes are MIT (see [`LICENSE`](LICENSE)). Tongsheng firmware remains their copyright; do not add HEX/BIN dumps or Ghidra databases to the tree.
