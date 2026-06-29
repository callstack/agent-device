import { expect, test } from 'vitest';
import {
  buildUnchangedSnapshotMetadata,
  ensureSnapshotPresentationKey,
} from './snapshot-unchanged.ts';
import type { SnapshotState } from '../../../kernel/snapshot.ts';

function snapshot(
  label: string,
  overrides: Partial<SnapshotState> = {},
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
