# @agent-device/revyl

Use [Revyl](https://revyl.com) cloud iOS simulators and Android emulators with
[agent-device](https://agent-device.dev). You need a Revyl API key. Revyl issues keys to its
customers; a partner integration gets one through Revyl's partner program.

```sh
npm install -g agent-device
agent-device plugins add @agent-device/revyl
export REVYL_API_KEY=your-api-key
agent-device connect revyl --platform ios --device "iPhone 16" --provider-os-version 18.0 --provider-app https://apps.example.com/MyApp-simulator.zip
agent-device open com.example.app
agent-device snapshot -i
agent-device close
agent-device disconnect
```

See the [Revyl guide](https://agent-device.dev/docs/revyl) for setup and supported operations.
To update the plugin, run `agent-device plugins update @agent-device/revyl`.

After you add or update the plugin, close your sessions and run `agent-device daemon stop` before reconnecting.

## Use it from JavaScript

The package default-exports a plugin factory. Pass credentials as options, or leave them out to read
`REVYL_API_KEY` and the optional `REVYL_API_URL` from the environment:

```js
import revyl from '@agent-device/revyl';

const plugin = revyl({ apiKey: 'your-api-key' });
```

Credentials passed as options are used instead of the environment variables, and the daemon does not
compare them with your shell.
