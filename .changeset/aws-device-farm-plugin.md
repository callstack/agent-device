---
'agent-device': minor
---

AWS Device Farm moves to a private, unpublished plugin. After publication, CLI hosts can install it with `agent-device plugins add @agent-device/aws-device-farm`; finish sessions, stop the detached daemon for its matching state directory, and retry. Embedded hosts import the factory, pass it to `startAgentDevice({ plugins: [awsDeviceFarm()] })`, and close and recreate the runtime after changes.
