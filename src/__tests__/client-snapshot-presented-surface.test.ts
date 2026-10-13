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

// A digest response is the same fact on a different shape, and the client skips its normalizer for
// that shape. Skipping the tree projection cannot make the fact's own vocabulary optional: a caller
// arming the #1831 confirmation on a digest is arming the same thing.
test('a digest capture normalizes the presented-surface fact it carries (#3565)', async () => {
  for (const [presentedSurface, expected] of [
    ['presented', 'presented'],
    ['absent', 'absent'],
    ['none', 'unknown'],
    [0, 'unknown'],
    [null, 'unknown'],
  ] as const) {
    const client = clientAnswering({ nodeCount: 2, refs: [], presentedSurface });
    const result = (await client.capture.snapshot({ responseLevel: 'digest' })) as Record<
      string,
      unknown
    >;

    assert.equal(result.presentedSurface, expected, `payload ${JSON.stringify(presentedSurface)}`);
    assert.equal(result.nodeCount, 2, 'the digest shape itself survives');
  }
});

test('a digest capture with no presented-surface fact stays silent (#3565)', async () => {
  const client = clientAnswering({ nodeCount: 2, refs: [] });
  const result = (await client.capture.snapshot({ responseLevel: 'digest' })) as Record<
    string,
    unknown
  >;

  assert.equal('presentedSurface' in result, false);
});

// Same split at the boundary a caller actually sees, so `presentedSurface` in result keeps meaning
// something: a payload that declared the fact without a value publishes `unknown`, and one that never
// declared it publishes no key at all. Passing the first through untouched would hand back a key whose
// value is `undefined`, which reads as "the platform publishes no reading" to exactly the check that
// the docs tell callers to make.
test('a published key holding no value reaches the caller as unknown (#3565)', async () => {
  const client = clientAnswering({ truncated: false, presentedSurface: undefined });

  assert.equal((await client.capture.snapshot()).presentedSurface, 'unknown');
});

// The reported shape, pinned at the client rather than only at the reader: a digest capture carries no
// fact, and a lookup that walked the prototype chain would promote whatever a co-resident module
// parked there into a trusted `absent` — the one state that tells #1831 no dismissal is owed.
test('a digest capture never reads an inherited presented-surface value (#3565)', async () => {
  Object.defineProperty(Object.prototype, 'presentedSurface', {
    value: 'absent',
    configurable: true,
    writable: true,
  });
  try {
    const client = clientAnswering({ nodeCount: 2, refs: [] });
    for (const responseLevel of ['digest', 'full'] as const) {
      const result = (await client.capture.snapshot({ responseLevel })) as Record<string, unknown>;
      assert.equal(Object.hasOwn(result, 'presentedSurface'), false, `level ${responseLevel}`);
    }
  } finally {
    delete (Object.prototype as unknown as Record<string, unknown>).presentedSurface;
  }
});
