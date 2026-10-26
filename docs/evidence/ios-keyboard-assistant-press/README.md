# App-owned input assistant validation

This standalone UIKit fixture uses `UITextField.inputAssistantItem` to put an app-owned
button above the key plane. Pressing it increments an observable label. It contains no
application dependencies.

## Build and run

From the repository root, with an owned, booted iPad simulator selected by `UDID`:

```sh
: "${UDID:?Set UDID to an owned, booted iPad simulator UUID}"
export UDID
export STATE_DIR="$(mktemp -d /private/tmp/assistant-review.XXXXXX)"
export AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH="$PWD/.tmp/assistant-runner-derived"
export AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS=1
export AGENT_DEVICE_XCUITEST_ARCHS=arm64
pnpm build
pnpm build:xcuitest:ios
AGENT_DEVICE_STATE_DIR="$STATE_DIR" pnpm clean:daemon
mkdir -p .tmp/AssistantProbe.app
python3 - <<'PY'
import plistlib
with open('.tmp/AssistantProbe.app/Info.plist', 'wb') as out:
    plistlib.dump({
        'CFBundleIdentifier': 'com.example.agentdevice.assistantprobe',
        'CFBundleExecutable': 'AssistantProbe', 'CFBundleName': 'Assistant Probe',
        'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1',
        'CFBundleShortVersionString': '1.0', 'MinimumOSVersion': '17.0',
        'UIDeviceFamily': [1, 2], 'UILaunchScreen': {},
        'UIApplicationSceneManifest': {'UIApplicationSupportsMultipleScenes': False},
        'UISupportedInterfaceOrientations': ['UIInterfaceOrientationPortrait'],
    }, out)
PY
xcrun --sdk iphonesimulator clang -fobjc-arc -target arm64-apple-ios17.0-simulator \
  -framework UIKit -framework Foundation \
  docs/evidence/ios-keyboard-assistant-press/main.m \
  -o .tmp/AssistantProbe.app/AssistantProbe
codesign --force --sign - .tmp/AssistantProbe.app
xcrun simctl install "$UDID" .tmp/AssistantProbe.app
node bin/agent-device.mjs open com.example.agentdevice.assistantprobe \
  --platform ios --udid "$UDID" --session assistant-review --state-dir "$STATE_DIR" --relaunch
```

The setup selects the build directory before building and cleans the same state
directory used by the CLI and SDK. See the [keyboard evidence contract](../../../website/docs/docs/snapshots.md)
for the meaning of each `keyboard` variant and complete-capture absence evidence.

The initial snapshot must show `Assistant actions: 0`. For XCTest route evidence,
use the repository's existing conformance transport (an internal test control, not a
public backend-selection API). Save this snippet under `.tmp/` and run it from the
repository root with `node --experimental-strip-types`:

```js
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const load = path => import(pathToFileURL(`${root}/${path}`).href);
const { createAgentDeviceClient } = await load('dist/src/index.js');
const { readDaemonInfo } = await load('src/daemon-client/daemon-client-metadata.ts');
const { sendRequest } = await load('src/daemon-client/daemon-client-transport.ts');
const { resolveDaemonPaths } = await load('packages/daemon-contracts/src/daemon-resolution.ts');
const { createSnapshotBackendConformanceTransport } = await load('test/integration/ios-simulator-e2e/snapshot-backend-conformance.ts');
const { STATE_DIR: stateDir, UDID: udid } = process.env;
const paths = resolveDaemonPaths(stateDir, { env: process.env, cwd: root });
const info = readDaemonInfo(paths.infoPath);
assert.ok(info);
const transport = (request, context) => sendRequest(
  info, { ...request, token: info.token }, 'auto', paths, 90000,
  { host: { env: process.env, cwd: root }, signal: context?.signal, timeoutRecovery: 'none' },
);
const client = createAgentDeviceClient(
  { session: 'assistant-review', stateDir, daemonLifecycle: 'attach' },
  { transport: createSnapshotBackendConformanceTransport('tree', transport) },
);
const result = await client.capture.snapshot({ platform: 'ios', udid, raw: true });
assert.equal(result.snapshotQuality.backend, 'tree');
console.log(JSON.stringify({
  keyboard: result.keyboard,
  nodes: result.nodes.filter(node =>
    ['assistant-action', 'assistant-status', 'SystemInputAssistantView'].includes(node.identifier)
    || node.type === 'Keyboard'),
}, null, 2));
```

Use the assistant action's returned ref, including `@`, for the CLI command:

```sh
node bin/agent-device.mjs press '@e22' --settle \
  --session assistant-review --state-dir "$STATE_DIR" --json
```

Capture again through the conformance transport and verify `Assistant actions: 1`.
Then use an ordinary `snapshot -i` and its current assistant ref to repeat through the
AX capture route; verify `Assistant actions: 2`. Ref numbers are capture-specific.

```sh
node bin/agent-device.mjs close --session assistant-review --platform ios --udid "$UDID" --state-dir "$STATE_DIR"
node bin/agent-device.mjs daemon stop --clean --state-dir "$STATE_DIR"
```

Shut down/delete only the simulator created for this validation.

## Observed results

On an iPad Pro 11-inch (M4) simulator, iOS 27.0, portrait:

- XCTest capture: `snapshotQuality.backend = tree`, healthy; measured keyboard band
  `(0, 870, 834, 337)`, assistant host `(0, 870, 834, 55)`, key plane
  `(0, 925, 834, 282)`, app button `(28, 871, 121, 49)`.
- CLI press returned `success: true`; subsequent XCTest capture showed
  `Assistant actions: 1`. The button is inside the measured band and above the keys.
- AX capture exposes `TUISystemInputAssistantView`; XCTest instead reports an `Other`
  node identified as `SystemInputAssistantView`. Both representations are covered.
- Scoped XCTest capture retained only the app button with `keyboardOwned: true`. Its
  CLI press succeeded, and a full follow-up capture showed `Assistant actions: 1` after
  relaunch. The new native projection regression fails without retained membership
  for both raw and regular scoped captures.
- AX-backed CLI press also succeeded and the label became `Assistant actions: 2`.
- Same focused Vitest command on base `81266c2598b162d373703a921fdfedaee97ea00f`,
  with only regression tests/fixtures applied: **2 failed, 19 passed**. With this fix:
  **21 passed**.
- Native keyboard XCTest selection: **15 passed**; shared presentation Swift tests:
  **24 passed**. iOS and macOS runner builds passed.

These are local execution results, not a GitHub native-lane pass. PR workflows require
maintainer approval; no passing native CI result is claimed.
