import { expect, test, vi } from 'vitest';
import { captureLimrunIosSnapshot } from './ios-snapshot-adapter.ts';
import {
  LIMRUN_SNAPSHOT_SCREEN,
  createLimrunSnapshotSession,
  limrunSnapshotTree,
} from './ios-snapshot-adapter.fixtures.ts';

test('Limrun adapter returns the tree and shared viewport facts without presenting them', async () => {
  const session = createLimrunSnapshotSession(limrunSnapshotTree(), { width: 240, height: 320 });
  const elementTree = vi.fn(session.client.elementTree);
  const result = await captureLimrunIosSnapshot({
    ...session,
    client: { ...session.client, elementTree },
  });

  expect(elementTree).toHaveBeenCalledWith();
  expect(result.stage).toBe('acquired');
  expect(result.acquisition.producer).toBe('limrun-ios-tree');
  expect(result.acquisition.nodes.map((node) => node.label)).toEqual([
    'App',
    'Settings',
    'Target',
    'Save',
    'Save',
  ]);
  expect(result.acquisition.nodes.find((node) => node.label === 'Save')).toHaveProperty(
    'hittable',
    true,
  );
  expect(result.acquisition.viewport).toEqual({
    kind: 'derived',
    rect: { x: 0, y: 0, width: 320, height: 240 },
  });
  expect(result.acquisition.residue).toEqual([
    { kind: 'unavailable-fact', fact: 'hittability' },
    { kind: 'unavailable-fact', fact: 'acquisition-depth' },
    { kind: 'unavailable-fact', fact: 'truncation' },
  ]);
});

test('Limrun adapter preserves provider-reported node facts for host presentation', async () => {
  const tree = limrunSnapshotTree();
  tree.children![0]!.children!.push({
    elementType: 'Button',
    label: 'Enabled but unverified',
    frame: { x: 120, y: 120, width: 80, height: 40 },
    enabled: true,
    hittable: true,
  });

  const result = await captureLimrunIosSnapshot(createLimrunSnapshotSession(tree));
  const target = result.acquisition.nodes.find((node) => node.label === 'Enabled but unverified');

  expect(target).toMatchObject({ enabled: true, rect: { x: 120, y: 120, width: 80, height: 40 } });
  expect(target).toHaveProperty('hittable', true);
});

test('Limrun adapter uses valid deviceInfo when the tree has no viewport root frame', async () => {
  const tree = limrunSnapshotTree();
  tree.frame = undefined;

  const result = await captureLimrunIosSnapshot(
    createLimrunSnapshotSession(tree, { width: 240, height: 320 }),
  );

  expect(result.acquisition.viewport).toEqual({
    kind: 'reported',
    rect: { x: 0, y: 0, width: 240, height: 320 },
  });
});

test('Limrun adapter carries invalid viewport evidence to the host presenter', async () => {
  const tree = limrunSnapshotTree();
  tree.frame = undefined;
  const result = await captureLimrunIosSnapshot(
    createLimrunSnapshotSession(tree, { width: 0, height: 240 }),
  );

  expect(result.acquisition.viewport).toEqual({ kind: 'missing', reason: 'invalid' });
  expect(result.acquisition.residue).toContainEqual({
    kind: 'missing-viewport',
    reason: 'invalid',
  });
});

test('the Limrun acquired result keeps provider provenance and SDK screen dimensions', async () => {
  const result = await captureLimrunIosSnapshot(createLimrunSnapshotSession());

  expect(result.acquisition).toMatchObject({
    producer: 'limrun-ios-tree',
    lineage: { targetId: 'limrun-snapshot-test-instance' },
  });
  expect(result.acquisition.nodes[0]?.rect).toEqual({
    x: 0,
    y: 0,
    width: LIMRUN_SNAPSHOT_SCREEN.width,
    height: LIMRUN_SNAPSHOT_SCREEN.height,
  });
});
