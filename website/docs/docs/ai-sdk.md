---
title: AI SDK
---

# AI SDK

[Vercel's AI SDK](https://ai-sdk.dev/) can drive `agent-device` three ways, in increasing order of setup: point `@ai-sdk/mcp` at the MCP server with no hand-written code, build a typed tool set in-process with `agent-device/ai-sdk`, or hand-write individual tools for full control over the surface.

## Zero-code: the MCP server

`agent-device mcp` starts the same [MCP server](/docs/agent-setup#mcp-server) documented for Claude Code, Cursor, and other MCP clients — every installed command, as a structured tool, over the same execution path as the CLI. [`@ai-sdk/mcp`](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)'s `createMCPClient()` connects to it and converts its tools into AI SDK tools directly, so there is no `agent-device` import at all:

```bash
pnpm add ai @ai-sdk/mcp
```

```ts
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { ToolLoopAgent } from 'ai';

const mcpClient = await createMCPClient({
  transport: new Experimental_StdioMCPTransport({
    command: 'npx',
    args: ['agent-device', 'mcp'],
  }),
});

try {
  const agent = new ToolLoopAgent({
    model: process.env.AI_MODEL!,
    tools: await mcpClient.tools(),
  });

  const result = await agent.generate({
    prompt: 'Open com.example.app on iOS, navigate to Notifications, and verify notifications are enabled.',
  });

  console.log(result.text);
} finally {
  await mcpClient.close();
}
```

This hands the model every command `agent-device mcp` exposes — dozens of tools, spanning device management and observability as well as interaction. For a smaller, curated default, use `agent-device/ai-sdk` below instead.

## `agent-device/ai-sdk`: a typed tool set in-process

`createAgentDeviceTools()` builds AI SDK tools from the same command registry the MCP server uses, in-process (no subprocess), pinned to one named session:

```bash
pnpm add agent-device ai
```

```ts
import { ToolLoopAgent } from 'ai';
import { createAgentDeviceTools } from 'agent-device/ai-sdk';

const { tools, client, toolApproval } = await createAgentDeviceTools({
  session: 'ai-sdk-agent',
  platform: 'ios',
  approval: { close: 'user-approval' },
});

const agent = new ToolLoopAgent({
  model: process.env.AI_MODEL!,
  tools,
  toolApproval,
});

try {
  await client.apps.open({ app: 'com.example.app', platform: 'ios' });

  const result = await agent.generate({
    prompt: 'Navigate to Notifications and verify that notifications are enabled.',
  });

  console.log(result.text);
} finally {
  await client.sessions.close();
}
```

`set: 'core'` (the default) exposes the perceive/act loop most agents need — open, close, snapshot, click, press, fill, type, get, is, find, wait, back, scroll, swipe, alert, screenshot; pass `set: 'all'` for every command the MCP server exposes, matching the zero-code path above. `approval` maps command names to an [AI SDK tool approval status](https://ai-sdk.dev/docs/agents/tool-approvals) and is returned as `toolApproval`, ready to pass straight to `ToolLoopAgent`.

## Hand-written tools

Write tools by hand when you want a surface smaller than `core`, or application-specific input validation and result shaping. The example below gives the model two deliberately small tools: one for observing the current UI and one for pressing an element returned by that observation.

```bash
pnpm add agent-device ai zod
```

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

Guidance for hand-written tools:

- Validate tool input with a schema. In particular, constrain element refs to values such as `@e12` and make the model observe before acting.
- Keep the `agent-device` client outside tool execution so calls share one named session.
- Return typed client results directly unless the result needs an application-specific projection.
- Let the host application own session cleanup with `try`/`finally`; do not rely on the model to close the session.
- Use AI SDK's [`toolApproval`](https://ai-sdk.dev/docs/agents/tool-approvals) option for actions that require human confirmation in your product — `tool()`'s own `needsApproval` is deprecated in its favor.

See [Node.js API](/docs/client-api) for the complete client surface and runnable, typechecked `agent-device` examples.
