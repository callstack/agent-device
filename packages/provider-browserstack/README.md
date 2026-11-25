# @agent-device/browserstack

Use BrowserStack App Automate Android and iOS devices with [agent-device](https://agent-device.dev).
You need a BrowserStack account with App Automate access.

Install the plugin on the daemon host, then connect with your BrowserStack credentials.

```sh
agent-device plugins add @agent-device/browserstack
export BROWSERSTACK_USERNAME=your-username
export BROWSERSTACK_ACCESS_KEY=your-access-key
agent-device connect browserstack --session checkout-android --platform android --device "Google Pixel 8" --provider-os-version 14.0 --provider-app bs://app-id
```

Run `agent-device help remote` to see the install command for your CLI.

See the [BrowserStack guide](https://agent-device.dev/docs/browserstack) for setup and supported operations.

After you add or update the plugin, close your sessions and run `agent-device daemon stop --state-dir <path>` for your daemon before reconnecting.

## Use it from JavaScript

Install and connect the plugin with the commands above. Start the local daemon
before creating the client. Use the same state directory and session as your
CLI connection, and make `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY` available to the daemon.

```js
import { createAgentDeviceClient, ensureDaemon } from 'agent-device';

await ensureDaemon();
const client = createAgentDeviceClient({ session: 'checkout-android' });
console.log(await client.sessions.list());
```
