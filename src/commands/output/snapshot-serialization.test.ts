import { test } from 'vitest';
import assert from 'node:assert/strict';
import { serializeSnapshotResult } from './result-serialization.ts';
import { snapshotViewportSizeFrom } from '@agent-device/kernel/rect';

test('serializeSnapshotResult includes Android backend metadata', () => {
  const data = serializeSnapshotResult({
    nodes: [],
    truncated: false,
    appBundleId: 'com.callstack.agentdevicelab',
    androidSnapshot: {
      backend: 'android-helper',
      helperVersion: '0.13.3',
      installReason: 'current',
      waitForIdleTimeoutMs: 500,
      nodeCount: 12,
    },
    identifiers: {
      session: 'qa',
    },
  });

  assert.deepEqual(data, {
    nodes: [],
    truncated: false,
    appBundleId: 'com.callstack.agentdevicelab',
    androidSnapshot: {
      backend: 'android-helper',
      helperVersion: '0.13.3',
      installReason: 'current',
      waitForIdleTimeoutMs: 500,
      nodeCount: 12,
    },
  });
});

test('serializeSnapshotResult preserves the response-level refsGeneration (ADR 0014)', () => {
  const data = serializeSnapshotResult({
    nodes: [{ ref: 'e1', index: 0, depth: 0, type: 'Button', label: 'Go' }],
    truncated: false,
    refsGeneration: 752890,
    identifiers: { session: 'qa' },
  } as Parameters<typeof serializeSnapshotResult>[0]);

  assert.equal(data.refsGeneration, 752890);
  // The node tree stays plain — the generation rides once at the response level.
  assert.equal((data.nodes as Array<{ ref?: string }>)[0]?.ref, 'e1');
});

test('serializeSnapshotResult maps capture quality annotation to public snapshotQuality', () => {
  const snapshotQuality = {
    state: 'healthy',
    backend: 'tree',
  } as const;
  const data = serializeSnapshotResult({
    nodes: [],
    truncated: false,
    quality: snapshotQuality,
    identifiers: {
      session: 'qa',
    },
  } as Parameters<typeof serializeSnapshotResult>[0] & { quality: typeof snapshotQuality });

  assert.deepEqual(data, {
    nodes: [],
    truncated: false,
    snapshotQuality,
  });
});

test('serializeSnapshotResult includes snapshot diagnostics', () => {
  const snapshotDiagnostics = {
    stats: {
      count: 3,
      p50Ms: 450,
      p95Ms: 1_800,
      maxMs: 1_800,
      slowThresholdMs: 1_500,
      platform: 'android',
    },
    warning: 'Warning: android snapshots are slow in this run: p95 1800ms over 3 captures.',
  } as const;
  const data = serializeSnapshotResult({
    nodes: [],
    truncated: false,
    snapshotDiagnostics,
    identifiers: {
      session: 'qa',
    },
  });

  assert.deepEqual(data, {
    nodes: [],
    truncated: false,
    snapshotDiagnostics,
  });
});

// #3182: the viewport rides the response once, beside the tree. An absent one stays absent rather
// than serializing as an empty box.
test('serializeSnapshotResult publishes the viewport beside the tree (#3182)', () => {
  const data = serializeSnapshotResult({
    nodes: [],
    truncated: false,
    viewport: snapshotViewportSizeFrom({ x: 0, y: 0, width: 390, height: 844 }),
    identifiers: { session: 'qa' },
  });

  assert.deepEqual(data.viewport, { width: 390, height: 844 });
});

test('serializeSnapshotResult omits an absent viewport instead of minting one (#3182)', () => {
  const data = serializeSnapshotResult({
    nodes: [],
    truncated: false,
    identifiers: { session: 'qa' },
  });

  assert.equal('viewport' in data, false);
});
