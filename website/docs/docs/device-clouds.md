---
title: Device Clouds & Farms
description: Choose a hosted device provider for agent and CI workflows.
---

# Device Clouds & Farms

Use a device cloud or farm when an agent needs to automate a hosted mobile device without interactive login. Pick the provider that owns the devices and credentials you use:

- [BrowserStack](/docs/browserstack): Android and iOS App Automate sessions over WebDriver.
- [AWS Device Farm](/docs/aws-device-farm): Android and iOS remote-access sessions through AWS.
- [Limrun](/docs/limrun): direct iOS simulator and Android emulator instances.

All three integrations run through the local `agent-device` daemon. `connect` checks the credentials and configuration, then saves non-secret connection state. It does not allocate a device. BrowserStack and AWS Device Farm allocate a hosted session on `open`. Limrun allocates an instance on the first device command, such as `install` or `open`.

For each provider, the standard lifecycle is:

1. Put provider credentials in CI secrets or another non-interactive credential source.
2. Run `agent-device connect <provider>` with the provider selectors.
3. Follow the printed next command to install or open the app.
4. Run normal device commands, then `agent-device close` and `agent-device disconnect`.

Each provider guide covers its connection selectors, client configuration, MCP setup, artifacts, and troubleshooting. Generated remote profiles are safe to store as non-secret configuration. They may include app IDs, ARNs, device names, OS versions, and labels, but never provider API keys or AWS secret keys.
