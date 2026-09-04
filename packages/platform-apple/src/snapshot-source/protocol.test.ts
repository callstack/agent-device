import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertSnapshotBridgeEnvelope,
  bridgeFailureFromEnvelope,
  createSnapshotBridgeDescribeRequest,
  encodeSnapshotBridgeFrame,
  parseSnapshotBridgeEnvelope,
  SNAPSHOT_SOURCE_PROTOCOL_VERSION,
  SNAPSHOT_SOURCE_VERSION,
  SnapshotBridgeFrameDecoder,
} from './protocol.ts';
import type { SnapshotSourceLimits } from './types.ts';

const limits: SnapshotSourceLimits = {
  maxRequestBytes: 1024,
  maxResponseBytes: 4096,
  maxNodes: 20,
  maxTraversalDepth: 10,
  maxDurationMs: 1000,
};

test('snapshot bridge frames decode across split and coalesced socket chunks', () => {
  const first = encodeSnapshotBridgeFrame({ requestId: 'one', value: 1 }, limits);
  const second = encodeSnapshotBridgeFrame({ requestId: 'two', value: 2 }, limits);
  const decoder = new SnapshotBridgeFrameDecoder(limits.maxResponseBytes);

  assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(3), second])), [
    Buffer.from('{"requestId":"one","value":1}'),
    Buffer.from('{"requestId":"two","value":2}'),
  ]);
});

test('snapshot bridge frames reject bounded request and response violations', () => {
  assert.throws(
    () => encodeSnapshotBridgeFrame({ payload: 'x'.repeat(2000) }, limits),
    (error: unknown) =>
      error instanceof Error &&
      'failureCode' in error &&
      (error as { failureCode: string }).failureCode === 'request-limit-exceeded',
  );

  const decoder = new SnapshotBridgeFrameDecoder(10);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(11, 0);
  assert.throws(() => decoder.push(oversized), /frame-limit-exceeded/);
});

test('snapshot bridge envelopes pin protocol, source, and request identity', () => {
  const request = createSnapshotBridgeDescribeRequest({
    requestId: 'request-1',
    pid: 123,
    maxDepth: 4,
    maxNodes: 10,
  });
  assert.deepEqual(request, {
    verb: 'describe',
    requestId: 'request-1',
    pid: 123,
    snapshotTree: true,
    automationMode: true,
    maxDepth: 4,
    maxNodes: 10,
  });

  const envelope = parseSnapshotBridgeEnvelope(
    Buffer.from(
      JSON.stringify({
        protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
        sourceVersion: SNAPSHOT_SOURCE_VERSION,
        requestId: 'request-1',
      }),
    ),
  );
  assert.doesNotThrow(() => assertSnapshotBridgeEnvelope(envelope, 'request-1'));
  assert.throws(() => assertSnapshotBridgeEnvelope(envelope, 'request-2'), /request-id-mismatch/);
});

test('snapshot bridge failures stay typed at the guest boundary', () => {
  for (const [guestKind, expectedKind] of [
    ['unsupported', 'unsupported'],
    ['malformed_tree', 'malformed-tree'],
    ['application_not_responding', 'timeout'],
    ['application_unavailable', 'transport-failure'],
    ['bad_request', 'malformed-tree'],
  ] as const) {
    assert.throws(
      () =>
        bridgeFailureFromEnvelope({
          error_kind: guestKind,
          error_code: 'fixture-code',
        }),
      (error: unknown) =>
        error instanceof Error &&
        'failureKind' in error &&
        (error as { failureKind: string }).failureKind === expectedKind,
    );
  }
});
