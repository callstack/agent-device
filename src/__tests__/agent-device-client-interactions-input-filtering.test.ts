import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

const RETIRED = /readinessTimeoutMs was removed; add an explicit wait for the target/;

test('client commands refuse the retired readinessTimeoutMs before sending anything', async () => {
  const setup = createTransport(async () => ({ ok: true, data: {} }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const calls = [
    // @ts-expect-error readinessTimeoutMs is not a client option.
    () => client.interactions.press({ selector: 'label=Foo', readinessTimeoutMs: 2_000 }),
    // @ts-expect-error readinessTimeoutMs is not a client option.
    () => client.interactions.click({ selector: 'label=Foo', readinessTimeoutMs: 1_500 }),
    // @ts-expect-error readinessTimeoutMs is not a client option.
    () => client.interactions.longPress({ selector: 'label=Foo', readinessTimeoutMs: 900 }),
    () =>
      client.interactions.fill({
        selector: 'label=Name',
        text: 'x',
        // @ts-expect-error readinessTimeoutMs is not a client option.
        readinessTimeoutMs: 900,
      }),
    () =>
      client.interactions.swipe({
        from: { x: 1, y: 1 },
        to: { x: 2, y: 2 },
        // @ts-expect-error readinessTimeoutMs is not a client option.
        readinessTimeoutMs: 900,
      }),
  ];
  for (const call of calls) {
    await assert.rejects(call(), (error: { code?: string; message: string }) => {
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(error.message, RETIRED);
      return true;
    });
  }
  assert.deepEqual(setup.calls, []);
});

test('tap commands still carry post-action observation flags', async () => {
  const setup = createTransport(async () => ({ ok: true, data: {} }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.interactions.press({ selector: 'label=Foo', settle: true });

  assert.equal(setup.calls[0]?.command, 'press');
  assert.equal(setup.calls[0]?.flags?.settle, true);
});
