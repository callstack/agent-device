# @agent-device/saucelabs

Use Sauce Labs Real Device Cloud Android and iOS devices with [agent-device](https://agent-device.dev).
You need a Sauce Labs account with real-device access and its API credentials.

```sh
npm install -g agent-device
agent-device plugins add @agent-device/saucelabs
export SAUCE_USERNAME=your-username
export SAUCE_ACCESS_KEY=your-access-key
export SAUCE_REGION=eu-central-1   # us-west-1 (default), eu-central-1, or us-east-4
agent-device connect saucelabs --session checkout-android --platform android --device "Google Pixel 8" --provider-os-version 14 --provider-app storage:<file-id>
```

See the [Sauce Labs guide](https://agent-device.dev/docs/saucelabs) for setup and supported operations.
To update the plugin, run `agent-device plugins update @agent-device/saucelabs`.

After you add or update the plugin, close your sessions and run `agent-device daemon stop` before reconnecting.

## Use it from JavaScript

The package default-exports a plugin factory. Pass credentials as options, or leave them out to read `SAUCE_USERNAME` and `SAUCE_ACCESS_KEY` from the environment:

```js
import saucelabs from '@agent-device/saucelabs';

const plugin = saucelabs({ credentials: { username: 'your-username', accessKey: 'your-access-key' } });
```

Credentials passed as options are used instead of the environment variables, and the daemon does not compare them with your shell. The data center always comes from `SAUCE_REGION`.
