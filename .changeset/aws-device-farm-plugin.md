---
'agent-device': minor
---

AWS Device Farm moves to the `@agent-device/aws-device-farm` plugin. For a stable release, run `agent-device plugins add @agent-device/aws-device-farm`. For a 0.22 nightly, use the matching install command shown by the CLI. Finish sessions, stop the detached daemon for its matching state directory, and retry. Embedded hosts import the factory, pass it to `startAgentDevice({ plugins: [awsDeviceFarm()] })`, and close and recreate the runtime after changes.
