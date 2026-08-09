---
title: BrowserStack
description: Drive BrowserStack App Automate sessions with agent-device.
---

# BrowserStack

Use BrowserStack App Automate when an agent or CI job needs a hosted Android or iOS WebDriver session.

## Credentials and connection

Provide BrowserStack credentials through a non-interactive environment:

```bash
export BROWSERSTACK_USERNAME=...
export BROWSERSTACK_ACCESS_KEY=...
```

Connect with the target platform, exact device and OS version, and the app to test:

```bash
agent-device connect browserstack \
  --platform android \
  --device "Google Pixel 8" \
  --provider-os-version 14.0 \
  --provider-app bs://app-id
```

`--provider-app` accepts a BrowserStack app reference such as `bs://...`, an HTTP(S) app URL, or an existing local app path. Local paths are uploaded to BrowserStack when the hosted session is allocated.

At connect time, BrowserStack credentials and the exact device/OS pair are verified. A `bs://` reference is checked against recent uploaded apps; a local artifact is checked on disk and persisted as an absolute path; a public URL remains configured but is validated by BrowserStack when the session is created. `open` still requires the app's installed package or bundle identifier, not its upload name.

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

These become BrowserStack vendor capabilities inside `bstack:options` when the hosted session is created.

- The orientation applies when the session starts. An activity that does not pin its own orientation, such as a Chrome Custom Tab hosting OAuth, can still open in landscape. Run `agent-device orientation portrait` after launching that activity when needed.
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

For MCP-only operation, run the `connect` command in the same effective state directory before starting `agent-device mcp`. MCP exposes operational tools such as `open`, `snapshot`, `click`, `close`, and `artifacts`, but not provider `connect` commands.

## Node.js client

Use direct client configuration when the Node process owns the BrowserStack credentials and selectors instead of a persisted CLI connection profile:

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

After `close`, BrowserStack can return session video, Appium logs, device logs, dashboard URLs, and public URLs. Use `agent-device artifacts --json`, or look up a previous session explicitly:

```bash
agent-device artifacts <webdriver-session-id> --provider browserstack --json
```

If connect fails, its error distinguishes rejected credentials, an unavailable device/OS pair, a missing `bs://` upload, and a missing local artifact. If an artifact lookup is pending immediately after `close`, retry it: BrowserStack may finalize video and log URLs asynchronously.

On hosted WebDriver sessions, `fill` waits to witness text-entry focus before typing. If focus cannot be witnessed, it fails without sending keys. Use `snapshot -i` to confirm the target; if the driver cannot expose focus at all, use `press <target>` followed by `type <text>`, accepting that the destination cannot be verified.
