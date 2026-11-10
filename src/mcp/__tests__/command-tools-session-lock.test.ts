import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { AgentDeviceClientConfig } from '@agent-device/contracts/client';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import { listMcpExposedCommandNames } from '@agent-device/command-registry/registry';
import { createCommandToolExecutor } from '../command-tools.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

// The session lock is one policy across the CLI, MCP, and the AI SDK. MCP and the AI SDK read it
// from the operator's environment of the serving process, as the CLI does.
async function clientConfigFor(input: Record<string, unknown>): Promise<AgentDeviceClientConfig> {
  const configs: AgentDeviceClientConfig[] = [];
  const executor = createCommandToolExecutor({
    createClient: (config) => {
      configs.push(config);
      return {} as AgentDeviceClient;
    },
    runCommand: async () => ({ ok: true }),
  });
  const result = await executor.execute('snapshot', input);
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
  assert.equal(configs.length, 1);
  return configs[0]!;
}

test('AGENT_DEVICE_SESSION_LOCK sets the lock policy of every tool call', async () => {
  vi.stubEnv('AGENT_DEVICE_SESSION', 'qa');
  vi.stubEnv('AGENT_DEVICE_SESSION_LOCK', 'strip');
  const policies = new Map<string, unknown>();
  let current = '';
  const executor = createCommandToolExecutor({
    createClient: (config) => {
      policies.set(current, config.lockPolicy);
      return {} as AgentDeviceClient;
    },
    runCommand: async () => ({ ok: true }),
  });

  // Every tool, including ones such as `test` and `devices` that declare few flags of their own.
  for (const name of listMcpExposedCommandNames()) {
    current = name;
    await executor.execute(name, {});
  }

  assert.equal(policies.size, listMcpExposedCommandNames().length);
  for (const [name, policy] of policies) assert.equal(policy, 'strip', name);
});

test('AGENT_DEVICE_SESSION turns on the reject lock bound to AGENT_DEVICE_PLATFORM', async () => {
  vi.stubEnv('AGENT_DEVICE_SESSION', 'qa');
  vi.stubEnv('AGENT_DEVICE_PLATFORM', 'android');

  const config = await clientConfigFor({ platform: 'ios' });

  assert.equal(config.lockPolicy, 'reject');
  assert.equal(config.lockPlatform, 'android');
});

test('a session named in tool input does not turn on the lock', async () => {
  vi.stubEnv('AGENT_DEVICE_SESSION', '');
  vi.stubEnv('AGENT_DEVICE_SESSION_LOCK', '');

  const config = await clientConfigFor({ session: 'model-session', platform: 'ios' });

  assert.equal(config.lockPolicy, undefined);
  assert.equal(config.lockPlatform, undefined);
});
