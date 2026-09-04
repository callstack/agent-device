import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';
import {
  assertSnapshotBridgeEnvelope,
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

const wireVocabulary = JSON.parse(
  await readFile(path.join(import.meta.dirname, 'fixtures', 'wire-vocabulary.json'), 'utf8'),
) as {
  protocolVersion: number;
  sourceVersion: string;
  requestKeys: string[];
  responseKeys: string[];
  attributeKeys: string[];
};

test('snapshot bridge frames decode a split frame and reject trailing frames', () => {
  const first = encodeSnapshotBridgeFrame({ requestId: 'one', value: 1 }, limits);
  const second = encodeSnapshotBridgeFrame({ requestId: 'two', value: 2 }, limits);
  const decoder = new SnapshotBridgeFrameDecoder(limits.maxResponseBytes);

  assert.equal(decoder.push(first.subarray(0, 3)), undefined);
  assert.deepEqual(decoder.push(first.subarray(3)), Buffer.from('{"requestId":"one","value":1}'));
  assert.deepEqual(decoder.finish(), Buffer.from('{"requestId":"one","value":1}'));
  assert.throws(() => decoder.push(second), /multiple-frames/);
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

test('wire vocabulary guard keeps TS and Objective-C literals aligned', async () => {
  const native = await Promise.all(
    ['SnapshotBridge.m', 'SnapshotBridgeRuntime.m', 'SnapshotBridgeRuntime.h'].map((fileName) =>
      readFile(
        path.join(import.meta.dirname, '../../../../apple/snapshot-bridge', fileName),
        'utf8',
      ),
    ),
  );
  const nativeSource = native.join('\n');
  assert.equal(wireVocabulary.protocolVersion, SNAPSHOT_SOURCE_PROTOCOL_VERSION);
  assert.equal(wireVocabulary.sourceVersion, SNAPSHOT_SOURCE_VERSION);
  assert.deepEqual(wireVocabulary.requestKeys, SNAPSHOT_SOURCE_WIRE_KEYS);
  assert.deepEqual(wireVocabulary.responseKeys, SNAPSHOT_SOURCE_RESPONSE_KEYS);
  assert.deepEqual(wireVocabulary.attributeKeys, SNAPSHOT_SOURCE_ATTRIBUTE_KEYS);
  assert.match(nativeSource, /kProtocolVersion = 1/);
  assert.match(nativeSource, /kSourceVersion = @"agent-device-simulator-ax-v1\.5\.3"/);
  for (const key of [
    ...wireVocabulary.requestKeys,
    ...wireVocabulary.responseKeys,
    ...wireVocabulary.attributeKeys,
  ]) {
    assert.match(
      nativeSource,
      new RegExp(`@"${key.replaceAll(/[.*+?^${}()|[\\]\\\\]/g, String.raw`\$&`)}"`),
    );
  }
});
