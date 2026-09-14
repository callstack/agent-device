import { expect, test } from 'vitest';
import fc from 'fast-check';
import {
  buildUnchangedSnapshotMetadata,
  ensureSnapshotPresentationKey,
} from './snapshot-unchanged.ts';
import type {
  SnapshotNode,
  SnapshotState,
  SnapshotStateProvenance,
} from '@agent-device/kernel/snapshot';
import {
  distinctRectPairArb,
  PROPERTY_RUNS,
} from '@agent-device/selectors/snapshot-geometry-fixtures';

function snapshot(
  label: string,
  overrides: Omit<Partial<SnapshotState>, 'backend' | 'producer'> & SnapshotStateProvenance = {},
  options: Parameters<typeof ensureSnapshotPresentationKey>[1] = {},
): SnapshotState {
  return ensureSnapshotPresentationKey(
    {
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'Button',
          label,
          pid: 1234,
          hittable: true,
        },
      ],
      createdAt: 1_000,
      backend: 'xctest',
      ...overrides,
    },
    options,
  );
}

test('unchanged metadata ignores refs and volatile process ids', () => {
  const previous = snapshot('Create');
  const current = snapshot('Create', {
    nodes: [{ ...previous.nodes[0]!, ref: 'e99', pid: 5678 }],
  });

  expect(buildUnchangedSnapshotMetadata({ previous, current, options: {} })).toMatchObject({
    nodeCount: 1,
  });
});

test('unchanged metadata detects visible label changes', () => {
  expect(
    buildUnchangedSnapshotMetadata({
      previous: snapshot('Create'),
      current: snapshot('Send'),
      options: {},
    }),
  ).toBeUndefined();
});

test.each<Partial<SnapshotNode>>([
  { index: 1 },
  { depth: 1 },
  { parentIndex: 1 },
  { type: 'TextField' },
  { role: 'button' },
  { subrole: 'AXCloseButton' },
  { value: 'Draft' },
  { identifier: 'create' },
  { enabled: false },
  { selected: true },
  { focused: true },
  { hittable: false },
  { bundleId: 'com.example.app' },
  { appName: 'Example' },
  { windowTitle: 'Compose' },
  { surface: 'app' },
  { hiddenContentAbove: true },
  { hiddenContentBelow: true },
  { interactionBlocked: 'covered' },
])('unchanged metadata detects presentation changes: %j', (change) => {
  const previous = snapshot('Create');
  const current = snapshot('Create', { nodes: [{ ...previous.nodes[0]!, ...change }] });

  expect(buildUnchangedSnapshotMetadata({ previous, current, options: {} })).toBeUndefined();
});

test.each<Partial<SnapshotNode>>([
  { editable: true },
  { password: true },
  { hintShowing: true },
  { selectionStart: 2 },
  { selectionEnd: 3 },
  { visibleToUser: true },
  { inheritsLabel: true },
  { inheritsIdentifier: true },
])('unchanged metadata ignores non-presentation fields: %j', (change) => {
  const previous = snapshot('Create');
  const current = snapshot('Create', { nodes: [{ ...previous.nodes[0]!, ...change }] });

  expect(buildUnchangedSnapshotMetadata({ previous, current, options: {} })).toMatchObject({
    nodeCount: 1,
  });
});

test('unchanged metadata detects node count, order and truncation changes', () => {
  const first = snapshot('Create').nodes[0]!;
  const second = { ...first, index: 1, ref: 'e2', label: 'Cancel' };
  const previous = snapshot('Create', { nodes: [first, second], truncated: false });

  for (const current of [
    { ...previous, nodes: [first] },
    { ...previous, nodes: [second, first] },
    { ...previous, truncated: true },
  ]) {
    expect(buildUnchangedSnapshotMetadata({ previous, current, options: {} })).toBeUndefined();
  }
});

