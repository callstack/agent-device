import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  AgentDeviceBackend,
  BackendSnapshotOptions,
  BackendSnapshotResult,
} from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  localCommandPolicy,
  type CommandSessionStore,
} from '../../../runtime.ts';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';

test('runtime snapshot captures nodes and updates the session baseline', async () => {
  let stored: Parameters<CommandSessionStore['set']>[0] | undefined;
  const device = createAgentDevice({
    backend: createSnapshotBackend(() => ({
      snapshot: makeSnapshotState([{ index: 0, depth: 0, type: 'Window', label: 'Home' }], {
        backend: 'xctest',
      }),
      appName: 'Demo',
      appBundleId: 'com.example.demo',
    })),
    artifacts: createLocalArtifactAdapter(),
    sessions: {
      get: () => undefined,
      set: (record) => {
        stored = record;
      },
    },
    policy: localCommandPolicy(),
  });

  const result = await device.capture.snapshot({ session: 'default' });

  assert.equal(result.nodes[0]?.label, 'Home');
  assert.equal(result.truncated, false);
  assert.equal(result.appName, 'Demo');
  assert.equal(result.appBundleId, 'com.example.demo');
  assert.equal(stored?.snapshot?.nodes[0]?.label, 'Home');
});

test('runtime snapshot forwards interactive capture options', async () => {
  let observedOptions: BackendSnapshotOptions | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async (_context, options) => {
        observedOptions = options;
        return {
          snapshot: makeSnapshotState([{ index: 0, depth: 0, type: 'Window', label: 'Home' }], {
            backend: 'xctest',
          }),
        };
      },
    },
    artifacts: createLocalArtifactAdapter(),
    sessions: {
      get: () => undefined,
      set: () => {},
    },
    policy: localCommandPolicy(),
  });

  await device.capture.snapshot({ session: 'default', interactiveOnly: true });

  assert.equal(observedOptions?.interactiveOnly, true);
  assert.deepEqual(observedOptions, {
    depth: undefined,
    interactiveOnly: true,
    raw: undefined,
    scope: undefined,
  });
});

test('runtime diff snapshot initializes and then compares against session baseline', async () => {
  const session = {
    name: 'default',
    snapshot: makeSnapshotState([{ index: 0, depth: 0, type: 'Window', label: 'Before' }]),
  };
  const device = createAgentDevice({
    backend: createSnapshotBackend(() => ({
      snapshot: makeSnapshotState([{ index: 0, depth: 0, type: 'Window', label: 'After' }]),
    })),
    artifacts: createLocalArtifactAdapter(),
    sessions: {
      get: () => session,
      set: (record) => {
        session.snapshot = record.snapshot!;
      },
    },
    policy: localCommandPolicy(),
  });

  const result = await device.capture.diffSnapshot({ session: 'default' });

  assert.equal(result.baselineInitialized, false);
  assert.equal(result.summary.additions, 1);
  assert.equal(result.summary.removals, 1);
  assert.equal(session.snapshot.nodes[0]?.label, 'After');
});

test('runtime diff snapshot initializes baseline when no previous snapshot exists', async () => {
  let stored: Parameters<CommandSessionStore['set']>[0] | undefined;
  const device = createAgentDevice({
    backend: createSnapshotBackend(() => ({
      snapshot: makeSnapshotState([{ index: 0, depth: 0, type: 'Window', label: 'Initial' }]),
    })),
    artifacts: createLocalArtifactAdapter(),
    sessions: {
      get: () => undefined,
      set: (record) => {
        stored = record;
      },
    },
    policy: localCommandPolicy(),
  });

  const result = await device.capture.diffSnapshot({ session: 'default' });

  assert.equal(result.baselineInitialized, true);
  assert.deepEqual(result.summary, { additions: 0, removals: 0, unchanged: 1 });
  assert.deepEqual(result.lines, []);
  assert.equal(stored?.snapshot?.nodes[0]?.label, 'Initial');
});

