---
title: AI SDK
---

# AI SDK

Use `agent-device/ai-sdk` to give an [AI SDK](https://ai-sdk.dev/) agent a typed set of tools for navigating and inspecting an app. The tools run in-process, share one named session, and by default cover the core loop of reading the screen and acting on it.

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

Set `AI_MODEL` to a model available through your configured AI SDK provider. The agent decides which device tools to call to complete the prompt. The returned `client` targets the same session; close it in `finally` so the device is released even if generation fails.

## Choose tools and approvals

`set: 'core'` is the default. It exposes the perceive-and-act loop: open, close, snapshot, click, press, fill, type, get, is, find, wait, back, scroll, swipe, alert, and screenshot.

- Pass `set: 'all'` when the agent also needs device-management or observability commands.
- Pass `approval: { close: 'user-approval' }` to require user approval before a command runs. `createAgentDeviceTools()` returns the map as `toolApproval`, ready to pass to [`ToolLoopAgent`](https://ai-sdk.dev/docs/agents/tool-approvals).

Use the [Node.js API](/docs/client-api) when your application needs deterministic setup or other direct device control outside the agent loop. See the AI SDK reference for [`ToolLoopAgent`](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent).
