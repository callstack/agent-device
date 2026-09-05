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
  never PID hunting.

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

## Sandboxed environments

The daemon binds localhost. If the sandbox rejects the listener with `listen EPERM`, rerun with
host access when permitted. Generic `Failed to start daemon` or cleanup errors alone do not prove a
sandbox cause; inspect the underlying failure. Run other checks in the sandbox unless their tools
require host access.
