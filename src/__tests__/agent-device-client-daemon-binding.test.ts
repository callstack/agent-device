import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  AgentDeviceDaemonTransport,
  AgentDeviceDaemonTransportContext,
  DaemonBinding,
} from '@agent-device/contracts/client';
import { AppError } from '@agent-device/kernel/errors';
import { createAgentDeviceClient } from '../agent-device-client.ts';

// A pin on one daemon instance is a credential and an identity, so the client's job is to read it once
// and hand it to every request of that client, and to refuse one that names no instance.

function recordingTransport() {
  const contexts: Array<AgentDeviceDaemonTransportContext | undefined> = [];
  const transport: AgentDeviceDaemonTransport = async (_request, context) => {
    contexts.push(context);
    return { ok: true, data: { devices: [] } };
  };
  return { contexts, transport };
}

const PIN: DaemonBinding = {
  token: 'daemon-token',
  pid: 4242,
  processStartTime: 'Sun Oct 18 09:00:00 2026',
};

test('a pinned client sends the pin with every request', async () => {
  const { contexts, transport } = recordingTransport();
  const client = createAgentDeviceClient({ daemonBinding: PIN }, { transport });

  await client.devices.list();
  await client.devices.list();

  assert.deepEqual(
    contexts.map((context) => context?.daemonBinding),
    [PIN, PIN],
  );
});

test('a client that names no pin sends none', async () => {
  const { contexts, transport } = recordingTransport();
  const client = createAgentDeviceClient({}, { transport });

  await client.devices.list();

  assert.equal(contexts[0]?.daemonBinding, undefined);
});

test('a pin that does not name one instance is refused where the config is read', () => {
  const { transport } = recordingTransport();

  for (const malformed of [
    // A pid alone cannot tell a process lifetime from the process that recycled its number.
    { token: 't', pid: 1 },
    { pid: 1, processStartTime: 'Sun Oct 18 09:00:00 2026' },
    { token: 't', processStartTime: 'Sun Oct 18 09:00:00 2026' },
    { token: '', pid: 1, processStartTime: 'Sun Oct 18 09:00:00 2026' },
    { token: 't', pid: 1, processStartTime: '   ' },
    { token: 't', pid: 1.5, processStartTime: 'Sun Oct 18 09:00:00 2026' },
    { token: 't', pid: 0, processStartTime: 'Sun Oct 18 09:00:00 2026' },
    'daemon-token',
    4242,
  ]) {
    assert.throws(
      () => createAgentDeviceClient({ daemonBinding: malformed as DaemonBinding }, { transport }),
      (error: { code?: string; details?: unknown }) => {
        assert.equal(error.code, 'INVALID_ARGS');
        return true;
      },
      JSON.stringify(malformed),
    );
  }
});

test('a refused pin names the field that failed and never its credential', () => {
  const { transport } = recordingTransport();
  const secret = 'a-token-nobody-must-see';

  let refusal: AppError | undefined;
  try {
    // A partial pin: the credential itself is valid, so this is the shape that could leak it.
    createAgentDeviceClient(
      { daemonBinding: { token: secret, pid: 4242 } as DaemonBinding },
      { transport },
    );
    assert.fail('expected the config to be refused');
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    refusal = error;
  }

  assert.equal(refusal.details?.daemonBindingField, 'processStartTime');
  assert.doesNotMatch(JSON.stringify(refusal.details ?? {}), new RegExp(secret));
});
