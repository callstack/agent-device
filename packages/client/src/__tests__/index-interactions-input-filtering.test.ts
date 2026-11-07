import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../index.ts';
import { createClientTransport } from '@agent-device/test-kit';

const RETIRED = /readinessTimeoutMs was removed; add an explicit wait for the target/;

test('client commands refuse the retired readinessTimeoutMs before sending anything', async () => {
  const setup = createClientTransport(async () => ({ ok: true, data: {} }));
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

test('postGestureStabilization reaches the daemon as the caller set it, and an omitted option sends nothing', async () => {
  const setup = createClientTransport(async () => ({ ok: true, data: {} }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });
  const swipe = { from: { x: 1, y: 1 }, to: { x: 1, y: 9 } };

  await client.interactions.scroll({ direction: 'down', postGestureStabilization: false });
  await client.interactions.swipe({ ...swipe, postGestureStabilization: false });
  await client.interactions.scroll({ direction: 'down' });
  await client.interactions.swipe({ ...swipe, postGestureStabilization: true });

  assert.deepEqual(
    setup.calls.map((call) => [call.command, call.flags?.postGestureStabilization]),
    [
      ['scroll', false],
      ['swipe', false],
      ['scroll', undefined],
      ['swipe', true],
    ],
  );
  for (const call of setup.calls) {
    assert.equal(Object.hasOwn(call.input ?? {}, 'postGestureStabilization'), false);
  }
});

test('tap commands still carry post-action observation flags', async () => {
  const setup = createClientTransport(async () => ({ ok: true, data: {} }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.interactions.press({ selector: 'label=Foo', settle: true });

  assert.equal(setup.calls[0]?.command, 'press');
  assert.equal(setup.calls[0]?.flags?.settle, true);
});
