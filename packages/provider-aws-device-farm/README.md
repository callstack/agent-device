# AWS Device Farm for agent-device

On a stable 0.22 release, install the plugin on the daemon host:

```sh
agent-device plugins add @agent-device/aws-device-farm
```

For a development build of 0.22, install the plugin from the `nightly-0.22` tag:
`agent-device plugins add @agent-device/aws-device-farm@nightly-0.22`.
If you installed the CLI from `nightly` on main or `nightly-0.22` on the 0.22 branch,
run `agent-device help remote` and use the exact AWS Device Farm package version it lists.

Configure AWS CLI credentials and connect using your Device Farm project and device ARNs. See the [AWS Device Farm guide](https://agent-device.dev/docs/aws-device-farm).
