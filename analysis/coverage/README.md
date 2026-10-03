# Firmware analysis coverage partitions

Target: ≥80% of functions decompiled/renamed and ≥80% of locals/params inside those functions.

Baseline (2026-10-03): 200 listed functions, ~18 already named. 80% of 200 = 160 functions.

| Report | Exclusive addresses |
|---|---|
| `periph-low.json` | `0x10001034`–`0x1000151c` (20) |
| `periph-mid.json` | `0x10001558`–`0x10001eee` (9) |
| `init-adc.json` | unnamed `0x10001f50`–`0x100023f8` (12) |
| `motor-pwm.json` | unnamed `0x10002420`–`0x10002cca` (22) |
| `ride-systick.json` | unnamed ride/startup `0x10003020`–`0x100043c4` (13) |
| `math-a.json` | `0x10004502`–`0x100054c4` (20) |
| `math-b.json` | `0x1000553c`–`0x100058ea` (17) |
| `ram-runtime.json` | thunks + `0x100059f8`–`0x10006718` (31) |
| `uart-tasks.json` | `0x1000756c`–`0x1000815c` (14) |
| `sensors-protect.json` | leftover UART/protect/veneers (24) |
| `named-vars.json` | variables only in the 18 already-named functions |
| `gap-midflash.json` | orphaned code `0x100067D8`–`0x1000756B` (3476 B) |
| `reset-startup.json` | Reset @ `0x10003A84` + vector header |
| `const-tables.json` | flash data `0x10009810`–`0x10010FFF` |
| `sram-globals.json` | ride-state + RAM veneers (no function renames) |
| `gap-low.json` | new functions in low orphaned gaps |
| `gap-high.json` | new functions in high orphaned gaps |

Already-named functions (names locked; variable pass is a follow-up):
`DebounceDigitalInput`, `InitializePeripherals`, `ReadAdcChannelHigh`, `ReadAdcChannelLow`, `DisableMotorOutput`, `UpdateBatteryCurrentLimit`, `ApplyAssistLevelTargets`, `InitializeRideTimer`, `InitializeRideDefaults`, `RunRideControlLoop`, `ComputeMotorScaleTables`, `ComputeSysTickScale`, `UpdateTorqueSensorState`, `ParseDisplayUartFrame`, `UpdateSpeedSensorWatchdog`, `CompareWheelSpeedCeiling`, `UpdateWheelSpeedPeriod`, `ApplyWheelSpeedFade`.
