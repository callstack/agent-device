import assert from 'node:assert/strict';
import { test } from 'vitest';
import { captureVphoneSnapshot } from './snapshot.ts';
import { vphoneSnapshotTreeFixture } from './snapshot.fixtures.ts';
import { createRecordingVphoneTransport, vphoneFixtureResponse } from './transport.fixtures.ts';

test('flat AX mapping preserves dense indexes, values, frames, states, bundle, viewport, and provenance', async () => {
  const fixture = createRecordingVphoneTransport((call) => {
    if (call.kind === 'rpc' && call.method === 'ui.tree') return vphoneSnapshotTreeFixture();
    return vphoneFixtureResponse(call);
  });

  const result = await captureVphoneSnapshot(fixture.transport, 'machine-a', 'device-a');

  assert.equal(result.acquisition.producer, 'vphone-ios-tree');
  assert.deepEqual(result.acquisition.lineage, { targetId: 'device-a' });
  assert.deepEqual(result.acquisition.viewport, {
    kind: 'reported',
    rect: { x: 0, y: 0, width: 390, height: 844 },
  });
  assert.deepEqual(
    result.acquisition.nodes.map((node) => node.index),
    [0, 1, 2],
  );
  assert.deepEqual(
    result.acquisition.nodes.map((node) => node.label),
    ['Example', 'Save', 'Read only'],
  );
  assert.deepEqual(
    result.acquisition.nodes.map((node) => node.bundleId),
    ['com.example.app', 'com.example.app', 'com.example.app'],
  );
  assert.deepEqual(result.acquisition.nodes[1], {
    index: 1,
    type: 'Button',
    role: 'button',
    label: 'Save',
    value: '1',
    identifier: 'save-button',
    rect: { x: 12.5, y: 40.25, width: 100.5, height: 44.75 },
    visibleToUser: false,
    enabled: false,
    bundleId: 'com.example.app',
  });
  assert.equal(Object.hasOwn(result.acquisition.nodes[1]!, 'hittable'), false);
  assert.equal(Object.hasOwn(result.acquisition.nodes[1]!, 'clickable'), false);
  assert.equal(
    result.acquisition.nodes.every((node) => node.parentIndex === undefined),
    true,
  );
  assert.deepEqual(result.acquisition.residue, [
    { kind: 'unavailable-fact', fact: 'hittability' },
    { kind: 'unavailable-fact', fact: 'acquisition-depth' },
    { kind: 'unavailable-fact', fact: 'truncation' },
  ]);
});

test('snapshot requests the unfiltered flat tree between verified foreground reads', async () => {
  const fixture = createRecordingVphoneTransport();
  await captureVphoneSnapshot(fixture.transport, 'machine-a', 'device-a');
  assert.deepEqual(fixture.calls[1], {
    kind: 'rpc',
    machine: 'machine-a',
    method: 'ui.tree',
    params: { max_elements: 2000, nested: false, visible_only: false },
  });
  assert.deepEqual(
    fixture.calls.map((call) => call.kind === 'rpc' && call.method),
    ['apps.foreground', 'ui.tree', 'apps.foreground', 'device.screen'],
  );
});

test('snapshot rejects unverified foreground identity before reading the tree', async () => {
  const fixture = createRecordingVphoneTransport((call) => {
    if (call.kind === 'rpc' && call.method === 'apps.foreground') {
      return { bundle_id: 'com.example.app', verified: false, pid: 123 };
    }
    return vphoneFixtureResponse(call);
  });

  await assert.rejects(captureVphoneSnapshot(fixture.transport, 'machine-a', 'device-a'), {
    details: { reason: 'vphone_foreground_unverified' },
  });
  assert.deepEqual(
    fixture.calls.map((call) => call.kind === 'rpc' && call.method),
    ['apps.foreground'],
  );
});

test.each([
  { bundle_id: 'com.other.app', pid: 123 },
  { bundle_id: 'com.example.app', pid: 456 },
])('snapshot rejects foreground changes during tree capture: %j', async (changed) => {
  let foregroundCalls = 0;
  const fixture = createRecordingVphoneTransport((call) => {
    if (call.kind === 'rpc' && call.method === 'apps.foreground') {
      foregroundCalls += 1;
      return foregroundCalls === 1
        ? { bundle_id: 'com.example.app', verified: true, pid: 123 }
        : { ...changed, verified: true };
    }
    return vphoneFixtureResponse(call);
  });

  await assert.rejects(
    captureVphoneSnapshot(fixture.transport, 'machine-a', 'device-a'),
    (error: unknown) => {
      const details = (
        error as {
          details?: {
            reason?: string;
            before?: { bundleId: string; pid: number };
            after?: { bundleId: string; pid: number };
          };
        }
      ).details;
      assert.equal(details?.reason, 'vphone_foreground_changed');
      assert.deepEqual(details?.before, { bundleId: 'com.example.app', pid: 123 });
      assert.deepEqual(details?.after, { bundleId: changed.bundle_id, pid: changed.pid });
      return true;
    },
  );
  assert.deepEqual(
    fixture.calls.map((call) => call.kind === 'rpc' && call.method),
    ['apps.foreground', 'ui.tree', 'apps.foreground'],
  );
});

test('snapshot accepts tree nodes whose PIDs all match the verified foreground PID', async () => {
  const fixture = createRecordingVphoneTransport((call) => {
    if (call.kind === 'rpc' && call.method === 'ui.tree') {
      return {
        elements: [
          { label: 'One', pid: 123 },
          { label: 'Two', pid: 123 },
        ],
      };
    }
    return vphoneFixtureResponse(call);
  });

  const result = await captureVphoneSnapshot(fixture.transport, 'machine-a', 'device-a');

  assert.deepEqual(
    result.acquisition.nodes.map((node) => node.pid),
    [123, 123],
  );
  assert.deepEqual(
    result.acquisition.nodes.map((node) => node.bundleId),
    ['com.example.app', 'com.example.app'],
  );
});

test.each([
  { reason: 'vphone_tree_pid_mismatch', elements: [{ label: 'Other', pid: 456 }] },
  {
    reason: 'vphone_tree_pid_unverified',
    elements: [{ label: 'Proven', pid: 123 }, { label: 'Unproven' }],
  },
])(
  'snapshot rejects incomplete or conflicting tree PID evidence: $reason',
  async ({ reason, elements }) => {
    const fixture = createRecordingVphoneTransport((call) => {
      if (call.kind === 'rpc' && call.method === 'ui.tree') return { elements };
      return vphoneFixtureResponse(call);
    });

    await assert.rejects(
      captureVphoneSnapshot(fixture.transport, 'machine-a', 'device-a'),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === reason,
    );
    assert.equal(
      fixture.calls.some((call) => call.kind === 'rpc' && call.method === 'device.screen'),
      false,
    );
  },
);
