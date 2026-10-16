import { test } from 'vitest';
import assert from 'node:assert/strict';
import type {
  AgentDeviceDaemonTransport,
  AgentDeviceDaemonTransportContext,
  DaemonLifecycle,
} from '@agent-device/contracts/client';
import { createAgentDeviceClient } from '../agent-device-client.ts';

// `daemonLifecycle` is a client choice that only the transport can act on, so the client's job is to
// hand it over exactly and to refuse a value it does not know.

function recordingTransport() {
  const contexts: Array<AgentDeviceDaemonTransportContext | undefined> = [];
  const transport: AgentDeviceDaemonTransport = async (_request, context) => {
    contexts.push(context);
    return { ok: true, data: { devices: [] } };
  };
  return { contexts, transport };
}

test('the configured daemon lifecycle reaches the transport', async () => {
  const { contexts, transport } = recordingTransport();
  const attached = createAgentDeviceClient({ daemonLifecycle: 'attach' }, { transport });
  const plain = createAgentDeviceClient({}, { transport });

  const managed = createAgentDeviceClient({ daemonLifecycle: 'managed' }, { transport });

  await attached.devices.list();
  await managed.devices.list();
  await plain.devices.list();

  assert.deepEqual(
    contexts.map((context) => context?.daemonLifecycle),
    ['attach', 'managed', undefined],
  );
});

test('an unknown daemon lifecycle is refused instead of becoming managed', () => {
  const { transport } = recordingTransport();
  const mistyped = 'Attach' as DaemonLifecycle;

  assert.throws(
    () => createAgentDeviceClient({ daemonLifecycle: mistyped }, { transport }),
    (error: { code?: string }) => error.code === 'INVALID_ARGS',
  );
});
