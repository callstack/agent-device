import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

// The keyboard band a capture's producer measured reaches Node.js callers as one optional field on
// the snapshot result (#2660). These cases own the client half of that wire: what a daemon answer
// becomes on the way out, including the answers the client must name rather than swallow.

const BAND = { x: 0, y: 583, width: 402, height: 291 };

function clientAnswering(data: Record<string, unknown>) {
  const setup = createTransport(async () => ({ ok: true, data: { nodes: [], ...data } }));
  return createAgentDeviceClient(setup.config, { transport: setup.transport });
}

test('client capture.snapshot preserves the keyboard fact the producer measured', async () => {
  const client = clientAnswering({ truncated: false, keyboard: { kind: 'visible', frame: BAND } });

  assert.deepEqual(await (await client.capture.snapshot()).keyboard, {
    kind: 'visible',
    frame: BAND,
  });
});

test('client capture.snapshot preserves an absence and a stated failure as themselves', async () => {
  for (const keyboard of [{ kind: 'absent' }, { kind: 'unmeasurable', reason: 'abc-ngp002' }]) {
    const client = clientAnswering({ truncated: false, keyboard });

    assert.deepEqual((await client.capture.snapshot()).keyboard, keyboard);
  }
});

// `undefined` is reserved for the one answer that means "this producer never looked". Anything else
// that cannot be placed keeps a reason, because dropping it would read as silence downstream.
test('client capture.snapshot names a keyboard fact it cannot place instead of answering nothing', async () => {
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    [{ kind: 'visible' }, 'invalid-visible-frame'],
    [{ kind: 'visible', frame: { x: 0, y: 583, width: 402 } }, 'invalid-visible-frame'],
    [{ kind: 'visible', frame: { ...BAND, height: 0 } }, 'invalid-visible-frame'],
    [{ kind: 'unmeasurable' }, 'unreported-reason'],
    [{ kind: 'present', frame: BAND }, 'unrecognized-kind'],
    ['visible', 'malformed-fact'],
  ];

  for (const [keyboard, reason] of cases) {
    const client = clientAnswering({ truncated: false, keyboard });

    assert.deepEqual(
      (await client.capture.snapshot()).keyboard,
      { kind: 'unmeasurable', reason },
      `payload ${JSON.stringify(keyboard)}`,
    );
  }
});

test('client capture.snapshot reports no keyboard field for a capture that carried none', async () => {
  const client = clientAnswering({ truncated: false });

  const result = await client.capture.snapshot();

  assert.equal('keyboard' in result, false);
});
