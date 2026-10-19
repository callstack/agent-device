import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

// The box a capture's rects are measured in reaches Node.js callers as one optional field on the
// snapshot result (#3182). These cases own the client half of that wire: the pair survives verbatim,
// and every payload the kernel guard refuses becomes the absence meaning "the producer measured no
// box" — never the zero the broken producer wrote.

function clientAnswering(data: Record<string, unknown>) {
  const setup = createTransport(async () => ({ ok: true, data: { nodes: [], ...data } }));
  return createAgentDeviceClient(setup.config, { transport: setup.transport });
}

test('client capture.snapshot preserves the viewport the producer published (#3182)', async () => {
  const client = clientAnswering({ truncated: false, viewport: { width: 1080, height: 2400 } });

  assert.deepEqual((await client.capture.snapshot()).viewport, { width: 1080, height: 2400 });
});

test('client capture.snapshot reports no viewport field for a capture that carried none (#3182)', async () => {
  const client = clientAnswering({ truncated: false });

  assert.equal('viewport' in (await client.capture.snapshot()), false);
});

test('client capture.snapshot restates an unusable viewport payload as absence (#3182)', async () => {
  for (const viewport of [
    'screen',
    [],
    {},
    { width: 1080 },
    { width: '1080', height: 2400 },
    // A zero is the claim a producer may never make; the client refuses to hand it on as a size.
    { width: 0, height: 2400 },
    { width: 1080, height: 0 },
    { width: Number.NaN, height: 2400 },
    {
      width: Number.MAX_VALUE,
      height: Number.MAX_VALUE,
      x: -Number.MAX_VALUE / 2,
      y: -Number.MAX_VALUE / 2,
    },
    // The published shape carries no origin, so a broken producer's failed-read box usually arrives
    // as bare maximal extents; minting an origin for them must not mint a screen either.
    { width: Number.MAX_VALUE, height: Number.MAX_VALUE },
  ]) {
    const client = clientAnswering({ truncated: false, viewport });
    const result = await client.capture.snapshot();

    assert.equal(result.viewport, undefined, `payload ${JSON.stringify(viewport)}`);
    assert.equal('viewport' in result, false, `payload ${JSON.stringify(viewport)}`);
  }
});
