import { readFileSync } from 'node:fs';
import type { IosTreeNode } from './snapshot.ts';
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

const nativeStates = JSON.parse(
  readFileSync(
    new URL('../../../contracts/fixtures/native-snapshot-states.json', import.meta.url),
    'utf8',
  ),
) as {
  cases: { name: string; input: IosTreeNode; expected: Record<string, boolean> }[];
};
for (const row of nativeStates.cases.filter(
  ({ input }) => !['checked', 'password', 'editable'].some((key) => key in input),
)) {
  test(`limrun acquires native states: ${row.name}`, async () => {
    const result = await captureLimrunIosSnapshot(createLimrunSnapshotSession(row.input));
    const node = result.acquisition.nodes[0]!;
    const states = Object.fromEntries(
      ['checked', 'password', 'editable'].flatMap((key) => {
        const value = node[key as 'checked' | 'password' | 'editable'];
        return value === undefined ? [] : [[key, value]];
      }),
    );
    expect(states).toEqual(row.expected);
  });
}

test('Limrun secure TextField subrole survives acquisition without changing the native type', async () => {
  const result = await captureLimrunIosSnapshot(
    createLimrunSnapshotSession({
      type: 'TextField',
      role: 'AXTextField',
      subrole: 'AXSecureTextField',
      traits: ['TextOperationsAvailable', 'Scrollable', 'TextEntry', 'SecureTextField'],
      role_description: 'secure text field',
      AXUniqueId: 'native-secure',
      AXValue: 'Native input',
      enabled: true,
    }),
  );
  expect(result.acquisition.nodes[0]).toMatchObject({
    type: 'TextField',
    identifier: 'native-secure',
    password: true,
    editable: true,
    roleDescription: 'secure text field',
  });
});

test('Limrun carries docked tree evidence and never infers absence from missing nodes', async () => {
  const tree = limrunSnapshotTree();
  expect(
    (await captureLimrunIosSnapshot(createLimrunSnapshotSession(tree))).acquisition.keyboard,
  ).toEqual({ kind: 'unmeasurable', reason: 'keyboard-not-observed' });
  tree.children!.push({
    elementType: 'Keyboard',
    frame: { x: 0, y: 140, width: 320, height: 100 },
  });
  expect(
    (await captureLimrunIosSnapshot(createLimrunSnapshotSession(tree))).acquisition.keyboard,
  ).toEqual({
    kind: 'derived',
    derivation: 'docked-tree',
    frame: { x: 0, y: 140, width: 320, height: 100 },
  });
  tree.children!.at(-1)!.frame = { x: 100, y: 60, width: 140, height: 80 };
  expect(
    (await captureLimrunIosSnapshot(createLimrunSnapshotSession(tree))).acquisition.keyboard,
  ).toEqual({ kind: 'tree-rejected', derivation: 'docked-tree' });
});

test('limrun acquisition shares RN interpretation and preserves native values', async () => {
  const result = await captureLimrunIosSnapshot(
    createLimrunSnapshotSession({
      elementType: 'Other',
      value: 'checkbox, unchecked',
      children: [{ elementType: 'TextField', value: 'checkbox, checked' }],
    }),
  );
  const [checkbox, field] = result.acquisition.nodes;
  expect(checkbox).toMatchObject({
    type: 'Other',
    value: 'checkbox, unchecked',
    checked: false,
    iosValueSemantics: { role: 'checkbox', checked: false },
  });
  expect(field).toMatchObject({ type: 'TextField', value: 'checkbox, checked' });
  expect(field).not.toHaveProperty('iosValueSemantics');
  expect(field).not.toHaveProperty('checked');
});
