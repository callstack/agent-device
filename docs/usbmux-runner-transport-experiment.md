# #1403 experiment: usbmux as the primary physical-iOS runner transport

Live results from 2026-07-30, thymikee-iphone (iPhone 17 Pro, iOS 26.5.2, UDID
00008150-001849640CF8401C), macOS host with Xcode 26.2. Method: forced-route
env override `AGENT_DEVICE_IOS_RUNNER_ROUTE=usbmux` in `runner-command-route.ts`
(committed with this doc), isolated `--state-dir` daemons per leg, timings
from per-request `--debug` ndjson plus wall-clock. The override is
**daemon-scoped**: the daemon captures its environment at launch, so setting
the variable on a later CLI invocation against a running daemon silently
keeps the previous route — every route leg needs a fresh isolated
state-dir/daemon launched with the desired value. Every timing sample was
validated against real command output after an early instrument artifact (see
Pitfalls).

## Numbers (same build, same cable state, verified output)

| Scenario | network (tunnel-IP) route | usbmux route |
|---|---|---|
| Steady-state snapshot, cable in | 350–450 ms | 440 ms |
| Snapshot after 40 s idle | **4.5–4.6 s** (tunnel re-probe + session re-establish) | **440 ms** (unchanged) |
| Runner killed, next snapshot | ~4.0 s self-heal | 4.7 s self-heal |
| Steady-state snapshot, Wi-Fi only (no cable) | 425–495 ms | fails (see below) |
| Full lifecycle open/snapshot/tap/screenshot/close | works | works |

Older-build measurements (first pass) agreed in shape: first open pays one-time
xctestrun prep (~13 s cold) and runner startup; fresh device resolution costs
~6.7 s of devicectl listing either way.

## Findings

1. **The idle tax is the payoff, and it is bigger than expected.** Past the
   30 s tunnel-IP cache TTL, the network route re-probes the tunnel and
   re-establishes runner readiness: ~4.5 s per idle gap, every time. Over
   usbmux the session stays hot indefinitely (40 s gaps measured at steady
   440 ms). Agent workflows are exactly the idle-gappy workload that hits this
   tax on almost every step.
2. **Steady state is a wash.** The per-command usbmuxd handshake (fresh unix
   socket, ListDevices, Connect) roughly cancels the network route's pooled-
   connection advantage; ~±90 ms either way.
3. **Wi-Fi deletion is off the table.** A CoreDevice-paired, Wi-Fi-reachable
   iPhone (devicectl `available (paired)`, live tunnel) does NOT appear in
   usbmuxd at all — modern CoreDevice Wi-Fi runs over `remoted`, invisible to
   usbmuxd. usbmuxd listed the device only while cabled, `ConnectionType: USB`
   only, and the entry disappears on unplug. The CoreDevice network route must
   stay as the Wi-Fi fallback → this is a "usbmux-primary + network-fallback"
   reshuffle, not a full tunnel-code deletion.
4. **Failure semantics gap (also affects today's xctest backend).** With the
   cable out, forced-usbmux commands hang for 2×45 s of retries and surface a
   generic "Runner did not accept connection" — the usbmux client's precise
   `DEVICE_NOT_FOUND` ("Connect the device by cable, trust this Mac…") is
   swallowed by `shouldRetryRunnerConnectError`. An implementation should make
   usbmux DEVICE_NOT_FOUND non-retryable (or fall back to the network route
   immediately) and preserve the hint.
5. **Lock behavior is transport-independent.** A locked phone wedges AX
   capture/runner relaunch identically on both routes (SBMainWorkspace
   "Locked" denial; xcodebuild "Unlock thymikee-iphone to Continue").
6. **usbmux UDID matching is exact.** usbmuxd `SerialNumber` equals the
   dashed hardware UDID that `DeviceInfo.id` already uses for devicectl-listed
   devices; DeviceID (10) is the mux handle. Multi-device disambiguation is
   structural. (Multi-attached-device matrix not exercised: one device only.)

## Shipped design (matches the issue's desired outcome, minus full deletion)

Implemented on top of this evidence; the experiment's
`AGENT_DEVICE_IOS_RUNNER_ROUTE` override is gone because usbmux-first is now
the real behaviour rather than something to opt into.

- One private route resolver: physical devices resolve to usbmux first. When
  usbmuxd answers that the device is not attached, the resolver is marked for
  the rest of the request and re-resolves to the CoreDevice tunnel route.
  Callers never choose a transport; `waitForRunner` and `sendRunnerCommandOnce`
  both go through the same resolver.
- The tunnel lookup, its 30 s cache, and the cache invalidation now only run on
  the fallback path, so a cabled device never pays the probe/TTL tax that cost
  ~4.5 s per idle gap.
- Failure semantics: the usbmux "device not attached" verdict carries
  `usbmuxDeviceAttached: false`, and `isUsbmuxDeviceUnattachedError` is the only
  thing that triggers fallback. It is answered inside the same connect attempt
  rather than by burning a retry, so a Wi-Fi-only device is not slowed down.
- The xctest backend stays usbmux-only (it has no CoreDevice tunnel by
  definition), so its verdict is terminal and surfaces the cable/trust/unlock
  hint instead of being retried for the full budget.

## Pitfalls for whoever implements/re-measures

- `bin/agent-device.mjs` runs `dist/`, not `src/`. A stale dist silently ran
  the first "usbmux leg" on stock network code while the env override sat
  inert in the daemon (numbers looked plausible; only the cable-pull test
  exposed it). Rebuild and verify the daemon process (`ps eww <pid>`, dist
  mtime, and a behavioral probe) before trusting route attribution.
- `/usr/bin/time` on a failing command still prints a small `real` — a fast
  error latency is indistinguishable from a fast success unless output is
  asserted. Runner-lease contention ("already owned by another daemon")
  produced exactly this artifact.
- The route override is daemon-scoped (env captured at daemon launch). Never
  flip `AGENT_DEVICE_IOS_RUNNER_ROUTE` between commands against the same
  daemon and expect the route to change — start a fresh isolated
  state-dir/daemon per leg, then verify with `ps eww <daemon-pid>`.
- Sessions are cwd-scoped; run every command of a leg from the same cwd.
- Auto-Lock must be Never during measurement or the runner dies mid-series.
