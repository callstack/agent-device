import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

// The readiness budget must reach `req.flags` for press/click/longpress exactly like
// `button`/`durationMs` do. It is never CLI- or model-writable; the SDK client option is its route.
test('readinessTimeoutMs on press/click/longpress reaches the request flags', async () => {
  const setup = createTransport(async () => ({ ok: true, data: {} }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.interactions.press({ selector: 'label=Foo', readinessTimeoutMs: 2_000 });
  await client.interactions.click({ selector: 'label=Foo', readinessTimeoutMs: 1_500 });
  await client.interactions.longPress({ selector: 'label=Foo', readinessTimeoutMs: 900 });

  assert.equal(setup.calls[0]?.flags?.readinessTimeoutMs, 2_000);
  assert.equal(setup.calls[1]?.flags?.readinessTimeoutMs, 1_500);
  assert.equal(setup.calls[2]?.flags?.readinessTimeoutMs, 900);
});

test('a press that waited returns the daemon data.readiness untouched', async () => {
  const readiness = { polls: 2, waitedMs: 180 };
  const setup = createTransport(async () => ({ ok: true, data: { ref: '@e1', readiness } }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const pressed = await client.interactions.press({ selector: 'label=Foo' });
  const clicked = await client.interactions.click({ selector: 'label=Foo' });
  const longPressed = await client.interactions.longPress({ selector: 'label=Foo' });

  for (const result of [pressed, clicked, longPressed]) {
    assert.deepEqual((result as { readiness?: unknown }).readiness, readiness);
  }
});
