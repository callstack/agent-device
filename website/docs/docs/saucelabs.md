---
title: Sauce Labs
description: Drive Sauce Labs Real Device Cloud Android and iOS devices with agent-device.
---

Use the Sauce Labs Real Device Cloud to run agent-device on hosted Android and iOS real devices
over WebDriver. You need a Sauce Labs account with real-device access and the
`@agent-device/saucelabs` plugin. Sauce Labs emulators and simulators are not supported.

## Install the plugin

```bash
agent-device plugins add @agent-device/saucelabs
```

The plugin is an optional npm package installed under `AGENT_DEVICE_HOME`.
After you add or update it, close open sessions and run `agent-device daemon stop`
with the state directory you use; the next device command loads the plugin.
agent-device does not reserve the `saucelabs` provider id for itself, so this plugin is what
`connect saucelabs` loads.

## Set credentials and connect

Export your Sauce Labs credentials and data center, for example from CI secrets. These are the
variables the Sauce Labs tools read:

```bash
export SAUCE_USERNAME=...
export SAUCE_ACCESS_KEY=...
export SAUCE_REGION=eu-central-1   # us-west-1 (default), eu-central-1, or us-east-4
```

Connect with the platform, device, and app to test:

```bash
export AGENT_DEVICE_SESSION=checkout-android
agent-device connect saucelabs \
  --platform android \
  --device "Google Pixel 8" \
  --provider-os-version 14 \
  --provider-app storage:<file-id>
```

- `SAUCE_REGION` selects the data center. The device catalog and app storage are separate per data center. The daemon compares `SAUCE_REGION` with your shell like the credentials, so a daemon started for another data center refuses before it creates a session.
- `--device` takes a device name such as `Google Pixel 8`, a device ID such as `Google_Pixel_8_14_real` to pin one device, or a name pattern such as `Google Pixel.*`. Sauce Labs picks a free device that matches, and the session records the model and device ID it allocated.
- `--provider-os-version` is optional. `14` matches any 14.x release.
- `--provider-app` accepts `storage:<file-id>`, `storage:filename=<name>` for the newest upload of that name, an `https://` app URL, or an existing local app path. agent-device uploads a local path to Sauce Labs app storage when it creates the session. Plain `http://` URLs are refused.

`connect` verifies the credentials, finds a real device that matches the device and OS version,
and checks a `storage:` reference against your app storage. A file id must name an Android or iOS
app for the connected platform, and not an iOS simulator build. A `storage:filename=` name that
connect cannot find is saved as configured; Sauce Labs resolves it when the session starts, as it
does for an app URL. `open` takes the app's installed package or bundle identifier, not its upload
name.

If you change credentials while the daemon runs, see [Change credentials while the daemon runs](/docs/device-clouds#change-credentials-while-the-daemon-runs).

Optional labels and session options:

```bash
--provider-build "$GITHUB_RUN_ID"            # sauce:options build
--provider-session-name "$GITHUB_JOB"        # sauce:options name
--provider-appium-version latest             # sauce:options appiumVersion, default latest
--provider-device-orientation portrait       # or landscape
--provider-no-resign-app                     # iOS only: sauce:options resigningEnabled false
```

Without labels, the build is the connection run ID and the session name is the lease ID.

## Session limits

- Sauce Labs ends a real-device session after 90 seconds without a command, the longest idle time it allows. If an agent pauses longer, the next command fails because the session is gone. Run `agent-device close`, then `agent-device open` again to start a new session.
- When no matching device is free, Sauce Labs keeps looking for 100 seconds and does not retry, so `open` fails within its own time limit instead of renting a device after it stopped waiting.

## Run a session from the CLI

```bash
export SAUCE_USERNAME=...
export SAUCE_ACCESS_KEY=...
export SAUCE_REGION=eu-central-1
export AGENT_DEVICE_SESSION=checkout-android

agent-device connect saucelabs \
  --platform android \
  --device "Google Pixel 8" \
  --provider-os-version 14 \
  --provider-app storage:<file-id> \
  --provider-build "$GITHUB_RUN_ID"

agent-device open com.example.app
agent-device snapshot -i
agent-device click 'label="Continue"'
agent-device close
agent-device artifacts --json
agent-device disconnect
```

To drive Sauce Labs only through MCP, see [Use a provider only through MCP](/docs/device-clouds#use-a-provider-only-through-mcp).

## Use the Node.js client

The Node.js client reaches Sauce Labs through a lease. Allocate one with the provider selectors,
then create a client scoped to it for device commands. `sessions.close()` ends the hosted session
and releases the lease. Keep `leases.release()` in `finally`: it does nothing after a successful
close, and releases the lease when a command fails first.

The daemon reads `SAUCE_USERNAME`, `SAUCE_ACCESS_KEY`, and `SAUCE_REGION` from its environment, unless a JavaScript host passes the plugin `saucelabs({ credentials })` instead.

```ts
import { createAgentDeviceClient } from 'agent-device';

const scope = {
  tenant: 'saucelabs',
  runId: process.env.GITHUB_RUN_ID ?? 'local-run',
  leaseBackend: 'android-instance',
  leaseProvider: 'saucelabs',
} as const;

const lease = await createAgentDeviceClient().leases.allocate({
  ...scope,
  platform: 'android',
  device: 'Google Pixel 8',
  providerOsVersion: '14',
  providerApp: 'storage:<file-id>',
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
  const artifacts = await client.sessions.artifacts({ provider: 'saucelabs', providerSessionId });
  if ('cloudArtifacts' in artifacts) console.log(artifacts.cloudArtifacts);
}
```

## Get artifacts and troubleshoot

The provider session ID is the Sauce Labs real-device job ID, which differs from the WebDriver
session ID. As soon as the job exists, `artifacts` returns its dashboard link with status
`pending`. Once the job ends, usually a few seconds after `close`, it also returns the session
video, Appium logs, device logs, and the WebDriver request log. These media and log URLs are on the
Sauce Labs API, so download them with basic authentication using `SAUCE_USERNAME` and
`SAUCE_ACCESS_KEY`. See [Retrieve artifacts after close](/docs/device-clouds#retrieve-artifacts-after-close).

Sauce Labs errors carry a typed `details.reason`:

- `saucelabs_region_unknown`: `SAUCE_REGION` names a data center Sauce Labs does not run.
- `saucelabs_app_reference_invalid`: `--provider-app` uses `storage:` outside the `storage:<file-id>` or `storage:filename=<name>` grammar.
- `saucelabs_app_url_insecure`: `--provider-app` is an `http://` URL.
- `saucelabs_device_not_found`: no real device in the data center matches `--device` and `--provider-os-version`.
- `saucelabs_app_not_found`: no upload in the data center has the `storage:` file id.
- `saucelabs_app_platform_mismatch`: the upload is an app for the other platform.
- `saucelabs_app_kind_unsupported`: the upload is not an Android or iOS app, such as a test bundle.
- `saucelabs_app_simulator_build`: the upload is an iOS simulator build, which a real device cannot install.
- `saucelabs_no_resign_app_ios_only`: `--provider-no-resign-app` was set for an Android session.
- `saucelabs_job_not_found`: the data center has no job with the provider session ID; check `SAUCE_REGION`.

Rejected credentials fail with `UNAUTHORIZED`. See [Error reasons](/docs/error-reasons).

To enter text, see [Fill text on hosted WebDriver sessions](/docs/device-clouds#fill-text-on-hosted-webdriver-sessions).
