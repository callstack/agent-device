# Verify on a device

Use this for Apple runner changes or manual device runs. For foldables, also read [foldable verification](device-foldable.md).

## Prepare

1. Build runtime changes with `pnpm build`.
2. For Android source verification, run `pnpm build:android`.
3. For Swift runner changes, run `pnpm build:xcuitest`.
   Graceful shutdown can hand off an active runner; a new daemon can adopt the old binary.
4. Run `pnpm clean:daemon` after the builds. The daemon does not reload code.
5. Use distinct devices for parallel worktrees. Inspect worktree-scoped state with `pnpm daemon:state-dir`.
6. For `Agent Device Tester`, follow `examples/test-app/README.md` for the build, Metro, and expected app surface.
   An installed `com.callstack.agentdevicelab` alone is insufficient.
7. For Android apps using Metro, run `adb reverse tcp:<port> tcp:<port>` before opening the app or URL.

## Prove the path

Run the exact changed route. Record commands, device, source SHA, and observable results.
For Android, require `snapshot -i --json` to show `androidSnapshot.backend: android-helper`
and `helperVersion` matching `package.json`. UIAutomator fallback proves only that fallback.

For Apple connection failures, start at `packages/platform-apple/src/runner/runner-startup-transport.ts`.
Retry policy belongs in `runner-error-classification.ts`; command typing belongs in `runner-contract.ts`.
Keep transport below session/client behavior. Keep xctestrun preparation outside request execution.
After signing, warm Node with `node -e 0` before measuring Gatekeeper-sensitive startup.

## Ownership and cleanup

Use purpose-specific sessions. For extra isolation, use a separate `--state-dir` under `/private/tmp`.
Close every manually opened session, including failed attempts, with its original session, platform, UDID, and state directory.

For `DEVICE_IN_USE`:

- "already in use by session X": follow this daemon's `close --session` hint.
- "owned by session X in workspace Y": inspect `device status`; follow `device release --stale` only for provably dead owners.
  A live or uncertain owner blocks `open` unless the device rebooted after the claim.
  With reboot evidence, `open` settles old resources, takes the claim, and reports release in `warnings`.
  Do not hunt PIDs or steal the claim.

For stuck cleanup, run `agent-device device status --stale`.
Stop the owning daemon with `agent-device daemon stop --state-dir <dir>`; add `--clean` for retained runners.
Release dead owners with `agent-device device release --stale`.
If blocked, report the session, state directory, and status output. Never hide incomplete cleanup.
The physical runner handoff checklist lives in `docs/evidence/ios-physical-runner-handoff-2026-09-19.md`.

## Platform policy

Apple runner changes run `pnpm check:xctest-selection` and build the affected target.
Swift `#if` guards own XCTest classification. Do not maintain a second test-name list.
Use macOS host lanes for pure decisions and simulator lanes for iOS/XCTest semantics.
If system policy rejects an unsigned host bundle, rebuild with `CODE_SIGN_IDENTITY="Apple Development"`
or select an identity from `security find-identity -v -p codesigning`.
First runs need XCUITest automation permission.

Keep Apple target changes synchronized across the kernel model, runtime-fact admission, dispatch,
discovery, and xctestrun preparation. Simulator-set scoping must not hide the host macOS target.
HarmonyOS has no provisioned CI device or HDC. Mocked tests do not replace local hardware evidence.
Read live smoke harnesses before running them; their environment contracts live in their entry files under `test/integration/`.

If a sandbox rejects localhost with `listen EPERM`, use host access when permitted.
Inspect the underlying error first. A generic startup or cleanup failure does not prove a sandbox cause.
