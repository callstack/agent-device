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

If you change credentials while the daemon runs, see [Change credentials while the daemon runs](/agent-device/pr-preview/pr-3398/docs/device-clouds.md#change-credentials-while-the-daemon-runs).

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

To drive BrowserStack only through MCP, see [Use a provider only through MCP](/agent-device/pr-preview/pr-3398/docs/device-clouds.md#use-a-provider-only-through-mcp).

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

After `close`, BrowserStack can return session video, Appium logs, device logs, dashboard URLs, and public URLs. The provider session ID is the WebDriver session ID. See [Retrieve artifacts after close](/agent-device/pr-preview/pr-3398/docs/device-clouds.md#retrieve-artifacts-after-close).

BrowserStack errors distinguish rejected credentials, an unavailable device/OS pair, a missing `bs://` upload, and a missing local app file.

To enter text, see [Fill text on hosted WebDriver sessions](/agent-device/pr-preview/pr-3398/docs/device-clouds.md#fill-text-on-hosted-webdriver-sessions).
