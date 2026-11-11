import { expect, test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { buildAndroidHelperPresentationInput } from './helper.ts';
import settingsHome from './settings-home.fixture.json' with { type: 'json' };

const helperData = { androidSnapshot: { backend: 'android-helper' } };

test('Settings categories retain separate actionable refs inside nested scroll containers', () => {
  const { nodes } = buildAndroidHelperPresentationInput(helperData, settingsHome.nodes, {});

  for (const [ref, label] of Object.entries({
    e10: 'Network & internet',
    e13: 'Connected devices',
    e16: 'Apps',
  })) {
    expect(nodes.find((node) => node.ref === ref)).toMatchObject({
      label: expect.stringContaining(label),
      hittable: true,
    });
  }
  const outerScroll = nodes.find((node) => node.ref === 'e4');
  expect(outerScroll).toBeDefined();
  expect(outerScroll?.label).toBeUndefined();
});

test('a row keeps its own passive label alongside an independent button', () => {
  const input: SnapshotNode[] = [
    { index: 0, type: 'root' },
    {
      index: 1,
      parentIndex: 0,
      type: 'android.view.View',
      hittable: true,
      rect: { x: 0, y: 0, width: 100, height: 40 },
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'android.widget.TextView',
      label: 'Account',
      rect: { x: 2, y: 2, width: 50, height: 30 },
    },
    {
      index: 3,
      parentIndex: 1,
      type: 'android.widget.Button',
      label: 'Edit',
      hittable: true,
      rect: { x: 60, y: 2, width: 30, height: 30 },
    },
  ];
  const { nodes } = buildAndroidHelperPresentationInput(helperData, input, {});

  expect(nodes.find((node) => node.index === 1)?.label).toBe('Account');
  expect(nodes.find((node) => node.index === 3)?.label).toBe('Edit');
  expect(nodes.some((node) => node.index === 2)).toBe(false);
});

test.each([
  { type: 'android.widget.EditText', editable: undefined },
  { type: 'com.example.ProfileField', editable: true },
])('a row does not absorb content owned by an editable $type descendant', (field) => {
  const input: SnapshotNode[] = [
    { index: 0, type: 'root' },
    {
      index: 1,
      parentIndex: 0,
      type: 'android.view.View',
      hittable: true,
      rect: { x: 0, y: 0, width: 200, height: 80 },
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'android.widget.TextView',
      label: 'Profile',
      rect: { x: 2, y: 2, width: 50, height: 30 },
    },
    {
      index: 3,
      parentIndex: 1,
      ...field,
      label: 'Name',
      rect: { x: 60, y: 2, width: 100, height: 60 },
    },
    {
      index: 4,
      parentIndex: 3,
      type: 'android.widget.TextView',
      label: 'Nested value',
      rect: { x: 65, y: 5, width: 90, height: 30 },
    },
  ];
  const { nodes } = buildAndroidHelperPresentationInput(helperData, input, {});

  expect(nodes.find((node) => node.index === 1)?.label).toBe('Profile');
  expect(nodes.find((node) => node.index === 3)?.label).toBe('Name');
  expect(nodes.find((node) => node.index === 4)?.label).toBe('Nested value');
});

test('nested unlabeled action rows read each parent link a bounded number of times', () => {
  // Each unlabeled hittable row collects its descendants. A full node scan per visited node reads
  // nodes x subtree parent links per row (about 4.5e6 for this nesting); a children map reads
  // each link a constant number of times.
  const depth = 300;
  let parentReads = 0;
  const count = (node: SnapshotNode): SnapshotNode =>
    new Proxy(node, {
      get(target, key, receiver) {
        if (key === 'parentIndex') parentReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
  const input: SnapshotNode[] = [count({ index: 0, type: 'root' })];
  for (let level = 1; level <= depth; level += 1) {
    input.push(
      count({
        index: level,
        parentIndex: level - 1,
        type: 'android.view.View',
        hittable: true,
        rect: { x: 0, y: 0, width: 400, height: 400 },
      }),
    );
  }
  input.push(
    count({
      index: depth + 1,
      parentIndex: depth,
      type: 'android.widget.TextView',
      label: 'Leaf',
      rect: { x: 8, y: 8, width: 200, height: 32 },
    }),
  );

  const { nodes } = buildAndroidHelperPresentationInput(helperData, input, {});

  expect(nodes.find((node) => node.index === depth)?.label).toBe('Leaf');
  expect(parentReads).toBeLessThan(50 * depth);
});
