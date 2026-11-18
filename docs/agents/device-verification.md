# Verify on a device

For foldables, also read [foldable verification](device-foldable.md).

## Prepare

1. Run `pnpm build` for runtime changes, `pnpm build:android` for Android sources, and `pnpm build:xcuitest` for Swift runner changes.
   A graceful shutdown can hand off an active runner. A new daemon can adopt the old binary.
2. After the builds, run `pnpm clean:daemon`. The daemon does not reload code.
3. For the worktree-scoped state, run `pnpm daemon:state-dir`.
4. For `Agent Device Tester`, follow `examples/test-app/README.md` for the build, Metro, and expected app surface.
   An installed `com.callstack.agentdevicelab` alone is not enough.
5. For Android apps on Metro, run `adb reverse tcp:<port> tcp:<port>` before opening the app or URL.

## Prove the path

Run the changed route. Record the commands, device, source SHA, and observable results.
For Android, `snapshot -i --json` must show `androidSnapshot.backend: android-helper`.
Its `helperVersion` must match `package.json`. A UIAutomator fallback proves only that fallback.

For Apple connection failures, start at `packages/apple-runner/src/runner-startup-transport.ts`.
Retry policy belongs in `runner-error-classification.ts`, command typing in `runner-contract.ts`.
Keep the transport below session and client behavior, and xctestrun preparation outside request execution.
After signing, run `node -e 0` before you measure Gatekeeper-sensitive startup.
Before you measure on a physical iOS device, set Auto-Lock to Never.
Before you time a command, examine its exit status and output. A failure can look like a fast success.

## Ownership and cleanup

Use one session per purpose. For more isolation, use a separate `--state-dir` under `/private/tmp`.
Close each session you opened manually, including failed attempts, with its original session, platform, UDID, and state directory.
If your session booted a local simulator or emulator, add `--shutdown` unless the user wants it kept running.

For `DEVICE_IN_USE`:

- "already in use by session X": follow the `close --session` hint of this daemon.
- "owned by session X in workspace Y": examine `device status`. Use `device release --stale` only for provably dead owners.
  A live or uncertain owner blocks `open` unless the device rebooted after the claim.
  Do not search for PIDs. Do not steal the claim.

If cleanup is stuck, run `agent-device device status --stale`.
To stop the owning daemon, run `agent-device daemon stop --state-dir <dir>`. For retained runners, add `--clean`.
If blocked, report the session, state directory, and status output. Always report incomplete cleanup.
The physical runner handoff checklist is in `docs/evidence/ios-physical-runner-handoff-2026-09-19.md`.

## Platform policy

For Apple runner changes, run `pnpm check:xctest-selection` and build the affected target.
Swift `#if` guards own the XCTest classification. Do not keep a second list of test names.
Use macOS host lanes for pure decisions, and simulator lanes for iOS and XCTest semantics.
If system policy rejects an unsigned host bundle, rebuild with `CODE_SIGN_IDENTITY="Apple Development"`
or an identity from `security find-identity -v -p codesigning`.
The first run needs XCUITest automation permission.

When you change Apple targets, synchronize the kernel model, runtime-fact admission, dispatch,
discovery, and xctestrun preparation. Simulator-set scoping must not hide the host macOS target.
HarmonyOS has no CI device or HDC. Mocked tests do not replace local hardware evidence.
Before you run a live smoke harness, read its entry file under `test/integration/` for its environment contract.

If a sandbox rejects localhost with `listen EPERM`, use host access, if permitted.
First, examine the underlying error. A generic startup or cleanup failure does not prove a sandbox cause.
