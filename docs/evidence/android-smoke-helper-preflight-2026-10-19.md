# Android smoke helper preparation

## Failure boundary

PR #3824 failed at `14f32fb218ac9e5608012bf6a5805652dc61f7fc` in [Android run 39287002936](https://github.com/callstack/agent-device/actions/runs/39287002936/job/118176526423).
The first `wait text "Automation lab" 10000` completed no readable capture.
The request log records 2314ms for helper installation, 5162ms for the persistent-session attempt, and 2958ms for the one-shot fallback.
The persistent attempt reports a UiAutomation connection timeout.
The outer wait deadline cancels the fallback.
An [earlier main run](https://github.com/callstack/agent-device/actions/runs/39025922562) has the same assertion and diagnostic.
The logs are under the artifact's hidden `.agent-device` directory.

The scenario now requires a successful helper-backed snapshot before its landmark wait.
The preflight pays the existing snapshot command's setup cost.
The landmark keeps its 10000ms deadline.
A failed preflight fails the scenario.
No wait retry, new timeout, or production fallback is added.
This change does not repair Android framework UiAutomation initialization.

## Local evidence

The base is `f8eddcbda35b4b1ee4e28de963925c77d77eab56`.
The device is the owned `pr3831-cold-capture`, serial `emulator-5562`, Android 16, arm64.
The release fixture uses the cached native fingerprint `22184ce7fc5743fac60a0b5e673374310cea6154` with current JavaScript repacked through the CI script.
The helper is built from source at version `0.21.29-dev`.
The hosted lane uses Linux and x86_64.
Local success does not establish hosted success.

The full smoke command passes all seven scenario groups in 73109ms, with one passed Node test and no failures or skips.
The command is:

```sh
AGENT_DEVICE_ANDROID_E2E=1 AGENT_DEVICE_ANDROID_E2E_TIER=smoke \
AGENT_DEVICE_ANDROID_SERIAL=emulator-5562 \
AGENT_DEVICE_FIXTURE_APP_PATH=<repacked-release-apk> \
AGENT_DEVICE_FIXTURE_APP_ID=com.callstack.agentdevicelab \
node --experimental-strip-types scripts/node-test-tmpdir.ts \
  --test test/integration/smoke-android-emulator.test.ts
```

An isolated ADB wrapper delays helper installation by 10200ms.
The original open/wait sequence fails with `wait_capture_stalled`, zero readable captures, and a 10125ms wait command.
The same cold setup with the scenario preflight passes: the snapshot takes 11589ms and the subsequent landmark wait takes 219ms.
This experiment proves the preparation boundary under injected host latency.
It does not reproduce the framework connection failure itself.
A missing landmark still fails its original wait.
An unavailable helper still fails the preflight before the landmark wait.
The focused coverage and harness checks pass 25 tests.

Raw logs, the injection wrapper, and commands are retained under `/private/tmp/pr3831-injection`.
The normal smoke log is `/private/tmp/pr3831-live-smoke.log`.

## Relevant upstream rebase

The branch was rebased onto `507ef2376621d78aa76cf531bedc5abdf30e7a5a` after #3811 and #3815 merged.
The range-diff preserves the harness patch.
Source `f7feeb9a72026700a71107ff63a3331a022750bb` was rebuilt with fresh native helpers.
Its first full smoke reached keyboard status, then failed with ADB exit 255.
The failure device evidence explicitly records `adb: device offline`.
After a direct keyboard query confirmed transport recovery, one unchanged repeat passed all seven groups in 42320ms.
The failed and recovered runs are both retained.
This does not establish hosted x86_64 success.
