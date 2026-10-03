# TSDZ8 stock parameter patcher

Browser tool and notes from a Ghidra pass over Tongsheng TSDZ8 stock motor firmware (Infineon XMC1xxx). It patches documented immediates (speed ceiling, PAS percents, walk target, FOC/stall/protect constants) and writes a checksum-correct Intel HEX.

It does **not** include vendor firmware or a Ghidra project. Flashing is a host CLI ([`tools/jlink_flasher/`](tools/jlink_flasher/)) and a Chrome WebUSB client in the patcher.

**Off-road / private property only.** Raising the motor speed or current cap can make the bike illegal on public roads. That is your responsibility.

## What is here

| Path | Contents |
|---|---|
| [`webapp/`](webapp/) | Vite + TypeScript patcher. Load a HEX, edit rider/advanced fields, download or flash a patched HEX. |
| [`webapp/src/parameter_map.json`](webapp/src/parameter_map.json) | Addresses, encodings, original bytes, fingerprints. |
| [`start-webapp.bat`](start-webapp.bat) / [`start-webapp.ps1`](start-webapp.ps1) | Double-click Windows launchers (`npm install` + Vite on http://localhost:5173). |
| [`docker-compose.yml`](docker-compose.yml) | Homelab / Dockhand stack; builds [`webapp/Dockerfile`](webapp/Dockerfile) and serves on port 8080. |
| [`analysis/coverage/`](analysis/coverage/) | Function-coverage notes from the reverse-engineering pass. |
| [`firmware/`](firmware/) | How to supply your own stock dump (SHA-256, filename). |
| [`tools/jlink_flasher/`](tools/jlink_flasher/) | pylink CLI: dump / flash / verify at `0x10001000`. |

Not committed: `original firmware thonghsheng.hex`, `tsdz8_motor.gpr` / `.rep` (local Ghidra DB).

## Use

**Windows:** install [Node.js LTS](https://nodejs.org), then double-click [`start-webapp.bat`](start-webapp.bat) (or run [`start-webapp.ps1`](start-webapp.ps1)). It installs dependencies and opens http://localhost:5173. Use Chrome or Edge for WebUSB.

**macOS / Linux:**

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

## Self-host (Docker / Dockhand)

The patcher is a static site. Clone this private repo on the homelab (SSH deploy key or GitHub PAT) and build locally — nothing is published to a registry.

```bash
docker compose up -d --build
```

The UI is on port **8080**. In Dockhand, add a stack from this GitHub repo, compose file `docker-compose.yml`, and credentials that can clone the private repo. Rebuild when you pull.

HEX edit and download work over plain HTTP. **WebUSB flash needs a secure context** (HTTPS or `localhost`). Put the stack behind your reverse proxy TLS (Caddy / Traefik / Dockhand) if you want Connect/Flash from another machine. The Python J-Link CLI does not need HTTPS.

## License

This repository's source and notes are MIT (see [`LICENSE`](LICENSE)). Tongsheng firmware remains their copyright; do not add HEX/BIN dumps or Ghidra databases to the tree.
