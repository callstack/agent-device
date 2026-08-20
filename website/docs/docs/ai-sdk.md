---
title: AI SDK
---

# AI SDK

Use `agent-device/ai-sdk` to give an [AI SDK](https://ai-sdk.dev/) agent a typed set of tools for navigating and inspecting an app. The tools run in-process, share one named session, and default to the focused perceive-and-act surface most agents need.

```bash
pnpm add agent-device ai
```

Make an iOS simulator or device [available to agent-device](/docs/agent-setup), then configure an AI SDK model. String model IDs use AI Gateway by default:

```dotenv
AI_GATEWAY_API_KEY=your_api_key
AI_MODEL=provider/model
```

Alternatively, pass a model from your configured AI SDK provider. See the AI SDK guide to [choosing a provider](https://ai-sdk.dev/docs/getting-started/choosing-a-provider).

```ts
import { ToolLoopAgent } from 'ai';
import { createAgentDeviceTools } from 'agent-device/ai-sdk';

const { tools, client } = await createAgentDeviceTools({
  session: 'ai-sdk-agent',
  platform: 'ios',
});

const agent = new ToolLoopAgent({
  model: process.env.AI_MODEL!,
  tools,
});

try {
  const result = await agent.generate({
    prompt: [
      'Open Settings on the iOS device.',
      'Navigate to Calendar notifications.',
      'Report whether Allow Notifications is enabled.',
    ].join(' '),
  });

  console.log(result.text);
} finally {
  await client.sessions.close();
}
```

Set `AI_MODEL` to a model available through your configured AI SDK provider. The agent sees the available device tools and chooses the calls needed to complete the prompt. The returned `client` targets the same session; keep cleanup in `finally` so the device is released even if generation fails.

## Options

`set: 'core'` is the default. It exposes the perceive-and-act loop: open, close, snapshot, click, press, fill, type, get, is, find, wait, back, scroll, swipe, alert, and screenshot.

- Pass `set: 'all'` when the agent also needs device-management or observability commands.
- Pass `approval: { close: 'user-approval' }` to require approval for a command. `createAgentDeviceTools()` returns the map as `toolApproval`, ready to pass to [`ToolLoopAgent`](https://ai-sdk.dev/docs/agents/tool-approvals).

See the [Node.js API](/docs/client-api) when the host application needs deterministic setup or other direct device control outside the agent loop. See the AI SDK reference for [`ToolLoopAgent`](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent).