test('runtime snapshot emits filtered Android guidance from backend analysis', async () => {
  const device = createSnapshotOnlyDevice({
    nodes: [],
    truncated: false,
    backend: 'android',
    analysis: {
      rawNodeCount: 42,
      maxDepth: 6,
    },
  });

  const result = await device.capture.snapshot({
    session: 'default',
    interactiveOnly: true,
    depth: 3,
  });

  assert.deepEqual(result.warnings, [
    'Interactive snapshot is empty after filtering 42 raw Android nodes. Likely causes: the app content is not accessibility-visible yet, a transient route change, or depth/filter options hid the target.',
    'Interactive output is empty at depth 3; retry without -d.',
  ]);
});

test('runtime snapshot warns when Android helper falls back to stock UIAutomator', async () => {
  const device = createSnapshotOnlyDevice({
    nodes: [{ ref: 'e1', index: 0, depth: 0, type: 'Window', label: 'Home' }],
    truncated: false,
    backend: 'android',
    androidSnapshot: {
      backend: 'uiautomator-dump',
      fallbackReason: 'helper artifact missing',
    },
  });

  const result = await device.capture.snapshot({ session: 'default', interactiveOnly: true });

  assert.deepEqual(result.warnings, [
    'Android snapshot helper unavailable; using stock UIAutomator dump, which can time out on busy React Native UIs. Reason: helper artifact missing',
  ]);
});

test('runtime snapshot warns when iOS interactive output is root-only', async () => {
  const device = createSnapshotOnlyDevice({
    nodes: [{ ref: 'e1', index: 0, depth: 0, type: 'Application' }],
    truncated: false,
    backend: 'xctest',
  });

  const result = await device.capture.snapshot({
    session: 'default',
    interactiveOnly: true,
  });

  assert.deepEqual(result.warnings, [
    'iOS interactive snapshot exposed only the application root. XCTest accessibility queries can fail to enumerate some simulator UI trees even when screenshots and direct gestures still work. Use screenshot as visual truth, try a scoped/full snapshot for diagnostics, and prefer direct selectors when known.',
  ]);
});

test('runtime snapshot flags a merged accessibility leaf and surfaces backend warnings', async () => {
  const mergedLabel = Array.from({ length: 30 }, (_, i) => `Row ${i}, Tap`).join(', ');
  const device = createSnapshotOnlyDevice({
    nodes: [
      { ref: 'e1', index: 0, depth: 0, type: 'Application', label: 'App' },
      { ref: 'e2', index: 1, depth: 1, parentIndex: 0, type: 'Other', label: mergedLabel },
      { ref: 'e3', index: 2, depth: 1, parentIndex: 0, type: 'Button', label: 'Ok' },
    ],
    truncated: false,
    backend: 'xctest',
    warnings: [
      'Recovered this snapshot with the fallback accessibility backend after sparse tree.',
    ],
  });

  const result = await device.capture.snapshot({ session: 'default' });

  assert.equal(result.warnings?.length, 2);
  assert.equal(
    result.warnings?.[0],
    'Recovered this snapshot with the fallback accessibility backend after sparse tree.',
  );
  assert.match(String(result.warnings?.[1]), /e2 \[Other\] merges ~60 labels/);
  assert.match(String(result.warnings?.[1]), /marks a container as accessible/);
  assert.match(String(result.warnings?.[1]), /screenshot as visual truth/);
});

