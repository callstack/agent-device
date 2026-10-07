---
title: Eve
---

# Eve

[Eve](https://eve.dev/) is Vercel's filesystem-first framework for durable agents. Files under `agent/tools/` become typed model tools, so you give the agent device access by wrapping the `agent-device` Node.js client in one of those files.

Create an Eve project, then add `agent-device`:

```bash
npx eve@latest init mobile-agent
cd mobile-agent
pnpm add agent-device
```

Add `agent/tools/agent_device.ts`:

```ts
import { createAgentDeviceClient } from 'agent-device';
import { defineTool } from 'eve/tools';
import { z } from 'zod';

const client = createAgentDeviceClient({
  session: 'eve-agent',
  lockPolicy: 'reject',
});

export default defineTool({
  description: 'Inspect or interact with the current device UI.',
  inputSchema: z.discriminatedUnion('action', [
    z.object({
      action: z.literal('open'),
      app: z.string().min(1),
      platform: z.enum(['ios', 'android']),
    }),
    z.object({
      action: z.literal('snapshot'),
    }),
    z.object({
      action: z.literal('press'),
      ref: z.string().regex(/^@e\d+$/),
    }),
    z.object({
      action: z.literal('close'),
    }),
  ]),
  async execute(input) {
    switch (input.action) {
      case 'open':
        return await client.apps.open({ app: input.app, platform: input.platform });
      case 'snapshot':
        return await client.capture.snapshot({ interactiveOnly: true });
      case 'press':
        return await client.interactions.press({ ref: input.ref });
      case 'close':
        return await client.sessions.close();
    }
  },
});
```

Eve picks up the file automatically; you don't register it anywhere. Tell the agent how to use it in `agent/instructions.md`:

```md
Use the agent_device tool to inspect and operate the app.

- Open the requested app before inspecting it.
- Call snapshot before every interaction.
- Only press an @e ref from the latest snapshot.
- Verify the requested outcome with another snapshot.
- Call close when the device task is complete.
```

In CI or another short-lived host, also close the named `agent-device` session in your runner's own cleanup path. The model-directed `close` call is useful during the normal tool loop, but it does not replace deterministic cleanup after errors or cancellation.

## Choose where the tool runs

Run the tool in Eve's app runtime when it needs local access to simulators, emulators, platform tooling, and daemon state. If Eve is hosted separately from the devices, connect through an [agent-device remote proxy](/docs/remote-proxy) instead.

Eve is in beta; check the [Eve documentation](https://eve.dev/) when you upgrade it. For a production example, read [Building Mobile QA Agents With Vercel Eve](https://www.callstack.com/blog/building-reviewable-mobile-qa-agents-with-vercel-eve), which covers a PR QA agent using an `agent_device` tool and a deterministic CI runner.

See [Node.js API](/docs/client-api) for the complete client surface.
