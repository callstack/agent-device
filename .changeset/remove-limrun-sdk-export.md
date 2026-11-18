---
'agent-device': minor
---

Remove the `agent-device/limrun` SDK subpath and its public runtime and session types as part of #3311. Drive Limrun through the typed client against the daemon that hosts the provider.

Start the daemon with `LIMRUN_API_KEY` or the corresponding `LIM_*_INSTANCE_*` credentials. After the plugin is published, install it on the daemon host with `agent-device plugins add @agent-device/limrun`. Allocate a lease, then install an iOS simulator build of your app before opening it. If your attached instance already has the app installed, skip the install.

```ts
import { createAgentDeviceClient, ensureDaemon } from 'agent-device';

await ensureDaemon();
const scope = {
  session: 'checkout-ios',
  tenant: 'limrun',
  runId: process.env.GITHUB_RUN_ID ?? 'local-run',
  leaseBackend: 'ios-instance',
  leaseProvider: 'limrun',
} as const;
const control = createAgentDeviceClient(scope);
const lease = await control.leases.allocate({ ...scope, platform: 'ios', retainOnClose: true });
try {
  const client = createAgentDeviceClient({
    ...scope,
    leaseId: lease.leaseId,
    sessionIsolation: 'tenant',
  });
  await client.apps.install({
    app: 'com.example.app',
    appPath: './build/Build/Products/Debug-iphonesimulator/Example.app',
    platform: 'ios',
  });
  await client.apps.open({ app: 'com.example.app', platform: 'ios' });
} finally {
  await control.leases.release({ ...scope, leaseId: lease.leaseId });
}
```
