---
title: BrowserStack
description: Drive BrowserStack App Automate sessions with agent-device.
---

# BrowserStack

Use BrowserStack App Automate to run agent-device on hosted Android and iOS devices over WebDriver. You need a BrowserStack account with App Automate access.

## Set credentials and connect

Export your BrowserStack credentials, for example from CI secrets:

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

`--provider-app` accepts a BrowserStack app reference such as `bs://...`, an HTTP(S) app URL, or an existing local app path. agent-device uploads a local path when it creates the hosted session.

`connect` verifies the BrowserStack credentials and the exact device/OS pair. It checks a `bs://` reference against recent uploads, and confirms that a local app file exists before saving its absolute path. A public URL is saved as-is; BrowserStack validates it when the session starts. `open` takes the app's installed package or bundle identifier, not its upload name.

A running daemon keeps the BrowserStack credentials it started with. If your shell holds different ones, the first command that allocates a lease, such as `open`, refuses before it creates a session. Run `agent-device daemon stop` (with the same `--state-dir`) and rerun the command. A shell that sets neither variable uses the daemon's credentials.

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
--provider-appium-version 3.2.0                              # (alias --appium-version)
--provider-language Fr                                       # (alias --language)
--provider-locale Fr                                         # (alias --locale)
--provider-network-profile 4g-lte-advanced-good              # (alias --network-profile)
--provider-custom-network 1000                               # (alias --custom-network)
--provider-no-resign-app                                     # iOS only
```

agent-device sends these values to BrowserStack as `bstack:options` capabilities when it creates the hosted session.

- The orientation applies when the session starts. An activity without a fixed orientation, such as a Chrome Custom Tab hosting OAuth, can still open in landscape. Run `agent-device orientation portrait` after it opens if you need portrait.
- `--provider-appium-version` pins the Appium server BrowserStack runs for the session. Without it, BrowserStack runs its default Appium 1.x, and `mobile:` commands such as `deepLink` and `pressButton` need Appium 2.x or newer.
- `--provider-network-profile` and `--provider-custom-network` are mutually exclusive.
- `--provider-no-resign-app` applies to iOS only. BrowserStack re-signs uploaded iOS apps with its provisioning profile, which strips entitlements. Pass this flag when you test features that need entitlements, such as push notifications.

## Run a session from the CLI

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

To use BrowserStack only through MCP, run `connect` in the same effective state directory before you start `agent-device mcp`. MCP exposes device commands such as `open`, `snapshot`, `close`, and `artifacts`, but not provider `connect` commands.

## Use the Node.js client

Configure the client directly when your Node.js process manages the BrowserStack credentials and selectors instead of a saved CLI connection profile:

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

## Get artifacts and troubleshoot

After `close`, BrowserStack can return session video, Appium logs, device logs, dashboard URLs, and public URLs. Run `agent-device artifacts --json`, or look up an earlier session by its ID:

```bash
agent-device artifacts <webdriver-session-id> --provider browserstack --json
```

BrowserStack errors distinguish rejected credentials, an unavailable device/OS pair, a missing `bs://` upload, and a missing local app file. If artifacts are still pending right after `close`, retry the lookup; BrowserStack may still be finalizing video and log URLs.

On hosted WebDriver sessions, `fill` checks that the field received focus before it sends keys. If it cannot confirm focus, it fails without typing. Use `snapshot -i` to confirm the target. If the driver cannot report focus at all, use `press <target>` followed by `type <text>`, which sends text without confirming where it lands.
