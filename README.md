# TSDZ8 stock parameter patcher

Browser tool and notes from a Ghidra pass over Tongsheng TSDZ8 stock motor firmware (Infineon XMC1xxx). It patches documented immediates (speed ceiling, PAS percents, walk target, FOC/stall/protect constants) and writes a checksum-correct Intel HEX.

It does **not** include vendor firmware or a Ghidra project. Flashing is the host CLI ([`tools/jlink_flasher/`](tools/jlink_flasher/)). Experimental Chrome WebUSB is off unless the patcher is opened with `?webusb=1`.

**Off-road / private property only.** Raising the motor speed or current cap can make the bike illegal on public roads. That is your responsibility.

## What is here

| Path | Contents |
|---|---|
| [`webapp/`](webapp/) | Vite + TypeScript patcher. Load a HEX, edit rider/advanced fields, download a patched HEX. |
| [`webapp/src/parameter_map.json`](webapp/src/parameter_map.json) | Addresses, encodings, original bytes, fingerprints. |
| [`start-webapp.bat`](start-webapp.bat) / [`start-webapp.ps1`](start-webapp.ps1) | Double-click Windows launchers (`npm install` + Vite on http://localhost:5173). |
| [`jlink-flash.bat`](jlink-flash.bat) / [`jlink-flash.ps1`](jlink-flash.ps1) / [`jlink-flash.sh`](jlink-flash.sh) | Local-venv launchers for the J-Link CLI (menu if no args; otherwise pass-through). |
| [`docker-compose.yml`](docker-compose.yml) | Homelab / Dockhand stack; builds [`webapp/Dockerfile`](webapp/Dockerfile) and serves on port 8080. |
| [`firmware/`](firmware/) | How to supply your own stock dump (SHA-256, filename). |
| [`tools/jlink_flasher/`](tools/jlink_flasher/) | pylink CLI: dump / flash / verify at `0x10001000`. |

Not committed: `original firmware thonghsheng.hex`, `tsdz8_motor.gpr` / `.rep` (local Ghidra DB), `analysis/` (coverage notes).

## Use

**Windows:** install [Node.js LTS](https://nodejs.org), then double-click [`start-webapp.bat`](start-webapp.bat) (or run [`start-webapp.ps1`](start-webapp.ps1)). It installs dependencies and opens http://localhost:5173.

For J-Link dump/flash/verify (the default flasher), install [Python 3](https://www.python.org) and [SEGGER J-Link Software](https://www.segger.com/downloads/jlink/), then double-click [`jlink-flash.bat`](jlink-flash.bat) (menu) or `jlink-flash.bat flash your-patched.hex`. PowerShell: [`jlink-flash.ps1`](jlink-flash.ps1).

**macOS / Linux:**

```bash
cd webapp
npm install
npm test
npm run dev
```

Drop your stock HEX onto the page. Download is refused if known stock bytes do not match. Flash with the CLI:

```bash
./jlink-flash.sh flash your-patched.hex
```

Experimental in-browser WebUSB (desktop Chrome/Edge) is off unless you open the patcher with `?webusb=1`. Close J-Flash / JLinkExe first. VTref is sense-only unless you opt into probe power — do not power from the battery and the J-Link at the same time. See [`tools/jlink_flasher/README.md`](tools/jlink_flasher/README.md).

Tests that need the real dump are skipped when the HEX is absent. With the file at the repo root they run against the mapped fingerprints.

## Self-host (Docker / Dockhand)

The patcher is a static site. Clone this private repo on the homelab (SSH deploy key or GitHub PAT) and build locally — nothing is published to a registry.

```bash
docker compose up -d --build
```

The UI is on port **8080**. In Dockhand, add a stack from this GitHub repo, compose file `docker-compose.yml`, and credentials that can clone the private repo. Rebuild when you pull.

HEX edit and download work over plain HTTP. The default flasher is the Python CLI (no HTTPS). Experimental WebUSB (`?webusb=1`) needs a secure context (HTTPS or `localhost`).

## License

This repository's source and notes are MIT (see [`LICENSE`](LICENSE)). Tongsheng firmware remains their copyright; do not add HEX/BIN dumps or Ghidra databases to the tree.
