# @agent-device/testmu

Use TestMu AI Android and iOS virtual and real devices with [agent-device](https://agent-device.dev).
You need a TestMu AI account and its API credentials.

```sh
npm install -g agent-device
agent-device plugins add @agent-device/testmu
export LT_USERNAME=your-username
export LT_ACCESS_KEY=your-access-key
agent-device connect testmu --platform ios --device "iPhone 16" --provider-os-version 18.0 --provider-app ./MyApp.zip
```

See the [TestMu AI guide](https://oss.callstack.com/agent-device/docs/testmu) for setup and supported operations.
To update the plugin, run `agent-device plugins update @agent-device/testmu`.

After you add or update the plugin, close your sessions and run `agent-device daemon stop` before reconnecting.
