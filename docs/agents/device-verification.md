# Manual Device Verification

Read this for Apple runner changes or manual `agent-device` runs on simulators, emulators, or
physical devices. Live verification steps apply when exercising a device-facing path.

## Build freshness

- After changing runtime code reached through `bin/agent-device.mjs` or the daemon: `pnpm build`,
  then `pnpm clean:daemon` — the daemon does not self-reload.
- Before any Android verification from source: `pnpm build`, `pnpm build:android`, `pnpm clean:daemon`.
  `build:android` refreshes and verifies both bundled Android helper artifacts for the current
  package version.
- `shutdown` hands off a healthy simulator runner; a new daemon may adopt the old binary. After
  Swift runner changes, run `pnpm build:xcuitest` before verification. Use the session cleanup
  procedure below if ownership is stuck.

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
never PID hunting. One claim settles itself: if that device rebooted after the last `open` its owner
made, its app, runner, and accessibility session were destroyed, so `open` reconciles the owner's
resources, takes the claim, and says so in its warnings. A reboot you caused yourself during
verification looks exactly like that to the next `open` — until the owner reopens, which stamps the
boot it is now running on and makes the claim live again.

The OS-neutral Apple runner lives under `packages/platform-apple/src/runner/`. For connection errors,
retry policy, or command typing, start at `runner-contract.ts`; transport stays below session/client
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
- Pose is not scriptable. Ask the operator to fold or open the device in Device Hub, then
  re-snapshot; refs and coordinates do not survive the pose change.
- When a recording must show touches, assume it cannot. The touch-overlay exporter loses the track
  geometry whenever it has touch events to draw — `220x480` on a plain iPhone 17 as well as on the
  inner panel — and returns all-black frames on long clips, always with exit 0. Record with
  `record start --hide-touches` and make the interaction legible through its on-screen effect
  (typed text, navigation, a counter) instead of a cursor. The raw `simctl` capture behind it is
  correct. See ADR 0025 and #2707.
- An app must adopt the UIScene lifecycle to launch on iOS 27.1 at all: a legacy
  `UIApplicationDelegate` app traps at launch inside
  `___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`, which reads like a broken
  device but is not one.
- The 27.1 runtime in this beta accepts only the `iPhone Duo` device type, so a second non-foldable
  27.1 simulator cannot be created as a control.

## Sandboxed environments

The daemon binds localhost. If the sandbox rejects the listener with `listen EPERM`, rerun with
host access when permitted. Generic `Failed to start daemon` or cleanup errors alone do not prove a
sandbox cause; inspect the underlying failure. Run other checks in the sandbox unless their tools
require host access.
