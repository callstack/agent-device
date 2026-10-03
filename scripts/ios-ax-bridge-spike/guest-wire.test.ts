import assert from 'node:assert/strict';
import { test } from 'vitest';
import { DEFAULT_SPIKE_LIMITS } from './limits.ts';
import {
  acquisitionFromEnvelope,
  elementTypeName,
  encodeGuestFrame,
  failureFromEnvelope,
  flattenGuestTree,
  GuestFrameDecoder,
  guestDescribeRequest,
  isTargetNotReady,
  parseExpectedPid,
} from './guest-wire.ts';
import type { SpikeRequest } from './types.ts';

function request(overrides: Partial<SpikeRequest> = {}): SpikeRequest {
  return {
    version: 1,
    id: 'one',
    candidate: 'guest-simulator-framework-bridge',
    simulatorUdid: '00000000-0000-0000-0000-000000000000',
    state: 'warm',
    screen: 'list',
    limits: DEFAULT_SPIKE_LIMITS,
    ...overrides,
  };
}

const tree = {
  XC_kAXXCAttributeElementType: 'UIApplication',
  XC_kAXXCAttributeElementBaseType: 'UIApplication',
  XC_kAXXCAttributeAutomationType: 1,
  XC_kAXXCAttributeLabel: 'Agent Device Tester',
  XC_kAXXCAttributeFrame: { X: 0, Y: 0, Width: 402, Height: 874 },
  XC_kAXXCAttributeChildren: [
    {
      XC_kAXXCAttributeElementType: 'UIWindow',
      XC_kAXXCAttributeElementBaseType: 'UIWindow',
      XC_kAXXCAttributeAutomationType: 2,
      XC_kAXXCAttributeFrame: { X: 0, Y: 0, Width: 402, Height: 874 },
      XC_kAXXCAttributeChildren: [
        {
          XC_kAXXCAttributeElementType: '_UITabButton',
          XC_kAXXCAttributeElementBaseType: 'UIControl',
          XC_kAXXCAttributeAutomationType: 9,
          XC_kAXXCAttributeLabel: 'Catalog',
          XC_kAXXCAttributeIdentifier: 'tab-catalog',
          XC_kAXXCAttributeValue: 1,
          XC_kAXXCAttributeFrame: { X: 10, Y: 800, Width: 60, Height: 50 },
          XC_kAXXCAttributeChildren: [],
        },
      ],
    },
  ],
};

test('frames round-trip through the 4-byte big-endian length prefix, even when split', () => {
  const frame = encodeGuestFrame({ verb: 'describe', pid: 7 });
  const decoder = new GuestFrameDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, 3)), []);
  const frames = decoder.push(Buffer.concat([frame.subarray(3), frame]));
  assert.equal(frames.length, 2);
  assert.deepEqual(JSON.parse(frames[1]!.toString('utf8')), {
    verb: 'describe',
    pid: 7,
  });
  assert.throws(() => new GuestFrameDecoder(8).push(encodeGuestFrame({ padding: 'x'.repeat(32) })));
});

test('a known generation reads by pid and an unknown one resolves the frontmost app in-guest', () => {
  assert.equal(parseExpectedPid('pid:4242'), 4242);
  assert.equal(parseExpectedPid('gen-1'), undefined);
  const byPid = guestDescribeRequest(
    request({ expectedTargetGeneration: 'pid:4242' }),
    DEFAULT_SPIKE_LIMITS,
  );
  assert.equal(byPid.pid, 4242);
  assert.equal(byPid.snapshotTree, true);
  assert.equal(byPid.automationMode, true);
  assert.equal(byPid.maxDepth, DEFAULT_SPIKE_LIMITS.maxTraversalDepth);
  const frontmost = guestDescribeRequest(request(), DEFAULT_SPIKE_LIMITS);
  assert.equal(frontmost.pid, undefined);
  assert.equal(frontmost.method, 'runningboard');
});