test('runtime snapshot does not flag prose text or labeled containers with children', async () => {
  const prose = Array.from({ length: 30 }, (_, i) => `clause ${i}`).join(', ');
  const device = createSnapshotOnlyDevice({
    nodes: [
      { ref: 'e1', index: 0, depth: 0, type: 'Application', label: 'App' },
      // Long comma-joined prose on a text node: content, not a collapsed container.
      { ref: 'e2', index: 1, depth: 1, parentIndex: 0, type: 'StaticText', label: prose },
      // Same label shape on a container WITH children: not a merged leaf.
      { ref: 'e3', index: 2, depth: 1, parentIndex: 0, type: 'Other', label: prose },
      { ref: 'e4', index: 3, depth: 2, parentIndex: 2, type: 'Button', label: 'Ok' },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const result = await device.capture.snapshot({ session: 'default' });

  assert.deepEqual(result.warnings ?? [], []);
});

test('runtime snapshot renders the structured quality verdict and skips legacy detectors', async () => {
  const mergedLabel = Array.from({ length: 30 }, (_, i) => `Row ${i}, Tap`).join(', ');
  const device = createSnapshotOnlyDevice({
    nodes: [
      { ref: 'e1', index: 0, depth: 0, type: 'Application', label: 'App' },
      { ref: 'e2', index: 1, depth: 1, parentIndex: 0, type: 'Other', label: mergedLabel },
    ],
    truncated: true,
    backend: 'xctest',
    quality: {
      state: 'recovered',
      backend: 'queries',
      reason: 'snapshot returned only structural application/window nodes',
      collapsedLeafIndexes: [1],
    },
  });

  const result = await device.capture.snapshot({ session: 'default' });

  assert.equal(result.warnings?.length, 2);
  assert.match(
    String(result.warnings?.[0]),
    /Detected an overly complex or slow accessibility tree/,
  );
  assert.match(String(result.warnings?.[0]), /queries snapshot backend/);
  assert.match(String(result.warnings?.[0]), /It is OK to continue/);
  assert.match(String(result.warnings?.[0]), /snapshotQuality\.reason/);
  assert.match(String(result.warnings?.[1]), /@e2 \[Other\] merges many labels/);
  assert.deepEqual(result.snapshotQuality?.state, 'recovered');
});

test('runtime snapshot does not warn for a normal iOS interactive output', async () => {
  const device = createSnapshotOnlyDevice({
    nodes: [
      { ref: 'e1', index: 0, depth: 0, type: 'Application' },
      { ref: 'e2', index: 1, depth: 1, type: 'Button', label: 'Continue' },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const result = await device.capture.snapshot({
    session: 'default',
    interactiveOnly: true,
  });

  assert.equal(result.warnings, undefined);
});

test('runtime snapshot warns when Android hierarchy looks like a React Native overlay', async () => {
  const device = createSnapshotOnlyDevice({
    nodes: [
      { ref: 'e1', index: 0, depth: 0, type: 'Text', label: 'LogBox' },
      { ref: 'e2', index: 1, depth: 1, type: 'Text', label: 'Warnings' },
      { ref: 'e3', index: 2, depth: 1, type: 'Button', label: 'Dismiss' },
    ],
    truncated: false,
    backend: 'android',
  });

  const result = await device.capture.snapshot({ session: 'default', interactiveOnly: true });

  assertReactNativeOverlayWarning(result.warnings);
});

test('runtime snapshot warns on collapsed Android React Native warning banners', async () => {
  const device = createSnapshotOnlyDevice({
    nodes: [
      {
        ref: 'e1',
        index: 0,
        depth: 0,
        type: 'android.widget.TextView',
        label: 'Warning: Each child in a list should have a unique "key" prop.',
      },
    ],
    truncated: false,
    backend: 'android',
  });

  const result = await device.capture.snapshot({ session: 'default', interactiveOnly: true });

  assertReactNativeOverlayWarning(result.warnings);
});

test('runtime snapshot does not suggest full-screen React Native warning parents', async () => {
  const result = await createSnapshotOnlyDevice({
    nodes: [
      {
        ref: 'e1',
        index: 0,
        depth: 0,
        type: 'XCUIElementTypeOther',
        label: '!, Open debugger to view warnings.',
        rect: { x: 0, y: 0, width: 402, height: 874 },
      },
      {
        ref: 'e2',
        index: 1,
        depth: 1,
        type: 'XCUIElementTypeOther',
        label: '!, Open debugger to view warnings.',
        rect: { x: 10, y: 786, width: 382, height: 68 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  }).capture.snapshot({ session: 'default', interactiveOnly: true });

  assertReactNativeOverlayWarning(result.warnings);
  assert.doesNotMatch(result.warnings?.[0] ?? '', /@e1/);
});

test('runtime snapshot recognizes Android React Native stack overlays with Dismiss and Minimize controls', async () => {
  const result = await createSnapshotOnlyDevice({
    nodes: [
      { ref: 'e1', index: 0, depth: 0, type: 'android.widget.TextView', label: 'useOnyx.ts:80:43' },
      { ref: 'e2', index: 1, depth: 1, type: 'android.widget.Button', label: 'Dismiss' },
      { ref: 'e3', index: 2, depth: 1, type: 'android.widget.TextView', label: 'Minimize' },
    ],
    truncated: false,
    backend: 'android',
  }).capture.snapshot({ session: 'default', interactiveOnly: true });

  assertReactNativeOverlayWarning(result.warnings);
});

test('runtime snapshot recognizes Android RedBox stacks without Minimize', async () => {
  const result = await createSnapshotOnlyDevice({
    nodes: [
      { ref: 'e1', index: 0, depth: 0, type: 'android.widget.TextView', label: 'useOnyx.ts:80:43' },
      { ref: 'e2', index: 1, depth: 1, type: 'android.widget.Button', label: 'Dismiss' },
    ],
    truncated: false,
    backend: 'android',
  }).capture.snapshot({ session: 'default', interactiveOnly: true });

  assertReactNativeOverlayWarning(result.warnings);
});

test('runtime snapshot warns when iOS hierarchy looks like a React Native overlay', async () => {
  const device = createSnapshotOnlyDevice({
    nodes: [
      {
        ref: 'e1',
        index: 0,
        depth: 0,
        type: 'XCUIElementTypeOther',
        label: 'React Native RedBox',
      },
      {
        ref: 'e2',
        index: 1,
        depth: 1,
        type: 'XCUIElementTypeStaticText',
        value: 'Runtime Error',
      },
      {
        ref: 'e3',
        index: 2,
        depth: 1,
        type: 'XCUIElementTypeButton',
        identifier: 'Reload JS',
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const result = await device.capture.snapshot({ session: 'default', interactiveOnly: true });

  assertReactNativeOverlayWarning(result.warnings);
});

test('runtime snapshot targets React Native LogBox close icon instead of warning body', async () => {
  const result = await createSnapshotOnlyDevice({
    nodes: [
      { ref: 'e1', index: 0, depth: 0, type: 'XCUIElementTypeOther', label: 'LogBox' },
      {
        ref: 'e2',
        index: 1,
        depth: 1,
        type: 'XCUIElementTypeStaticText',
        label: 'Warning: Each child in a list should have a unique "key" prop.',
      },
      { ref: 'e3', index: 2, depth: 1, type: 'XCUIElementTypeButton', label: '×' },
    ],
    truncated: false,
    backend: 'xctest',
  }).capture.snapshot({ session: 'default', interactiveOnly: true });

  assertReactNativeOverlayWarning(result.warnings);
});

test('runtime snapshot does not warn for ordinary Android validation errors', async () => {
  const device = createSnapshotOnlyDevice({
    nodes: [
      { ref: 'e1', index: 0, depth: 0, type: 'Text', label: 'Validation errors' },
      { ref: 'e2', index: 1, depth: 1, type: 'Text', label: 'Required' },
      { ref: 'e3', index: 2, depth: 1, type: 'Button', label: 'Submit order' },
    ],
    truncated: false,
    backend: 'android',
  });

  const result = await device.capture.snapshot({ session: 'default', interactiveOnly: true });

  assert.equal(result.warnings, undefined);
});

test('runtime snapshot stale-drop warning uses the runtime clock', async () => {
  const session = {
    name: 'default',
    snapshot: makeSnapshotState(
      Array.from({ length: 20 }, (_, index) => ({
        index,
        depth: 0,
        type: 'Text',
        label: `Before ${index}`,
      })),
      { backend: 'android' },
    ),
  };
  session.snapshot.createdAt = 1_000;
  const device = createAgentDevice({
    backend: createSnapshotBackend(() => ({
      nodes: [{ ref: 'e1', index: 0, depth: 0, type: 'Text', label: 'After' }],
      truncated: false,
      backend: 'android',
    })),
    artifacts: createLocalArtifactAdapter(),
    sessions: {
      get: () => session,
      set: (record) => {
        session.snapshot = record.snapshot!;
      },
    },
    policy: localCommandPolicy(),
    clock: {
      now: () => 1_500,
      sleep: async () => {},
    },
  });

  const result = await device.capture.snapshot({ session: 'default' });

  assert.deepEqual(result.warnings, [
    'Recent snapshots dropped sharply in node count, which suggests stale or mid-transition UI. Use screenshot as visual truth, wait briefly, then re-snapshot once.',
  ]);
});

test('runtime snapshot stale-drop warning uses backend snapshot timestamps when supplied', async () => {
  const session = {
    name: 'default',
    snapshot: makeSnapshotState(
      Array.from({ length: 20 }, (_, index) => ({
        index,
        depth: 0,
        type: 'Text',
        label: `Before ${index}`,
      })),
      { backend: 'android' },
    ),
  };
  session.snapshot.createdAt = 10_000;
  const currentSnapshot = makeSnapshotState(
    [{ index: 0, depth: 0, type: 'Text', label: 'After' }],
    {
      backend: 'android',
    },
  );
  currentSnapshot.createdAt = 11_500;
  const device = createAgentDevice({
    backend: createSnapshotBackend(() => ({
      snapshot: currentSnapshot,
    })),
    artifacts: createLocalArtifactAdapter(),
    sessions: {
      get: () => session,
      set: (record) => {
        session.snapshot = record.snapshot!;
      },
    },
    policy: localCommandPolicy(),
    clock: {
      now: () => 1_000_000,
      sleep: async () => {},
    },
  });

  const result = await device.capture.snapshot({ session: 'default' });

  assert.deepEqual(result.warnings, [
    'Recent snapshots dropped sharply in node count, which suggests stale or mid-transition UI. Use screenshot as visual truth, wait briefly, then re-snapshot once.',
  ]);
});

test('runtime snapshot stale-drop warning falls back to runtime clock on backend clock skew', async () => {
  const session = {
    name: 'default',
    snapshot: makeSnapshotState(
      Array.from({ length: 20 }, (_, index) => ({
        index,
        depth: 0,
        type: 'Text',
        label: `Before ${index}`,
      })),
      { backend: 'android' },
    ),
  };
  session.snapshot.createdAt = 10_000;
  const currentSnapshot = makeSnapshotState(
    [{ index: 0, depth: 0, type: 'Text', label: 'After' }],
    {
      backend: 'android',
    },
  );
  currentSnapshot.createdAt = 8_500;
  const device = createAgentDevice({
    backend: createSnapshotBackend(() => ({
      snapshot: currentSnapshot,
    })),
    artifacts: createLocalArtifactAdapter(),
    sessions: {
      get: () => session,
      set: (record) => {
        session.snapshot = record.snapshot!;
      },
    },
    policy: localCommandPolicy(),
    clock: {
      now: () => 11_500,
      sleep: async () => {},
    },
  });

  const result = await device.capture.snapshot({ session: 'default' });

  assert.deepEqual(result.warnings, [
    'Recent snapshots dropped sharply in node count, which suggests stale or mid-transition UI. Use screenshot as visual truth, wait briefly, then re-snapshot once.',
  ]);
});

function createSnapshotBackend(
  captureSnapshot: (
    options: BackendSnapshotOptions | undefined,
  ) => BackendSnapshotResult | Promise<BackendSnapshotResult>,
): AgentDeviceBackend {
  return {
    platform: 'ios',
    captureSnapshot: async (_context, options) => await captureSnapshot(options),
  };
}

function createSnapshotOnlyDevice(result: BackendSnapshotResult) {
  return createAgentDevice({
    backend: createSnapshotBackend(() => result),
    artifacts: createLocalArtifactAdapter(),
    sessions: {
      get: () => undefined,
      set: () => {},
    },
    policy: localCommandPolicy(),
  });
}

function assertReactNativeOverlayWarning(warnings: string[] | undefined) {
  assert.equal(warnings?.length, 1);
  assert.match(warnings[0] ?? '', /Hint: React Native warning\/error overlay detected/);
  assert.match(warnings[0] ?? '', /agent-device react-native dismiss-overlay/);
  assert.match(warnings[0] ?? '', /verifies the overlay is gone/);
}
