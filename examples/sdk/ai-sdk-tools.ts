/**
 * AI SDK tool set: build a typed tool set from the command registry with
 * `createAgentDeviceTools()`, drive it through a `ToolLoopAgent`, then close
 * the session — no hand-written tool definitions.
 *
 * Demonstrates: `createAgentDeviceTools` from the `agent-device/ai-sdk`
 * subpath.
 *
 * Prerequisites: an `agent-device` daemon target (a booted iOS simulator),
 * `ai` installed, and `AI_MODEL` set to a model available through your
 * configured AI SDK provider. This file typechecks without any of those;
 * running it for real also requires `pnpm build` first, so the package
 * resolves at runtime.
 *
 * Run: node --experimental-strip-types examples/sdk/ai-sdk-tools.ts
 */
import { ToolLoopAgent } from 'ai';
import { createAgentDeviceTools } from 'agent-device/ai-sdk';

async function main(): Promise<void> {
  const { tools, client, toolApproval } = await createAgentDeviceTools({
    session: 'sdk-example-ai-sdk',
    platform: 'ios',
    // Closing the session is the one destructive action in this example's
    // default tool set, so require a human decision before the model can call it.
    approval: { close: 'user-approval' },
  });

  const agent = new ToolLoopAgent({
    model: process.env.AI_MODEL!,
    instructions: [
      'Inspect the current UI before acting.',
      'Verify the requested outcome with another snapshot before reporting success.',
    ].join('\n'),
    tools,
    toolApproval,
  });

  try {
    await client.apps.open({ app: 'com.apple.Preferences', platform: 'ios' });

    const result = await agent.generate({
      prompt: 'Open Notifications settings and report whether notifications are enabled.',
    });

    console.log(result.text);
  } finally {
    await client.sessions.close();
  }
}

await main();
