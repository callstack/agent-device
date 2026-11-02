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
  expect(nodes.find((node) => node.ref === 'e4')?.label).toBeUndefined();
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

test('a row does not absorb content owned by an editable descendant', () => {
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
      type: 'android.widget.EditText',
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
