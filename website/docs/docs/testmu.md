---
title: TestMu AI
description: Drive TestMu AI (formerly LambdaTest) virtual devices, Android emulators and iOS simulators, and real devices with agent-device.
---

# TestMu AI

Use TestMu AI (formerly LambdaTest) to run agent-device on hosted Android emulators, iOS
simulators, and real devices over WebDriver. agent-device uses virtual devices (emulators and
simulators) by default; pass `--provider-device-type real` for a real device. You need a TestMu AI
account and the `@agent-device/testmu` plugin.

## Install the plugin

```bash
agent-device plugins add @agent-device/testmu
```

The plugin is an optional npm package installed under `AGENT_DEVICE_HOME`.
After you add or update it, close open sessions and run `agent-device daemon stop`
with the state directory you use; the next device command loads the plugin.

## Set credentials and connect

Export your TestMu AI credentials, for example from CI secrets. These are the same variables every
TestMu AI SDK reads:

```bash
export LT_USERNAME=...
export LT_ACCESS_KEY=...
```

Connect with the platform, exact device name and OS version, and the app to test:

```bash
agent-device connect testmu \
  --platform android \
  --device "Galaxy S22 Ultra 5G" \
  --provider-os-version 14 \
  --provider-app lt://APP-id
```

`--device` and `--provider-os-version` must match the spelling in TestMu AI's virtual-device
catalog exactly. TestMu AI rejects `--provider-os-version 18` for a device listed as `18.0`, so
`connect` rejects it too and lists the versions the device offers.

`--provider-app` accepts a TestMu AI app reference such as `lt://APP...`, an HTTP(S) app URL, or
an existing local app path (`.apk`, or a zipped simulator `.app` for iOS). When `open` creates the
hosted session, agent-device uploads a local path, and TestMu AI fetches a URL, through the
virtual-device upload API.

`connect` checks the device/OS pair against TestMu AI's virtual-device catalog, verifies the
credentials against your uploaded-app list, looks up an `lt://` reference in that list, and confirms
that a local app file exists before saving its absolute path. A successful `connect` does not prove
the app works: it still accepts an `lt://` ID missing from the list, and TestMu AI validates that ID,
like a URL or local upload, only when the session starts. `open` takes the app's installed package or
bundle identifier, not the upload name or `lt://` ID.

Optional labels:

```bash
--provider-project agent-device
--provider-build "$GITHUB_RUN_ID"
--provider-session-name "$GITHUB_JOB"
```

Optional device features:

```bash
--provider-device-orientation portrait   # or landscape        (alias --device-orientation)
--provider-geo-location US                                   # (alias --geo-location)
--provider-timezone UTC+05:30                                # (alias --timezone)
--provider-appium-version 2.16.2                             # (alias --appium-version)
--provider-language fr                                       # (alias --language)
--provider-locale fr_FR                                      # (alias --locale)
```

agent-device sends these values to TestMu AI as `lt:options` capabilities when it creates the
hosted session.

- Without `--provider-appium-version`, TestMu AI starts its default Appium server for the device.
  Pin a version when your suite depends on one.
- `--provider-network-profile`, `--provider-custom-network`, and `--provider-no-resign-app` are
  BrowserStack-only. `connect testmu` and TestMu AI session creation fail with the flag name
  instead of ignoring them.
- agent-device requests session video and device logs on every session, so `artifacts` has something
  to return once TestMu AI makes them available.

## Run on real devices

Pass `--provider-device-type real` to run on a physical device. Everything else works as it does
for virtual devices: `connect` checks the device/OS pair against the real-device catalog, and
agent-device uploads a local path or URL through the real-device upload API.

```bash
agent-device connect testmu \
  --provider-device-type real \
  --platform ios \
  --device "iPhone 16" \
  --provider-os-version 18 \
  --provider-app ./MyApp.ipa

agent-device connect testmu \
  --provider-device-type real \
  --platform android \
  --device "Pixel 6" \
  --provider-os-version 14 \
  --provider-app https://example.com/builds/app.apk
```

- Real iOS devices are listed by major OS version only: use `--provider-os-version 18`, not `18.0`.
  The exact-spelling check still applies, so `connect` rejects `18.0` for a real iPhone 16 and lists
  the versions it offers.
- Real iOS devices install a signed `.ipa`; a zipped simulator `.app` only runs on simulators.
  Android takes an `.apk` or `.aab`.
- Real and virtual devices have separate uploads. Pass an `lt://` ID uploaded for the device type
  you connect to; when in doubt, pass the local path or URL and let agent-device upload it.
