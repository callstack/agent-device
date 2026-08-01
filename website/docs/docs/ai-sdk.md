---
title: AI SDK
---

# AI SDK

[Vercel's AI SDK](https://ai-sdk.dev/) can expose `agent-device` client methods as typed tools in a Node.js agent. `ToolLoopAgent` owns the model loop, while `createAgentDeviceClient()` owns the device session and keeps tool implementations aligned with the CLI command contracts.

Install the integration dependencies:

```bash
pnpm add agent-device ai zod
```

The example below gives the model two deliberately small tools: one for observing the current UI and one for pressing an element returned by that observation.

```ts
import { ToolLoopAgent, tool } from 'ai';
import { createAgentDeviceClient } from 'agent-device';
import { z } from 'zod';

const client = createAgentDeviceClient({
  session: 'ai-sdk-agent',
  lockPolicy: 'reject',
});

const agent = new ToolLoopAgent({
  model: process.env.AI_MODEL!,
  instructions: [
    'Inspect the current UI before acting.',
    'Only press an element ref returned by the latest snapshot.',
    'Stop and explain when the requested state cannot be verified.',
  ].join('\n'),
  tools: {
    snapshot: tool({
      description: 'Return the interactive elements in the current device UI.',
      inputSchema: z.object({}),
      execute: async () => await client.capture.snapshot({ interactiveOnly: true }),
    }),
    press: tool({
      description: 'Press an element from the latest snapshot by its @e ref.',
      inputSchema: z.object({
        ref: z.string().regex(/^@e\d+$/),
      }),
      execute: async ({ ref }) => await client.interactions.press({ ref }),
    }),
  },
});

try {
  await client.apps.open({
    app: 'com.example.app',
    platform: 'ios',
  });

  const result = await agent.generate({
    prompt: 'Navigate to Notifications and verify that notifications are enabled.',
  });

  console.log(result.text);
} finally {
  await client.sessions.close();
}
```

Set `AI_MODEL` to a model available through your configured AI SDK provider. See the AI SDK references for [`ToolLoopAgent`](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) and [`tool()`](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool).

## Designing device tools

Prefer focused tools over a single tool that accepts an arbitrary command name and arguments:

- Validate tool input with a schema. In particular, constrain element refs to values such as `@e12` and make the model observe before acting.
- Keep the `agent-device` client outside tool execution so calls share one named session.
- Return typed client results directly unless the result needs an application-specific projection.
- Let the host application own session cleanup with `try`/`finally`; do not rely on the model to close the session.
- Use AI SDK's `needsApproval` option for actions that require human confirmation in your product.

See [Node.js API](/docs/client-api) for the complete client surface and runnable, typechecked `agent-device` examples.
