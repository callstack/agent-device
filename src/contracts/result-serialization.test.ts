import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  serializeInstallFromSourceResult,
  serializeOpenResult,
  serializeSnapshotResult,
  serializeSessionListEntry,
} from './result-serialization.ts';

test('serializeSessionListEntry preserves legacy android session payload shape', () => {
  const data = serializeSessionListEntry({
    name: 'qa',
    createdAt: 123,
    device: {
      platform: 'android',
      target: 'mobile',
      id: 'emulator-5554',
      name: 'Pixel 9',
      identifiers: {
        session: 'qa',
        deviceId: 'emulator-5554',
        deviceName: 'Pixel 9',
        serial: 'emulator-5554',
      },
      android: {
        serial: 'emulator-5554',
      },
    },
    identifiers: {
      session: 'qa',
      deviceId: 'emulator-5554',
      deviceName: 'Pixel 9',
      serial: 'emulator-5554',
    },
  });

  assert.deepEqual(data, {
    name: 'qa',
    platform: 'android',
    target: 'mobile',
    device: 'Pixel 9',
    id: 'emulator-5554',
    createdAt: 123,
  });
});

test('serializeOpenResult includes android serial for open payloads', () => {
  const data = serializeOpenResult({
    session: 'qa',
    device: {
      platform: 'android',
      target: 'mobile',
      id: 'emulator-5554',
      name: 'Pixel 9',
      identifiers: {
        session: 'qa',
        deviceId: 'emulator-5554',
        deviceName: 'Pixel 9',
        serial: 'emulator-5554',
      },
      android: {
        serial: 'emulator-5554',
      },
    },
    identifiers: {
      session: 'qa',
      deviceId: 'emulator-5554',
      deviceName: 'Pixel 9',
      serial: 'emulator-5554',
    },
  });

  assert.deepEqual(data, {
    session: 'qa',
    platform: 'android',
    target: 'mobile',
    device: 'Pixel 9',
    id: 'emulator-5554',
    serial: 'emulator-5554',
    message: 'Opened: qa',
  });
});

test('serializeInstallFromSourceResult uses install-family package naming', () => {
  const data = serializeInstallFromSourceResult({
    launchTarget: 'com.example.demo',
    appName: 'Demo',
    appId: 'com.example.demo',
    packageName: 'com.example.demo',
    identifiers: {
      appId: 'com.example.demo',
      package: 'com.example.demo',
    },
  });

  assert.deepEqual(data, {
    launchTarget: 'com.example.demo',
    appName: 'Demo',
    appId: 'com.example.demo',
    package: 'com.example.demo',
    message: 'Installed: Demo',
  });
});

test('serializeSnapshotResult includes Android backend metadata', () => {
  const data = serializeSnapshotResult({
    nodes: [],
    truncated: false,
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
