# @agent-device/revyl

Use [Revyl](https://revyl.com) cloud iOS simulators and Android emulators with
[agent-device](https://agent-device.dev). You need a Revyl API key. Revyl issues keys to its
customers; a partner integration gets one through Revyl's partner program.

```sh
npm install -g agent-device
agent-device plugins add @agent-device/revyl
export REVYL_API_KEY=your-api-key
export AGENT_DEVICE_SESSION=checkout-ios
agent-device connect revyl --platform ios
agent-device install com.example.app ./build/MyApp.app
agent-device open com.example.app
agent-device snapshot -i
agent-device close
agent-device disconnect
```

See the [Revyl guide](https://agent-device.dev/docs/revyl) for setup and supported operations.
To update the plugin, run `agent-device plugins update @agent-device/revyl`.

After you add or update the plugin, close your sessions and run `agent-device daemon stop` before reconnecting.

## Use it from JavaScript

Run this in the same shell as the CLI commands above so the daemon can read
`REVYL_API_KEY` and, for a private backend, the optional `REVYL_API_URL`. The example uses the CLI's default state directory. If you
passed `--state-dir` to the CLI, pass the same `stateDir` to both calls.

```js
import { createAgentDeviceClient, ensureDaemon } from 'agent-device';

await ensureDaemon();
const client = createAgentDeviceClient({ session: 'checkout-ios' });
console.log(await client.sessions.list());
```
