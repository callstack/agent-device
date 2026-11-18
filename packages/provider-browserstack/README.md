# @agent-device/browserstack

Use BrowserStack App Automate Android and iOS devices with [agent-device](https://agent-device.dev).
You need a BrowserStack account with App Automate access.

Install the plugin on the daemon host, then connect with your BrowserStack credentials.

```sh
agent-device plugins add @agent-device/browserstack@nightly-0.22
export BROWSERSTACK_USERNAME=your-username
export BROWSERSTACK_ACCESS_KEY=your-access-key
agent-device connect browserstack --session checkout-android --platform android --device "Google Pixel 8" --provider-os-version 14.0 --provider-app bs://app-id
```

Run `agent-device help remote` to see the install command for your CLI.

See the [BrowserStack guide](https://agent-device.dev/docs/browserstack) for setup and supported operations.

After you add or update the plugin, close your sessions and run `agent-device daemon stop --state-dir <path>` for your daemon before reconnecting.

## Use it from JavaScript

The package default-exports a plugin factory. Pass credentials as options, or leave them out to read `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY` from the environment:

```js
import { startAgentDevice } from 'agent-device';
import browserstack from '@agent-device/browserstack';

const host = await startAgentDevice({
  stateDir: './.my-app/agent-device-state',
  plugins: [
    browserstack({ credentials: { username: 'your-username', accessKey: 'your-access-key' } }),
  ],
});
try {
  console.log(await host.client.sessions.list());
} finally {
  await host.close();
}
```

Each credential key passed as an option replaces its environment variable. A key left out uses the environment, and only that environment key participates in the credential fingerprint.
