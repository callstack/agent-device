import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { DaemonRequest, DaemonResponse } from '@agent-device/kernel/contracts';
import { createAgentDeviceClient, type AgentDeviceClientConfig } from '../agent-device-client.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

test('client capture.snapshot forwards an internal tree backend preference', async () => {
  const calls: Array<Omit<DaemonRequest, 'token'>> = [];
  const config: AgentDeviceClientConfig = {
    stateDir: mkdtempForTestSync('agent-device-client-snapshot-'),
  };
  const transport = async (req: Omit<DaemonRequest, 'token'>): Promise<DaemonResponse> => {
    calls.push(req);
    return { ok: true, data: { nodes: [], truncated: false } };
  };
  const client = createAgentDeviceClient(config, { transport });

  await client.capture.snapshot({ preferredBackend: 'tree' });

  assert.equal(calls[0]?.command, 'snapshot');
  assert.equal(calls[0]?.flags?.snapshotPreferredBackend, 'tree');
});
