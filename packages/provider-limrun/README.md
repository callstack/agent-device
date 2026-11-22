# Limrun for agent-device

Install the plugin on the daemon host.

```sh
agent-device plugins add @agent-device/limrun@nightly-0.22
```

Run `agent-device help remote` to see the install command for your CLI.

Set `LIMRUN_API_KEY`, or the `LIM_*_INSTANCE_*` variables of an existing instance, then connect with `agent-device connect limrun --platform android` or `--platform ios`. See the [Limrun guide](https://agent-device.dev/docs/limrun).
