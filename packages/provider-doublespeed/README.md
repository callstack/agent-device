# @agent-device/doublespeed

Use Doublespeed iOS simulators with [agent-device](https://agent-device.dev).
You need a Doublespeed account and its API credentials.

```sh
npm install -g agent-device
agent-device plugins add @agent-device/doublespeed
export DOUBLESPEED_API_KEY=your-api-key
agent-device connect doublespeed --platform ios
```

See the [Doublespeed guide](https://agent-device.dev/docs/doublespeed) for setup and supported operations.
To update the plugin, run `agent-device plugins update @agent-device/doublespeed`.

After adding or updating a plugin, close your sessions and run `agent-device daemon stop` before reconnecting.