test('nested XC_kAXXC trees flatten to parent-linked raw nodes with XCTest type names', () => {
  const nodes = flattenGuestTree([tree]);
  assert.deepEqual(
    nodes.map((node) => [node.id, node.parentId, node.type, node.role]),
    [
      ['n0', undefined, 'Application', 'UIApplication'],
      ['n1', 'n0', 'Window', 'UIWindow'],
      ['n2', 'n1', 'Button', '_UITabButton'],
    ],
  );
  assert.equal(nodes[2]?.subrole, 'UIControl');
  assert.equal(nodes[2]?.value, '1');
  assert.deepEqual(nodes[2]?.frame, { x: 10, y: 800, width: 60, height: 50 });
  assert.equal(elementTypeName(undefined, 48), 'StaticText');
  assert.equal(elementTypeName(undefined, 0), 'Other');
  assert.equal(elementTypeName(undefined, 999), 'Other');
});

test('a successful envelope becomes an acquisition with generation, viewport, and typed truncation', () => {
  const parsed = acquisitionFromEnvelope(
    { ok: true, tree: [tree], pid: 4242, truncated: true },
    request(),
    DEFAULT_SPIKE_LIMITS,
  );
  assert.ok('acquisition' in parsed);
  if (!('acquisition' in parsed)) return;
  assert.equal(parsed.acquisition.targetGeneration, 'pid:4242');
  assert.deepEqual(parsed.acquisition.viewport, {
    kind: 'reported',
    rect: { x: 0, y: 0, width: 402, height: 874 },
  });
  assert.equal(parsed.acquisition.truncated, true);
  assert.deepEqual(parsed.acquisition.residue, [
    {
      kind: 'truncated',
      dimension: 'depth',
      limit: DEFAULT_SPIKE_LIMITS.maxTraversalDepth,
    },
  ]);
});

test('an observed pid that differs from the expected generation is a typed stale generation', () => {
  const parsed = acquisitionFromEnvelope(
    { ok: true, tree: [tree], pid: 4243 },
    request({ expectedTargetGeneration: 'pid:4242' }),
    DEFAULT_SPIKE_LIMITS,
  );
  assert.deepEqual(parsed, {
    kind: 'stale-generation',
    code: 'target-generation-mismatch',
    expectedTargetGeneration: 'pid:4242',
    observedTargetGeneration: 'pid:4243',
  });
});

test('guest errors map to typed failures without reading free text as truth', () => {
  const notReady = {
    ok: false,
    error_kind: 'application_not_responding',
    error: 'Error kAXErrorServerNotFound getting snapshot',
  };
  assert.equal(isTargetNotReady(notReady), true);
  assert.deepEqual(
    failureFromEnvelope(notReady, request({ expectedTargetGeneration: 'pid:1' }), () => true),
    {
      kind: 'transport-failure',
      code: 'target-application-unavailable',
    },
  );
  assert.deepEqual(
    failureFromEnvelope(
      {
        ok: false,
        error_kind: 'application_unavailable',
        error: 'pid 1 has no accessibility server',
      },
      request({ expectedTargetGeneration: 'pid:1' }),
      () => false,
    ),
    {
      kind: 'stale-generation',
      code: 'target-generation-mismatch',
      expectedTargetGeneration: 'pid:1',
    },
  );
  assert.deepEqual(
    failureFromEnvelope(
      { ok: false, error_kind: 'application_not_responding', error: 'pid 9 did not answer' },
      request({ expectedTargetGeneration: 'pid:9' }),
      () => false,
    ),
    {
      kind: 'stale-generation',
      code: 'target-generation-mismatch',
      expectedTargetGeneration: 'pid:9',
    },
  );
  assert.deepEqual(
    failureFromEnvelope(
      { ok: false, error_kind: 'application_not_responding', error: 'pid 9 did not answer' },
      request({ expectedTargetGeneration: 'pid:9' }),
      () => true,
    ),
    { kind: 'timeout', code: 'application-not-responding' },
  );
  assert.deepEqual(
    failureFromEnvelope({ ok: false, error_kind: 'reader_unavailable' }, request(), () => true),
    {
      kind: 'unsupported-mechanism',
      code: 'reader-unavailable',
    },
  );
  assert.deepEqual(
    failureFromEnvelope({ ok: false, error_kind: 'bad_request' }, request(), () => true),
    {
      kind: 'transport-failure',
      code: 'bad-request',
    },
  );
});
