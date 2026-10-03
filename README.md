# TSDZ8 stock parameter patcher

Browser tool and notes from a Ghidra pass over Tongsheng TSDZ8 stock motor firmware (Infineon XMC1xxx). It patches documented immediates (speed ceiling, PAS percents, walk target, FOC/stall/protect constants) and writes a checksum-correct Intel HEX.

It does **not** include vendor firmware, a Ghidra project, or a flasher.

**Off-road / private property only.** Raising the motor speed or current cap can make the bike illegal on public roads. That is your responsibility.

## What is here

| Path | Contents |
|---|---|
| [`webapp/`](webapp/) | Vite + TypeScript patcher. Load a HEX, edit rider/advanced fields, download a patched HEX. |
| [`webapp/src/parameter_map.json`](webapp/src/parameter_map.json) | Addresses, encodings, original bytes, fingerprints. |
| [`analysis/coverage/`](analysis/coverage/) | Function-coverage notes from the reverse-engineering pass. |
| [`firmware/`](firmware/) | How to supply your own stock dump (SHA-256, filename). |

Not committed: `original firmware thonghsheng.hex`, `tsdz8_motor.gpr` / `.rep` (local Ghidra DB).

## Use

```bash
cd webapp
npm install
npm test
npm run dev
```

Drop your stock HEX onto the page. Download is refused if known stock bytes do not match. Flash the result yourself with J-Link / J-Flash at `0x10001000`.

Tests that need the real dump are skipped when the HEX is absent. With the file at the repo root they run against the mapped fingerprints.

## License

This repository's source and notes are MIT (see [`LICENSE`](LICENSE)). Tongsheng firmware remains their copyright; do not add HEX/BIN dumps or Ghidra databases to the tree.
