import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildRuntimeCaptureInput } from '../../daemon/snapshot-runtime-binding.ts';

// #1634 P2: the daemon maps the CLI preference into the request-scoped runtime
// operation. The contract binding test owns the adjacent operation -> interactor
// hop, and the Swift plan gate owns the emitted runner command.
test('snapshot runtime input forwards snapshotPreferredBackend', () => {
  const input = buildRuntimeCaptureInput(
    {
      req: {
        command: 'snapshot',
        positionals: [],
        session: 'snapshot-preferred-backend',
        token: 'test-token',
        flags: { snapshotPreferredBackend: 'private-ax' },
      },
      logPath: '/tmp/snapshot-preferred-backend.log',
    },
    undefined,
    undefined,
  );
  assert.equal(input.options?.preferredBackend, 'private-ax');
});

test('snapshot runtime input without a pin leaves preferredBackend absent', () => {
  const input = buildRuntimeCaptureInput(
    {
      req: {
        command: 'snapshot',
        positionals: [],
        session: 'snapshot-default-backend',
        token: 'test-token',
      },
      logPath: '/tmp/snapshot-default-backend.log',
    },
    undefined,
    undefined,
  );
  assert.equal(input.options?.preferredBackend, undefined);
});
