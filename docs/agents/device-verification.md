# Verify on a device

Use this for Apple runner changes or manual device runs. For foldables, also read [foldable verification](device-foldable.md).

## Prepare

1. Run `pnpm build`, then verify only with its `node bin/agent-device.mjs`.
   Use a host binding, such as T3 Code `device_open`, only to view the device.
2. For Android source verification, run `pnpm build:android`.
3. For Swift runner changes, run `pnpm build:xcuitest`.
   A graceful shutdown can hand off an active runner. A new daemon can adopt the old binary.
4. After the builds, run `pnpm clean:daemon`. The daemon does not reload code.
5. To examine the worktree-scoped state, run `pnpm daemon:state-dir`.
6. For `Agent Device Tester`, follow the build, Metro, and app checks in `examples/test-app/README.md`. Installation alone is insufficient.
7. For Android apps that use Metro, run `adb reverse tcp:<port> tcp:<port>` before you open the app or URL.

## Prove the path

Run the changed route. Record the commands, device, source SHA, and observed results.
For Android, `snapshot -i --json` must show `androidSnapshot.backend: android-helper`.
Its `helperVersion` must match `package.json`. A UIAutomator fallback proves only that fallback.

For Apple connection failures, start at `packages/apple-runner/src/runner-startup-transport.ts`.
Retry policy belongs in `runner-error-classification.ts`. Command typing belongs in `runner-contract.ts`.
Keep the transport below session and client behavior. Keep xctestrun preparation outside request execution.
After signing, run `node -e 0` before you measure Gatekeeper-sensitive startup.
Before you measure on a physical iOS device, set Auto-Lock to Never.
A failed command can look like a fast success. Before you record its time, check its exit status and output.

## Ownership and cleanup

Use one session per purpose. To isolate daemon state, create a directory with `mktemp -d` and pass it to `--state-dir`.
Close each session that you opened manually, including failed attempts, with its original session, platform, UDID, and state directory.
If your session booted a local simulator or emulator, add `--shutdown`, unless the user asks to keep it running.

For `DEVICE_IN_USE`:

- "already in use by session X": follow the `close --session` hint of this daemon.
- "owned by session X in workspace Y": examine `device status`. Use `device release --stale` only for provably dead owners.
  A live or uncertain owner blocks `open`, unless the device rebooted after the claim.
  Do not search for PIDs. Do not steal the claim.

If cleanup is stuck, run `agent-device device status --stale`.
To stop the owning daemon, run `agent-device daemon stop --state-dir <dir>`. For retained runners, add `--clean`.
Report incomplete cleanup. If blocked, include the session, state directory, and status output.
The physical runner handoff checklist is in `docs/evidence/ios-physical-runner-handoff-2026-09-19.md`.

## Platform policy

For Apple runner changes, run `pnpm check:xctest-selection` and build the affected target.
Swift `#if` guards own the XCTest classification. Do not keep a second list of test names.
Use macOS host lanes for pure decisions. Use simulator lanes for iOS and XCTest semantics.
If system policy rejects an unsigned host bundle, rebuild with `CODE_SIGN_IDENTITY="Apple Development"`
or an identity from `security find-identity -v -p codesigning`.
The first run needs XCUITest automation permission.

When you change Apple targets, synchronize the kernel model, runtime-fact admission, dispatch,
discovery, and xctestrun preparation. Simulator-set scoping must not hide the host macOS target.
HarmonyOS has no provisioned CI device or HDC. Mocked tests do not replace local hardware evidence.
Before you run a live smoke harness, read its entry file under `test/integration/` for environment requirements.

If a sandbox rejects localhost with `listen EPERM`, use host access, if permitted.
A generic startup or cleanup failure does not prove a sandbox cause.
