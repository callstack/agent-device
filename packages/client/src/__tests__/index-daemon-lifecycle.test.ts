import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { AgentDeviceDaemonTransport } from '@agent-device/contracts/client';
import { createAgentDeviceClient } from '../index.ts';

// A client always attaches, so `daemonLifecycle` is no longer a choice the transport acts on. The
// client's job is to accept `'attach'` (the only value, and the default) and to refuse any value that
// would mean managing a daemon, naming the explicit owners instead.

function recordingTransport() {
  const seen: Array<Record<string, unknown>> = [];
  const transport: AgentDeviceDaemonTransport = async (_request, context) => {
    seen.push({ ...(context ?? {}) });
    return { ok: true, data: { devices: [] } };
  };
  return { seen, transport };
}

test('a client sends no daemon-management knob to its transport', async () => {
  const { seen, transport } = recordingTransport();
  const attached = createAgentDeviceClient({ daemonLifecycle: 'attach' }, { transport });
  const plain = createAgentDeviceClient({}, { transport });

  await attached.devices.list();
  await plain.devices.list();

  // `'attach'` is what every request does, so it is not a per-request option either: the transport
  // gets the caller's cancellation and pin, and nothing about who owns the daemon.
  assert.deepEqual(
    seen.map((context) => 'daemonLifecycle' in context),
    [false, false],
  );
});

test('the removed managed lifecycle is refused where the config is read', () => {
  const { transport } = recordingTransport();

  assert.throws(
    () => createAgentDeviceClient({ daemonLifecycle: 'managed' as never }, { transport }),
    (error: { code?: string; details?: { daemonLifecycle?: unknown; hint?: unknown } }) => {
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(error.details?.daemonLifecycle, 'managed');
      assert.match(String(error.details?.hint), /ensureDaemon\(\{ stateDir \}\)/);
      assert.doesNotMatch(String(error.details?.hint), /startAgentDevice/);
      return true;
    },
  );
});

test('an unknown daemon lifecycle is refused instead of attaching blindly', () => {
  const { transport } = recordingTransport();

  assert.throws(
    () => createAgentDeviceClient({ daemonLifecycle: 'Attach' as never }, { transport }),
    (error: { code?: string }) => error.code === 'INVALID_ARGS',
  );
});
