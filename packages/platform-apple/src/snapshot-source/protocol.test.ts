import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';
import {
  assertSnapshotBridgeEnvelope,
  assertSnapshotBridgeTargetIdentity,
  bridgeFailureFromEnvelope,
  createSnapshotBridgeDescribeRequest,
  encodeSnapshotBridgeFrame,
  parseSnapshotBridgeEnvelope,
  SNAPSHOT_SOURCE_PROTOCOL_VERSION,
  SNAPSHOT_SOURCE_ATTRIBUTE_KEYS,
  SNAPSHOT_SOURCE_RESPONSE_KEYS,
  SNAPSHOT_SOURCE_VERSION,
  SNAPSHOT_SOURCE_WIRE_KEYS,
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

const nativeWireGolden = JSON.parse(
  await readFile(path.join(import.meta.dirname, 'fixtures', 'native-wire-golden.json'), 'utf8'),
);

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
    generation: 'generation-1',
    maxDepth: 4,
    maxNodes: 10,
    maxDurationMs: 900,
    maxResponseBytes: 4096,
  });
  assert.deepEqual(request, {
    verb: 'describe',
    requestId: 'request-1',
    pid: 123,
    generation: 'generation-1',
    snapshotTree: true,
    automationMode: true,
    maxDepth: 4,
    maxNodes: 10,
    maxDurationMs: 900,
    maxResponseBytes: 4096,
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
    ['response_limit_exceeded', 'transport-failure'],
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

test('native wire golden keeps TS and Objective-C protocol vocabularies in parity', async () => {
  const native = await Promise.all(
    ['SnapshotBridge.m', 'SnapshotBridgeRuntime.m'].map((fileName) =>
      readFile(
        path.join(import.meta.dirname, '../../../../apple/snapshot-bridge', fileName),
        'utf8',
      ),
    ),
  );
  const nativeSource = native.join('\n');
  assert.match(nativeSource, /kProtocolVersion = 1/);
  assert.match(nativeSource, /kSourceVersion = @"agent-device-simulator-ax-v1\.5\.3"/);
  assert.match(nativeSource, /snapshot-tree-malformed/);
  assert.match(nativeSource, /if \(\*malformed\) return nil/);
  for (const key of [
    ...SNAPSHOT_SOURCE_WIRE_KEYS,
    ...SNAPSHOT_SOURCE_RESPONSE_KEYS,
    ...SNAPSHOT_SOURCE_ATTRIBUTE_KEYS,
  ]) {
    assert.match(
      nativeSource,
      new RegExp(`@"${key.replaceAll(/[.*+?^${}()|[\\]\\\\]/g, String.raw`\$&`)}"`),
    );
  }

  const request = createSnapshotBridgeDescribeRequest(nativeWireGolden.request);
  assert.deepEqual(request, nativeWireGolden.request);
  const success = parseSnapshotBridgeEnvelope(
    Buffer.from(JSON.stringify(nativeWireGolden.success)),
  );
  assert.doesNotThrow(() => assertSnapshotBridgeEnvelope(success, 'golden-request'));
  assert.doesNotThrow(() =>
    assertSnapshotBridgeTargetIdentity(success, { pid: 321, generation: 'generation-current' }),
  );
  assert.throws(
    () => assertSnapshotBridgeEnvelope(nativeWireGolden.versionMismatch, 'golden-request'),
    /protocol-version-mismatch/,
  );
  assert.throws(
    () =>
      assertSnapshotBridgeTargetIdentity(nativeWireGolden.staleGeneration, {
        pid: 321,
        generation: 'generation-current',
      }),
    /bridge-generation-mismatch/,
  );
  assert.throws(
    () => bridgeFailureFromEnvelope(nativeWireGolden.malformed),
    (error: unknown) =>
      error instanceof Error &&
      'failureKind' in error &&
      (error as { failureKind: string }).failureKind === 'malformed-tree',
  );
});
