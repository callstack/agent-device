---
title: TestMu AI
description: Drive TestMu AI (formerly LambdaTest) virtual devices, Android emulators and iOS simulators, and real devices with agent-device.
---

# TestMu AI

TestMu AI (formerly LambdaTest) hosts virtual devices for Android emulator and iOS simulator
WebDriver sessions, and real devices you select with `--provider-device-type real`. One Appium hub
fronts both pools; agent-device selects the pool with `isRealMobile` and defaults to the
virtual-device pool.

## Credentials and connection

Set TestMu AI credentials in a non-interactive environment. These are the same variables every
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

`--device` and `--provider-os-version` must match the virtual-device catalog spelling exactly. The
hub rejects `--provider-os-version 18` for a device listed with `18.0`, so `connect` does too and
lists the versions the device offers.

`--provider-app` accepts a TestMu AI app reference such as `lt://APP...`, an HTTP(S) app URL, or
an existing local app path (`.apk`, or a zipped simulator `.app` for iOS). When `open` creates the
hosted session, agent-device uploads a local path, and TestMu AI fetches a URL, through the
virtual-device upload API.

During `connect`, agent-device checks the device/OS pair against TestMu AI's virtual-device
catalog (`/capability/generator?isVirtualDevice=true`), verifies the credentials against your
uploaded-app listing, looks an `lt://` reference up in that listing, and confirms that a local
artifact exists before saving its absolute path. `connect` does not prove the app usable: an `lt://`
id missing from the listing is still accepted, and TestMu AI validates it, like a URL or local
upload, only when the session is created. `open` still needs the app's installed package or bundle
identifier, not the upload name or `lt://` id.

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

TestMu AI receives these values in `lt:options` when it creates the hosted session.

- Without `--provider-appium-version`, agent-device sends no Appium version and TestMu AI starts
  its default server for the device. Pin a version when a suite depends on one.
- `--provider-network-profile`, `--provider-custom-network`, and `--provider-no-resign-app` are
  BrowserStack capabilities; `connect testmu` and TestMu AI session creation refuse them by flag
  name rather than ignoring them.
- Session video and device logs are requested on every session so `artifacts` has something to
  return.

## Real devices

Pass `--provider-device-type real` to run on a physical device. Everything else works as for
virtual devices: `connect` checks the device/OS pair against the real-device catalog
(`/capability/generator?isVirtualDevice=false`), and a local path or URL is uploaded through the
real-device upload API.

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
- Real and virtual devices have separate upload APIs. Pass an `lt://` id that was uploaded for the
  pool you connect to; when in doubt, pass the local path or URL and let agent-device upload it.
- `TESTMU_REAL_DEVICE_APP_UPLOAD_ENDPOINT` redirects real-device uploads, as
  `TESTMU_APP_UPLOAD_ENDPOINT` does for virtual-device uploads.
- `--provider-device-type` applies only to TestMu AI; BrowserStack, AWS Device Farm, and Limrun
  refuse it on every route, including `client.leases.allocate()`.

## CLI workflow

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

For MCP-only use, run `connect` in the same effective state directory before starting
`agent-device mcp`. MCP exposes `open`, `snapshot`, `click`, `close`, and `artifacts`, but not
provider `connect` commands.

## Node.js client

The typed client reaches TestMu AI through a lease. Allocate one with the provider selectors, then
scope a client to it for normal commands. `sessions.close()` ends the hosted session and releases
the lease; `leases.release()` in `finally` is then a no-op, and still releases the lease when a
command fails first. The daemon reads `LT_USERNAME` and `LT_ACCESS_KEY` from its environment. Add
`providerDeviceType: 'real'` to `leases.allocate` to run on a real device.

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

## Artifacts and troubleshooting

After `close`, TestMu AI can return session video, Appium logs, device logs, network and command
logs, a screenshot archive, and the App Automation dashboard link. Run `agent-device artifacts
--json`, or look up a previous session explicitly:

```bash
agent-device artifacts <webdriver-session-id> --provider testmu --json
```

The TestMu AI session id is the WebDriver session id. If artifact lookup is pending immediately
after `close`, retry it; TestMu AI finalizes video and log URLs after the session ends.

Endpoints can be redirected for a staging or private TestMu AI deployment with
`TESTMU_WEBDRIVER_ENDPOINT`, `TESTMU_APP_UPLOAD_ENDPOINT` (virtual devices),
`TESTMU_REAL_DEVICE_APP_UPLOAD_ENDPOINT` (real devices), and `TESTMU_API_ENDPOINT`.

On hosted WebDriver sessions, `fill` checks that the field received focus before it sends keys. If
it cannot confirm focus, it fails without typing. Use `snapshot -i` to confirm the target, or
`press <target>` followed by `type <text>`.