test('unchanged metadata compares rectangle values independently of property order', () => {
  fc.assert(
    fc.property(distinctRectPairArb, ({ ancestor, target }) => {
      const previous = snapshot('Create');
      previous.nodes[0]!.rect = ancestor;
      const current = snapshot('Create', {
        nodes: [
          {
            ...previous.nodes[0]!,
            rect: {
              height: ancestor.height,
              width: ancestor.width,
              y: ancestor.y,
              x: ancestor.x,
            },
          },
        ],
      });

      expect(buildUnchangedSnapshotMetadata({ previous, current, options: {} })).toMatchObject({
        nodeCount: 1,
      });

      current.nodes[0]!.rect = target;
      expect(buildUnchangedSnapshotMetadata({ previous, current, options: {} })).toBeUndefined();

      current.nodes[0]!.rect = undefined;
      expect(buildUnchangedSnapshotMetadata({ previous, current, options: {} })).toBeUndefined();
      expect(
        buildUnchangedSnapshotMetadata({ previous: current, current: previous, options: {} }),
      ).toBeUndefined();
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test('unchanged metadata compares action and presentation hint arrays by value', () => {
  const previous = snapshot('Create');
  previous.nodes[0]!.actions = ['Reply', 'Share'];
  previous.nodes[0]!.presentationHints = ['offscreen'];
  const current = snapshot('Create', {
    nodes: [
      {
        ...previous.nodes[0]!,
        actions: ['Reply', 'Share'],
        presentationHints: ['offscreen'],
      },
    ],
  });

  expect(buildUnchangedSnapshotMetadata({ previous, current, options: {} })).toMatchObject({
    nodeCount: 1,
  });

  current.nodes[0]!.actions = ['Share', 'Reply'];
  expect(buildUnchangedSnapshotMetadata({ previous, current, options: {} })).toBeUndefined();

  current.nodes[0]!.actions = ['Reply'];
  expect(buildUnchangedSnapshotMetadata({ previous, current, options: {} })).toBeUndefined();

  current.nodes[0]!.actions = ['Reply', 'Share'];
  current.nodes[0]!.presentationHints = [];
  expect(buildUnchangedSnapshotMetadata({ previous, current, options: {} })).toBeUndefined();

  current.nodes[0]!.presentationHints = undefined;
  expect(buildUnchangedSnapshotMetadata({ previous, current, options: {} })).toBeUndefined();
});

test('unchanged metadata requires comparison-safe snapshots', () => {
  expect(
    buildUnchangedSnapshotMetadata({
      previous: snapshot('Create', { comparisonSafe: false }),
      current: snapshot('Create'),
      options: {},
    }),
  ).toBeUndefined();

  expect(
    buildUnchangedSnapshotMetadata({
      previous: snapshot('Create'),
      current: snapshot('Create', { comparisonSafe: false }),
      options: {},
    }),
  ).toBeUndefined();
});

test('unchanged metadata requires matching presentation key and identity', () => {
  const previous = snapshot('Create', { createdAt: 1_000 });
  const current = snapshot('Create', { createdAt: 3_500 });

  expect(
    buildUnchangedSnapshotMetadata({
      previous,
      current: snapshot('Create', { createdAt: 3_500 }, { scope: 'Composer' }),
      options: { scope: 'Composer' },
    }),
  ).toBeUndefined();

  expect(
    buildUnchangedSnapshotMetadata({
      previous,
      current,
      options: {},
      identity: {
        previousAppBundleId: 'com.example.before',
        currentAppBundleId: 'com.example.after',
      },
    }),
  ).toBeUndefined();

  expect(
    buildUnchangedSnapshotMetadata({
      previous: snapshot(
        'Create',
        { createdAt: 1_000 },
        { interactiveOnly: true, scope: 'Composer' },
      ),
      current: snapshot(
        'Create',
        { createdAt: 3_500 },
        { interactiveOnly: true, scope: 'Composer' },
      ),
      options: { interactiveOnly: true, scope: 'Composer' },
      identity: {
        previousAppBundleId: 'com.example.app',
        currentAppBundleId: 'com.example.app',
      },
    }),
  ).toMatchObject({ ageMs: 2_500, nodeCount: 1, interactiveOnly: true, scope: 'Composer' });
});

test('unchanged metadata trims scope in output metadata', () => {
  expect(
    buildUnchangedSnapshotMetadata({
      previous: snapshot('Create', { createdAt: 1_000 }, { scope: ' Composer ' }),
      current: snapshot('Create', { createdAt: 3_500 }, { scope: ' Composer ' }),
      options: { scope: ' Composer ' },
    }),
  ).toMatchObject({ scope: 'Composer' });
});

test('force-full and raw snapshots do not emit unchanged metadata', () => {
  const previous = snapshot('Create');
  const current = snapshot('Create');

  expect(
    buildUnchangedSnapshotMetadata({ previous, current, options: { forceFull: true } }),
  ).toBeUndefined();
  expect(
    buildUnchangedSnapshotMetadata({ previous, current, options: { raw: true } }),
  ).toBeUndefined();
});
