---
'agent-device': minor
---

Remove the `agent-device/limrun` export and its `LimrunRuntime` class, `LimrunRuntimeOptions`, and session types. Part of #3759 section 4 and #3311; `@agent-device/limrun` will ship as a plugin.

Removing the subpath means `import { LimrunRuntime } from 'agent-device/limrun'` no longer resolves. Keep the `LIMRUN_API_KEY` or `LIM_*_INSTANCE_*` environment variables and drive the session through the typed client against a daemon that hosts the provider. After the plugin is published, install it on that host with `agent-device plugins add @agent-device/limrun`:

```ts
import { createAgentDeviceClient, ensureDaemon } from 'agent-device';

await ensureDaemon();
const client = createAgentDeviceClient({
  session: 'checkout-ios',
  tenant: 'limrun',
  runId: process.env.GITHUB_RUN_ID ?? 'local-run',
  leaseBackend: 'ios-instance',
  leaseProvider: 'limrun',
});
await client.apps.open({ app: 'com.example.app', platform: 'ios' });
```
