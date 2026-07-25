# Manual Device Verification

Read this before running `agent-device` by hand against a simulator, emulator, or physical device.

## Before the run: defeat staleness

Dev-loop staleness has three layers, and each produces a convincing false negative.

- After changing runtime code reached through `bin/agent-device.mjs` or the daemon: `pnpm build`,
  then `pnpm clean:daemon` — the daemon does not self-reload.
- Before any Android verification from source: `pnpm build`, `pnpm build:android`, `pnpm clean:daemon`.
  `build:android` refreshes and verifies both bundled Android helper artifacts for the current
  package version.
- `shutdown` deliberately HANDS OFF a healthy simulator runner. The adopted runner keeps serving the
  old Swift binary until you kill its process or the source fingerprint changes, so "my change did
  nothing" measured against an adopted runner is a classic false negative. If Swift runner code
  changed, run `pnpm build:xcuitest`.

## Prove the path under test was actually active

- Android: capture `snapshot -i --json` and require `androidSnapshot.backend` to be `android-helper`
  with `helperVersion` equal to `package.json`'s version. A stock UIAutomator fallback is not valid
  verification unless the fallback itself is the behavior under test.
- For repo-owned `Agent Device Tester` work, `examples/test-app/README.md` is the source of truth for
  simulator, physical-device, Metro/dev-client, and app-surface steps. An already-installed
  `com.callstack.agentdevicelab` is not sufficient — the README's Metro/dev-build and `snapshot -i`
  checks must prove the expected app surface is running.
- For Android RN/Expo/dev-client apps on any local Metro port, `adb reverse tcp:<port> tcp:<port>` is
  harmless and should be run before opening the app or URL.

## Session hygiene

Every manually opened session is a resource that must be closed — including exploratory sessions and
failed verification attempts.

- Every `agent-device open` needs a matching `close` with the same `--session`, `--platform`,
  `--udid`, and `--state-dir` before the agent finishes.
- Use a purpose-specific session name for experiments, and an isolated `--state-dir` under
  `/private/tmp` when you need cleanup isolation beyond the current worktree's default daemon.
- Track opened sessions in working notes; close each one before the final response.
- If `close` is blocked by stale daemon metadata, inspect processes first with
  `ps -ax | rg "agent-device|xcodebuild test-without-building"`. Stop only exact stale PIDs belonging
  to this verification run, then `pnpm clean:daemon`.
- If cleanup cannot be completed, report the remaining session name, state dir, PIDs, and metadata
  paths as a blocker.

## Sandboxed environments

Start the daemon outside the sandbox with escalation. The daemon binds localhost, and sandboxed runs
fail before any product code executes, with `listen EPERM: operation not permitted 127.0.0.1` or
repeated `Failed to start daemon`/metadata cleanup messages. Those are not agent-device regressions —
rerun with escalation. Unit tests, typecheck, lint, and build can stay sandboxed unless they need
devices or listener access.
