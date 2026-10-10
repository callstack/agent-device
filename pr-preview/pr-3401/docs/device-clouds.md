# Device Clouds

Use a device cloud or farm when an agent needs to drive a hosted mobile device without an interactive login. Pick the provider whose account and devices you use:

- [BrowserStack](/agent-device/pr-preview/pr-3401/docs/browserstack.md): Android and iOS App Automate sessions over WebDriver.
- [AWS Device Farm](/agent-device/pr-preview/pr-3401/docs/aws-device-farm.md): Android and iOS remote-access sessions through AWS.
- [TestMu AI](/agent-device/pr-preview/pr-3401/docs/testmu.md): Android emulator, iOS simulator, and real-device sessions over WebDriver.
- [Limrun](/agent-device/pr-preview/pr-3401/docs/limrun.md): direct iOS simulator and Android emulator instances.

Every provider runs through the local `agent-device` daemon. `connect` checks your credentials and configuration, then saves non-secret connection state; it does not allocate a device. BrowserStack, AWS Device Farm, and TestMu AI allocate a hosted session on `open`. Limrun allocates an instance on the first device command, such as `install` or `open`.

Every provider follows the same steps:

1. Put provider credentials in CI secrets or another non-interactive credential source.
2. Run `agent-device connect <provider>` with the provider selectors.
3. Follow the printed next command to install or open the app.
4. Run normal device commands, then `agent-device close` and `agent-device disconnect`.

Each provider accepts only its own provider flags (`--provider-*` and `--aws-*`). A flag the provider does not use fails with `INVALID_ARGS` naming the flag, whether you pass it to `connect`, `client.leases.allocate()`, or a remote-config profile, so no setting is silently dropped.

The generated remote profiles are safe to store as non-secret configuration. They can include app IDs, ARNs, device names, OS versions, and labels, but never provider API keys, access keys, or AWS secret keys.
