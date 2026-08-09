---
title: BrowserStack
description: Drive BrowserStack App Automate sessions with agent-device.
---

# BrowserStack

Use BrowserStack App Automate for hosted Android and iOS WebDriver sessions.

## Credentials and connection

Set BrowserStack credentials in a non-interactive environment:

```bash
export BROWSERSTACK_USERNAME=...
export BROWSERSTACK_ACCESS_KEY=...
```

Connect with the platform, exact device and OS version, and app to test:

```bash
agent-device connect browserstack \
  --platform android \
  --device "Google Pixel 8" \
  --provider-os-version 14.0 \
  --provider-app bs://app-id
```

`--provider-app` accepts a BrowserStack app reference such as `bs://...`, an HTTP(S) app URL, or an existing local app path. BrowserStack uploads a local path when it creates the hosted session.

During `connect`, agent-device verifies the BrowserStack credentials and the exact device/OS pair. It checks a `bs://` reference against recent uploads and confirms that a local artifact exists before saving its absolute path. A public URL stays configured and BrowserStack validates it when the session starts. `open` still needs the app's installed package or bundle identifier, not its upload name.

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
--provider-timezone New_York                                 # (alias --timezone)
--provider-language Fr                                       # (alias --language)
--provider-locale Fr                                         # (alias --locale)
--provider-network-profile 4g-lte-advanced-good              # (alias --network-profile)
--provider-custom-network 1000                               # (alias --custom-network)
--provider-no-resign-app                                     # iOS only
```

BrowserStack receives these values in `bstack:options` when it creates the hosted session.

- The orientation applies when the session starts. An activity without a fixed orientation, such as a Chrome Custom Tab hosting OAuth, can still open in landscape. Run `agent-device orientation portrait` after launching it when needed.
- `--provider-network-profile` and `--provider-custom-network` are mutually exclusive.
- `--provider-no-resign-app` applies to iOS only. BrowserStack re-signs uploaded iOS apps with its provisioning profile, which strips entitlements; opt out when testing entitlement-dependent features such as push notifications.

## CLI workflow

```bash
export BROWSERSTACK_USERNAME=...
export BROWSERSTACK_ACCESS_KEY=...

agent-device connect browserstack \
  --platform android \
  --device "Google Pixel 8" \
  --provider-os-version 14.0 \
  --provider-app bs://app-id \
  --provider-project agent-device \
  --provider-build "$GITHUB_RUN_ID"

agent-device open com.example.app
agent-device snapshot -i
agent-device click 'label="Continue"'
agent-device close
agent-device artifacts --json
agent-device disconnect
```

For MCP-only use, run `connect` in the same effective state directory before starting `agent-device mcp`. MCP exposes `open`, `snapshot`, `click`, `close`, and `artifacts`, but not provider `connect` commands.

## Node.js client

Use direct client configuration when the Node process manages BrowserStack credentials and selectors rather than a saved CLI connection profile:

```ts
import { createAgentDeviceClient } from 'agent-device';

const client = createAgentDeviceClient({
  leaseProvider: 'browserstack',
  platform: 'android',
  device: 'Google Pixel 8',
  providerOsVersion: '14.0',
  providerApp: 'bs://app-id',
  providerProject: 'agent-device',
  providerBuild: process.env.GITHUB_RUN_ID,
});

await client.apps.open({ app: 'com.example.app' });
const snapshot = await client.capture.snapshot({ interactiveOnly: true });
console.log(snapshot.nodes.slice(0, 5));
await client.interactions.click({ selector: 'label="Continue"' });
const closed = await client.sessions.close();
const providerSessionId = closed.provider?.providerSessionId;

if (providerSessionId) {
  const artifacts = await client.sessions.artifacts({
    provider: 'browserstack',
    providerSessionId,
  });
  console.log(artifacts.cloudArtifacts);
}
```

## Artifacts and troubleshooting

After `close`, BrowserStack can return session video, Appium logs, device logs, dashboard URLs, and public URLs. Run `agent-device artifacts --json`, or look up a previous session explicitly:

```bash
agent-device artifacts <webdriver-session-id> --provider browserstack --json
```

BrowserStack errors distinguish rejected credentials, an unavailable device/OS pair, a missing `bs://` upload, and a missing local artifact. If artifact lookup is pending immediately after `close`, retry it. BrowserStack may still be finalizing video and log URLs.

On hosted WebDriver sessions, `fill` checks that the field received focus before it sends keys. If it cannot confirm focus, it fails without typing. Use `snapshot -i` to confirm the target. If the driver cannot expose focus at all, use `press <target>` followed by `type <text>`. That sends text without confirming the destination.
