# Manual Device Verification

Read this for Apple runner changes or manual `agent-device` runs on simulators, emulators, or
physical devices. Live verification steps apply when exercising a device-facing path.

## Build freshness

- After changing runtime code reached through `bin/agent-device.mjs` or the daemon: `pnpm build`,
  then `pnpm clean:daemon` — the daemon does not self-reload.
- Before any Android verification from source: `pnpm build`, `pnpm build:android`, `pnpm clean:daemon`.
  `build:android` refreshes and verifies both bundled Android helper artifacts for the current
  package version.
- Graceful `shutdown` hands off an active healthy runner that already answered a command, on the
  simulator and physical iOS lanes alike; a new daemon may adopt the old binary. A runner retained
  idle after `close` is stopped before the daemon exits. After
  Swift runner changes, run `pnpm build:xcuitest` before verification. Use the session cleanup
  procedure below if ownership is stuck. The physical handoff's device steps are
  `docs/evidence/ios-physical-runner-handoff-2026-09-19.md`; nothing in it is proven until someone
  with a cabled device checks a box.

## Prove the path under test was actually active

- Android: capture `snapshot -i --json` and require `androidSnapshot.backend` to be `android-helper`
  with `helperVersion` equal to `package.json`'s version. A stock UIAutomator fallback is not valid
  verification unless the fallback itself is the behavior under test.
- For repo-owned `Agent Device Tester` work, `examples/test-app/README.md` is the source of truth for
  simulator, physical-device, Metro/dev-client, and app-surface steps. An already-installed
  `com.callstack.agentdevicelab` is not sufficient — the README's Metro/dev-build and `snapshot -i`
  checks must prove the expected app surface is running.
- For Android RN/Expo/dev-client apps that use local Metro, configure
  `adb reverse tcp:<port> tcp:<port>` for the app's Metro port before opening the app or URL.

## Worktree ownership and runner diagnostics

- Source-checkout daemon state is worktree-scoped, but devices are not. Use `pnpm daemon:state-dir`
  to inspect it and different devices for concurrent worktrees.
- The first Node process after a newly signed Apple runner launches may block during Gatekeeper
  verification. Warm it with a throwaway `node -e 0` before measuring.
- `DEVICE_IN_USE` has two flavors. "already in use by session X" is this daemon — follow its
  `close --session` hint. "owned by session X in workspace Y" is another worktree's device
  claim — non-retriable; run the error's `device status`/`device release --stale` recovery,
  never PID hunting. A live or uncertain claim blocks `open`. If the device rebooted since the
  owner's last `open` (including a reboot you caused), `open` settles the owner's app, runner, and
  accessibility resources, takes the claim, and reports the release in `warnings`.

The OS-neutral Apple runner lives under `packages/platform-apple/src/runner/`. For connection errors,
start at `runner-startup-transport.ts`; for retry policy, at `runner-error-classification.ts`; for
command typing, at `runner-contract.ts`. Transport stays below session/client
behavior, and xctestrun build/cache logic stays outside request execution.

## Session hygiene

- Close manually opened sessions, including failed verification attempts, using their original
  `--session`, `--platform`, `--udid`, and `--state-dir` values.
- Use a purpose-specific session name for experiments, and an isolated `--state-dir` under
  `/private/tmp` when you need cleanup isolation beyond the current worktree's default daemon.
- If `close` is blocked or ownership looks stuck, inspect it with
  `agent-device device status --stale` (daemonless), stop the owning daemon with
  `agent-device daemon stop --state-dir <dir>` (add `--clean` to remove retained runners), and
  release provably dead owners with `agent-device device release --stale`. Do not hunt PIDs with
  `ps`/`kill`.
- If cleanup cannot be completed, report the remaining session name, state dir, and the
  `device status --stale` output as a blocker.

## Foldable Apple devices

Read ADR 0025 before changing capture behavior on a multi-panel device. The iOS 27.1 runtime ships
only with the Xcode that carries it, and `xcode-select` may point at an older one, so pin the
toolchain per command:
`DEVELOPER_DIR=<Xcode-27.1>/Contents/Developer xcrun devicectl device info displays --device <udid>`.

- Panels: that command lists each integrated panel with `backlightState`. Only the lit panel is
  capturable — a capture of the dark panel exits 0 and writes an all-black PNG.
- Input routing: verify a fresh control after each pose change. A successful synthesis acknowledgement
  does not prove a hit. Inspect the runner and simulator `testmanagerd`/BackBoard logs for display
  identity and delivery; the resolved app window owns gesture coordinates and its target screen.
- Pose: `agent-device fold closed|half-open|open` sends private HID inside the simulator and reads
  the hinge back through `devicectl device motion hinge-angle`. Device Hub and host Accessibility
  permission are not required. Re-snapshot afterwards: refs and coordinates do not survive folds.
  Verify locally with Device Hub stopped and the simulator booted through `simctl boot`; test all
  three poses, active panel capture, and an app interaction. Duo coverage remains local until GHA
  supports the runtime. To inspect the angle independently:
  `xcrun devicectl device motion hinge-angle --device <udid> --session-timeout 1 --timeout 5`.
- Touch overlays export at the captured track size. The compositor checks its output (size,
  non-black) against the raw capture; on failure `record stop` keeps the raw file and reports
  `overlayWarning`. `record start --hide-touches` is only for the fastest raw capture.
- An app built with the iOS 27 SDK must adopt the UIScene lifecycle to launch on an iOS 27.0 or
  27.1 simulator at all: a legacy `UIApplicationDelegate` app traps at launch inside
  `___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`, which reads like a broken
  device but is not one.
- The 27.1 runtime in this beta accepts only the `iPhone Duo` device type, so a second non-foldable
  27.1 simulator cannot be created as a control.

## Sandboxed environments

The daemon binds localhost. If the sandbox rejects the listener with `listen EPERM`, rerun with
host access when permitted. Generic `Failed to start daemon` or cleanup errors alone do not prove a
sandbox cause; inspect the underlying failure. Run other checks in the sandbox unless their tools
require host access.