- `TESTMU_REAL_DEVICE_APP_UPLOAD_ENDPOINT` redirects real-device uploads, as
  `TESTMU_APP_UPLOAD_ENDPOINT` does for virtual-device uploads.
- `--provider-device-type` applies only to TestMu AI; BrowserStack, AWS Device Farm, and Limrun
  refuse it on every route, including `client.leases.allocate()`.

## Run a session from the CLI

```bash
export LT_USERNAME=...
export LT_ACCESS_KEY=...

agent-device connect testmu \
  --platform ios \
  --device "iPhone 16" \
  --provider-os-version 18.0 \
  --provider-app ./MyApp.app.zip \
  --provider-build "$GITHUB_RUN_ID"

agent-device open com.example.app
agent-device snapshot -i
agent-device click 'label="Continue"'
agent-device close
agent-device artifacts --json
agent-device disconnect
```

To use TestMu AI only through MCP, run `connect` in the same effective state directory before you
start `agent-device mcp`. MCP exposes device commands such as `open`, `snapshot`, `close`, and
`artifacts`, but not provider `connect` commands.

## Use the Node.js client

The Node.js client reaches TestMu AI through a lease. Allocate one with the provider selectors, then
create a client scoped to it for device commands. `sessions.close()` ends the hosted session and
releases the lease. Keep `leases.release()` in `finally`: it does nothing after a successful close,
and releases the lease when a command fails first. Add `providerDeviceType: 'real'` to
`leases.allocate` to run on a real device.

The daemon reads `LT_USERNAME` and `LT_ACCESS_KEY` from its environment and keeps the values it
started with. If your shell holds different ones, the first command that allocates a lease, such as
`open`, refuses before it creates a session. Run `agent-device daemon stop` (with the same
`--state-dir`) and rerun the command. A shell that sets neither variable uses the daemon's
credentials.

```ts
import { createAgentDeviceClient } from 'agent-device';

const scope = {
  tenant: 'testmu',
  runId: process.env.GITHUB_RUN_ID ?? 'local-run',
  leaseBackend: 'ios-instance',
  leaseProvider: 'testmu',
} as const;

const lease = await createAgentDeviceClient().leases.allocate({
  ...scope,
  platform: 'ios',
  device: 'iPhone 16',
  providerOsVersion: '18.0',
  providerApp: 'lt://APP-id',
  providerProject: 'agent-device',
  providerBuild: process.env.GITHUB_RUN_ID,
});
const client = createAgentDeviceClient({ ...scope, leaseId: lease.leaseId });

let providerSessionId: string | undefined;
try {
  await client.apps.open({ app: 'com.example.app' });
  await client.capture.snapshot({ interactiveOnly: true });
  await client.interactions.click({ selector: 'label="Continue"' });
  const closed = await client.sessions.close();
  providerSessionId = closed.provider?.providerSessionId;
} finally {
  await client.leases.release({ ...scope, leaseId: lease.leaseId });
}

if (providerSessionId) {
  const artifacts = await client.sessions.artifacts({ provider: 'testmu', providerSessionId });
  if ('cloudArtifacts' in artifacts) console.log(artifacts.cloudArtifacts);
}
```

## Get artifacts and troubleshoot

After `close`, TestMu AI can return session video, Appium logs, device logs, network and command
logs, a screenshot archive, and the App Automation dashboard link. Run `agent-device artifacts
--json`, or look up an earlier session by its ID:

```bash
agent-device artifacts <webdriver-session-id> --provider testmu --json
```

The TestMu AI session ID is the WebDriver session ID. If artifacts are still pending right after
`close`, retry the lookup; TestMu AI finalizes video and log URLs after the session ends.

To use a staging or private TestMu AI deployment, redirect the WebDriver, upload, and
catalog/session-detail endpoints with `TESTMU_WEBDRIVER_ENDPOINT`, `TESTMU_APP_UPLOAD_ENDPOINT` (virtual
devices), `TESTMU_REAL_DEVICE_APP_UPLOAD_ENDPOINT` (real devices), and `TESTMU_API_ENDPOINT`. The
app list that `connect` uses to check credentials always comes from
`https://manual-api.lambdatest.com/app/data`.

On hosted WebDriver sessions, `fill` checks that the field received focus before it sends keys. If
it cannot confirm focus, it fails without typing. Use `snapshot -i` to confirm the target. If the
driver cannot report focus at all, use `press <target>` followed by `type <text>`, which sends text
without confirming where it lands.
