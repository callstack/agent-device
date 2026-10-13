import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

test('tap commands filter undeclared input without losing post-action observation', async () => {
  const setup = createTransport(async () => ({ ok: true, data: {} }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.interactions.press({
    selector: 'label=Foo',
    settle: true,
    // @ts-expect-error readinessTimeoutMs is not a client option.
    readinessTimeoutMs: 2_000,
  });
  await client.interactions.click({
    selector: 'label=Foo',
    settle: true,
    // @ts-expect-error readinessTimeoutMs is not a client option.
    readinessTimeoutMs: 1_500,
  });
  await client.interactions.longPress({
    selector: 'label=Foo',
    settle: true,
    // @ts-expect-error readinessTimeoutMs is not a client option.
    readinessTimeoutMs: 900,
  });

  assert.deepEqual(
    setup.calls.map((call) => call.command),
    ['press', 'click', 'longpress'],
  );
  for (const call of setup.calls) {
    assert.equal(Object.hasOwn(call.flags ?? {}, 'readinessTimeoutMs'), false);
    assert.equal(call.flags?.settle, true);
  }
});
