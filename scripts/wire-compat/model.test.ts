/**
 * The acceptance criterion #1432 states in one sentence — "a wire-type change
 * without an RPC version bump fails" — proved from fixtures.
 *
 * It cannot be proved end-to-end yet: no released tag carries a wire ledger
 * until this lands and ships, so `run.ts` has nothing to diff against. These
 * cases pin the rule now, and `run.ts` becomes a thin git reader over them.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { WireLedger } from '../../test/wire-compat/ledger.ts';
import { compareWireLedgers } from './model.ts';

const RESPONSE = 'packages/kernel/src/contracts.ts#DaemonResponse';
const META = 'packages/kernel/src/contracts.ts#DaemonRequestMeta';

function ledger(overrides: Partial<WireLedger> = {}): WireLedger {
  return {
    protocolVersion: 2,
    declarations: { [RESPONSE]: 'sha256:aaa', [META]: 'sha256:bbb' },
    compatibleChanges: [],
    ...overrides,
  };
}

function compare(current: WireLedger, digests: Record<string, string>) {
  return compareWireLedgers({
    baselineTag: 'v0.20.6',
    released: ledger(),
    current,
    digests: new Map(Object.entries(digests)),
  });
}

test('an unchanged wire surface passes', () => {
  const result = compare(ledger(), { [RESPONSE]: 'sha256:aaa', [META]: 'sha256:bbb' });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.changed, []);
});

test('a changed wire declaration without a bump or ack fails, naming the symbol', () => {
  const current = ledger({ declarations: { [RESPONSE]: 'sha256:zzz', [META]: 'sha256:bbb' } });
  const result = compare(current, { [RESPONSE]: 'sha256:zzz', [META]: 'sha256:bbb' });
  assert.deepEqual(result.changed, [RESPONSE]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /DaemonResponse/);
  assert.match(result.failures[0]!, /without bumping DAEMON_RPC_PROTOCOL_VERSION \(still 2\)/);
});

test('the same change passes once the protocol version is bumped', () => {
  const current = ledger({
    protocolVersion: 3,
    declarations: { [RESPONSE]: 'sha256:zzz', [META]: 'sha256:bbb' },
  });
  const result = compare(current, { [RESPONSE]: 'sha256:zzz', [META]: 'sha256:bbb' });
  assert.equal(result.bumped, true);
  assert.deepEqual(result.failures, []);
});

test('the same change passes with a compatible-change ack at the new digest', () => {
  const current = ledger({
    declarations: { [RESPONSE]: 'sha256:zzz', [META]: 'sha256:bbb' },
    compatibleChanges: [
      { declaration: RESPONSE, digest: 'sha256:zzz', rationale: 'Added an optional field.' },
    ],
  });
  const result = compare(current, { [RESPONSE]: 'sha256:zzz', [META]: 'sha256:bbb' });
  assert.deepEqual(result.failures, []);
});

// The ack is keyed by the digest it covers precisely so it expires. Without
// this, one "added an optional field" ack would launder every later change to
// the same declaration.
test('an ack pinned to a superseded digest does not cover the next change', () => {
  const current = ledger({
    declarations: { [RESPONSE]: 'sha256:yyy', [META]: 'sha256:bbb' },
    compatibleChanges: [
      { declaration: RESPONSE, digest: 'sha256:zzz', rationale: 'Covered the previous change.' },
    ],
  });
  const result = compare(current, { [RESPONSE]: 'sha256:yyy', [META]: 'sha256:bbb' });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /DaemonResponse/);
});

test('an ack with an empty rationale does not count as an ack', () => {
  const current = ledger({
    declarations: { [RESPONSE]: 'sha256:zzz', [META]: 'sha256:bbb' },
    compatibleChanges: [{ declaration: RESPONSE, digest: 'sha256:zzz', rationale: '   ' }],
  });
  const result = compare(current, { [RESPONSE]: 'sha256:zzz', [META]: 'sha256:bbb' });
  assert.equal(result.failures.length, 1);
});

test('a removed wire declaration fails even when acked, because only a bump covers it', () => {
  const current = ledger({
    declarations: { [META]: 'sha256:bbb' },
    compatibleChanges: [
      { declaration: RESPONSE, digest: 'sha256:aaa', rationale: 'Nobody used it.' },
    ],
  });
  const result = compare(current, { [META]: 'sha256:bbb' });
  assert.deepEqual(result.removed, [RESPONSE]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /an ack cannot cover it/);
});

test('a removed wire declaration passes with a bump', () => {
  const current = ledger({ protocolVersion: 3, declarations: { [META]: 'sha256:bbb' } });
  const result = compare(current, { [META]: 'sha256:bbb' });
  assert.deepEqual(result.failures, []);
});

// #2318 moved the daemon HTTP wire contract from src/daemon to
// packages/contracts. A declaration that left its path but was re-declared
// unchanged is a file move, not a removal: a released peer still parses it,
// so it must not force a protocol bump.
test('a declaration moved to a new file unchanged is a move, not a removal', () => {
  const movedFrom = 'src/daemon/http-contract.ts#buildDaemonHttpUrl';
  const movedTo = 'packages/contracts/src/daemon-http.ts#buildDaemonHttpUrl';
  const released = ledger({
    declarations: { [movedFrom]: 'sha256:ddd', [META]: 'sha256:bbb' },
  });
  const current = ledger({ declarations: { [movedTo]: 'sha256:ddd', [META]: 'sha256:bbb' } });
  const result = compareWireLedgers({
    baselineTag: 'v0.20.6',
    released,
    current,
    digests: new Map(Object.entries({ [movedTo]: 'sha256:ddd', [META]: 'sha256:bbb' })),
  });
  assert.deepEqual(result.moved, [movedFrom]);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.failures, []);
});

// A baseline key that leaves and a same-named key that arrives with a moved
// digest are textually indistinguishable, so the gate reads the pair as a
// CHANGE at the destination (ackable at the new digest) rather than the
// bump-only removal the key-pair alone would suggest.
test('a move that changes the shape is a change, acked at the path it moved to', () => {
  const movedFrom = 'src/daemon/http-health.ts#buildDaemonHealthPayload';
  const movedTo = 'packages/contracts/src/daemon-http.ts#buildDaemonHealthPayload';
  const released = ledger({ declarations: { [movedFrom]: 'sha256:old' } });
  const current = ledger({
    declarations: { [movedTo]: 'sha256:new' },
    compatibleChanges: [
      {
        declaration: movedTo,
        digest: 'sha256:new',
        rationale: 'The added parameter is caller-local; the wire payload is unchanged.',
      },
    ],
  });
  const digests = new Map(Object.entries({ [movedTo]: 'sha256:new' }));
  const withoutAck = compareWireLedgers({
    baselineTag: 'v0.20.6',
    released,
    current: ledger({ declarations: { [movedTo]: 'sha256:new' } }),
    digests,
  });
  assert.deepEqual(withoutAck.changed, [movedTo]);
  assert.deepEqual(withoutAck.removed, []);
  assert.equal(withoutAck.failures.length, 1);
  const withAck = compareWireLedgers({ baselineTag: 'v0.20.6', released, current, digests });
  assert.deepEqual(withAck.failures, []);
});

// Names are not unique across files: while a baseline declaration still owns
// the name at its own path, a same-named declaration elsewhere cannot be
// identified as a move of this one, so the baseline key stays a removal.
test('a name still owned by the baseline is not a move, so it remains a removal', () => {
  const serverSendJson = 'src/daemon/server/http-server.ts#sendJson';
  const uploadSendJson = 'src/daemon/upload-http.ts#sendJson';
  const released = ledger({
    declarations: { [serverSendJson]: 'sha256:old', [uploadSendJson]: 'sha256:eee' },
  });
  const current = ledger({ declarations: { [uploadSendJson]: 'sha256:eee' } });
  const result = compareWireLedgers({
    baselineTag: 'v0.20.6',
    released,
    current,
    digests: new Map(Object.entries({ [uploadSendJson]: 'sha256:eee' })),
  });
  assert.deepEqual(result.removed, [serverSendJson]);
  assert.deepEqual(result.moved, []);
  assert.equal(result.failures.length, 1);
});

// One destination cannot be two declarations' move. When two same-name
// baseline declarations leave their paths and one same-name path arrives, one
// of them is a real removal, and a removal is bump-only.
test('two same-name removals cannot share one move destination, so both stay removals', () => {
  const first = 'src/a.ts#sendJson';
  const second = 'src/b.ts#sendJson';
  const destination = 'src/c.ts#sendJson';
  const released = ledger({ declarations: { [first]: 'sha256:ddd', [second]: 'sha256:ddd' } });
  const current = ledger({ declarations: { [destination]: 'sha256:ddd' } });
  const result = compareWireLedgers({
    baselineTag: 'v0.20.6',
    released,
    current,
    digests: new Map(Object.entries({ [destination]: 'sha256:ddd' })),
  });
  assert.deepEqual(result.removed, [first, second]);
  assert.deepEqual(result.moved, []);
  // The destination is a key the baseline never had, so it is still reported
  // as added alongside the removal that fails the gate.
  assert.deepEqual(result.added, [destination]);
  assert.equal(result.failures.length, 1);
});

// The contested-destination rule holds even when the arriving digest matches
// one of the sources and an ack sits at the destination: the other source's
// removal still cannot be covered.
test('a contested destination fails even when acked at the destination', () => {
  const first = 'src/a.ts#sendJson';
  const second = 'src/b.ts#sendJson';
  const destination = 'src/c.ts#sendJson';
  const released = ledger({ declarations: { [first]: 'sha256:aaa', [second]: 'sha256:old' } });
  const current = ledger({
    declarations: { [destination]: 'sha256:new' },
    compatibleChanges: [
      { declaration: destination, digest: 'sha256:new', rationale: 'One of them moved here.' },
    ],
  });
  const result = compareWireLedgers({
    baselineTag: 'v0.20.6',
    released,
    current,
    digests: new Map(Object.entries({ [destination]: 'sha256:new' })),
  });
  assert.deepEqual(result.removed, [first, second]);
  assert.deepEqual(result.moved, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /an ack cannot cover it/);
});

test('a newly added wire declaration is additive and needs nothing', () => {
  const added = 'packages/kernel/src/contracts.ts#NewEnvelope';
  const current = ledger({
    declarations: { [RESPONSE]: 'sha256:aaa', [META]: 'sha256:bbb', [added]: 'sha256:ccc' },
  });
  const result = compare(current, {
    [RESPONSE]: 'sha256:aaa',
    [META]: 'sha256:bbb',
    [added]: 'sha256:ccc',
  });
  assert.deepEqual(result.added, [added]);
  assert.deepEqual(result.failures, []);
});
