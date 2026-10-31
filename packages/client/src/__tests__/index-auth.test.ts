import { test } from 'vitest';
import assert from 'node:assert/strict';
import type {
  AgentDeviceDaemonTransport,
  AgentDeviceDaemonTransportContext,
} from '@agent-device/contracts/client';
import type { DaemonRequest } from '@agent-device/kernel/contracts';
import { createAgentDeviceClient } from '../index.ts';

test('client sends daemon auth only through the typed transport context', async () => {
  const requests: Array<Omit<DaemonRequest, 'token'>> = [];
  const contexts: Array<AgentDeviceDaemonTransportContext | undefined> = [];
  const transport: AgentDeviceDaemonTransport = async (request, context) => {
    requests.push(request);
    contexts.push(context);
    return { ok: true, data: { devices: [] } };
  };
  const client = createAgentDeviceClient(
    {
      cwd: '/tmp/agent-device',
      daemonBaseUrl: 'https://daemon.example.test',
      daemonAuthToken: 'synthetic-client-token',
    },
    { transport },
  );

  await client.devices.list();

  assert.equal(requests.length, 1);
  assert.equal(contexts[0]?.authToken, 'synthetic-client-token');
  assert.equal(Object.hasOwn(requests[0]?.flags ?? {}, 'daemonAuthToken'), false);
  assert.doesNotMatch(JSON.stringify(requests[0]), /synthetic-client-token/);
});
