# Verify on a device

Use this for Apple runner changes or manual device runs. For foldables, also read [foldable verification](device-foldable.md).

## Prepare

1. To build runtime changes, run `pnpm build`.
2. For Android source verification, run `pnpm build:android`.
3. For Swift runner changes, run `pnpm build:xcuitest`.
   A graceful shutdown can hand off an active runner. A new daemon can adopt the old binary.
4. After the builds, run `pnpm clean:daemon`. The daemon does not reload code.
5. To examine the worktree-scoped state, run `pnpm daemon:state-dir`.
6. For `Agent Device Tester`, follow `examples/test-app/README.md` for the build, Metro, and expected app surface.
   An installed `com.callstack.agentdevicelab` alone is not sufficient.
7. For Android apps that use Metro, run `adb reverse tcp:<port> tcp:<port>` before you open the app or URL.

## Prove the path

Run the exact route that changed. Record the commands, device, source SHA, and observable results.
For Android, `snapshot -i --json` must show `androidSnapshot.backend: android-helper`.
Its `helperVersion` must match `package.json`. A UIAutomator fallback proves only that fallback.

For Apple connection failures, start at `packages/platform-apple/src/runner/runner-startup-transport.ts`.
Retry policy belongs in `runner-error-classification.ts`. Command typing belongs in `runner-contract.ts`.
Keep the transport below session and client behavior. Keep xctestrun preparation outside request execution.
After signing, run `node -e 0` before you measure Gatekeeper-sensitive startup.

## Ownership and cleanup

Use one session for each purpose. For more isolation, use a separate `--state-dir` under `/private/tmp`.
Close each session that you opened manually, also failed attempts, with its original session, platform, UDID, and state directory.

For `DEVICE_IN_USE`:

- "already in use by session X": follow the `close --session` hint of this daemon.
- "owned by session X in workspace Y": examine `device status`. Use `device release --stale` only for provably dead owners.
  A live or uncertain owner blocks `open`, unless the device rebooted after the claim.
  With reboot evidence, `open` settles old resources, takes the claim, and reports the release in `warnings`.
  Do not search for PIDs. Do not steal the claim.

If cleanup is stuck, run `agent-device device status --stale`.
To stop the owning daemon, run `agent-device daemon stop --state-dir <dir>`. For retained runners, add `--clean`.
To release dead owners, run `agent-device device release --stale`.
If you are blocked, report the session, state directory, and status output. Always report incomplete cleanup.
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
Before you run a live smoke harness, read it. Its environment contract is in its entry file under `test/integration/`.

If a sandbox rejects localhost with `listen EPERM`, use host access, if permitted.
First, examine the underlying error. A generic startup or cleanup failure does not prove a sandbox cause.
