import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

// The presented-surface fact (#3565) reaches Node.js callers as one optional field on the snapshot
// result, and this owns the client half of that wire. Silence and a refusal are different answers:
// a payload with no key came from a producer that never classified (every non-iOS backend, any older
// runner), while a key this vocabulary cannot name came from a producer that tried and is now stating
// `unknown` out loud — because a reader that armed a dismissal confirmation on `undefined` is the
// guessing this fact exists to retire.

function clientAnswering(data: Record<string, unknown>) {
  const setup = createTransport(async () => ({ ok: true, data: { nodes: [], ...data } }));
  return createAgentDeviceClient(setup.config, { transport: setup.transport });
}

test('client capture.snapshot preserves the presented-surface state the producer published (#3565)', async () => {
  for (const presentedSurface of ['presented', 'absent', 'unknown'] as const) {
    const client = clientAnswering({ truncated: false, presentedSurface });

    assert.equal(
      (await client.capture.snapshot()).presentedSurface,
      presentedSurface,
      `state ${presentedSurface}`,
    );
  }
});

test('client capture.snapshot reports no presented surface for a capture that carried none (#3565)', async () => {
  const client = clientAnswering({ truncated: false });

  assert.equal('presentedSurface' in (await client.capture.snapshot()), false);
});

test('client capture.snapshot restates a state it cannot name as unknown, never as absent (#3565)', async () => {
  for (const presentedSurface of ['none', 'PRESENTED', 0, true, [], {}, null]) {
    const client = clientAnswering({ truncated: false, presentedSurface });
    const result = await client.capture.snapshot();

    assert.equal(result.presentedSurface, 'unknown', `payload ${JSON.stringify(presentedSurface)}`);
  }
});
