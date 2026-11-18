# AWS Device Farm for agent-device

On a stable 0.22 release, install the plugin on the daemon host:

```sh
agent-device plugins add @agent-device/aws-device-farm
```

On a 0.22 nightly, use `agent-device plugins add @agent-device/aws-device-farm@nightly-0.22`.
For a pinned nightly, copy the exact install command from the CLI's missing-plugin error.

Configure AWS CLI credentials and connect using your Device Farm project and device ARNs. See the [AWS Device Farm guide](https://agent-device.dev/docs/aws-device-farm).
