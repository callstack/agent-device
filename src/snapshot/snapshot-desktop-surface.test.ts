import { beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';

const { runMacOsSnapshotAction, snapshotLinux } = vi.hoisted(() => ({
  runMacOsSnapshotAction: vi.fn(),
  snapshotLinux: vi.fn(),
}));

vi.mock('../platforms/apple/os/macos/helper.ts', () => ({ runMacOsSnapshotAction }));
vi.mock('../platforms/linux/snapshot.ts', () => ({ snapshotLinux }));

import { createSnapshotRuntimeHost, scopeSnapshotNodes } from './snapshot-desktop-surface.ts';

const macosDevice = {
  id: 'desktop',
  name: 'macOS Desktop',
  platform: 'apple',
  appleOs: 'macos',
  kind: 'device',
} as DeviceInfo;

const linuxDevice = {
  id: 'linux-desktop',
  name: 'Linux Desktop',
  platform: 'linux',
  kind: 'device',
} as DeviceInfo;

beforeEach(() => {
  runMacOsSnapshotAction.mockReset();
  snapshotLinux.mockReset();
});

test('Apple snapshot host preserves non-app macOS surface capture and menubar identity', async () => {
  runMacOsSnapshotAction.mockResolvedValue({
    nodes: [{ index: 0, depth: 0, type: 'MenuBar', label: 'System menu' }],
    truncated: false,
    backend: 'macos-helper',
  });
  const signal = new AbortController().signal;

  const result = await createSnapshotRuntimeHost().captureSurface(
    macosDevice,
    { surface: 'menubar', appBundleId: 'com.example.app' },
    signal,
  );

  expect(runMacOsSnapshotAction).toHaveBeenCalledWith('menubar', {
    bundleId: 'com.example.app',
    signal,
  });
  expect(result).toEqual({
    nodes: [{ index: 0, depth: 0, type: 'MenuBar', label: 'System menu' }],
    truncated: false,
    backend: 'macos-helper',
  });
});

test('Linux snapshot host preserves interactive ancestor projection before depth filtering', async () => {
  snapshotLinux.mockResolvedValue({
    truncated: false,
    nodes: [
      { index: 0, depth: 0, type: 'Application', label: 'App' },
      { index: 1, parentIndex: 0, depth: 1, type: 'Group', label: 'Panel' },
      { index: 2, parentIndex: 1, depth: 2, type: 'Button', label: 'Continue', hittable: true },
      { index: 3, parentIndex: 1, depth: 2, type: 'StaticText', label: 'Details' },
    ],
  });
  const signal = new AbortController().signal;

  const result = await createSnapshotRuntimeHost().captureSurface(
    linuxDevice,
    { surface: 'desktop', interactiveOnly: true, depth: 1 },
    signal,
  );

  expect(snapshotLinux).toHaveBeenCalledWith('desktop', signal);
  expect(result).toEqual({
    backend: 'linux-atspi',
    truncated: false,
    nodes: [
      { index: 0, depth: 0, type: 'Application', label: 'App', parentIndex: undefined },
      {
        index: 1,
        parentIndex: 0,
        depth: 1,
        type: 'Group',
        label: 'Panel',
      },
    ],
  });
});

// Golden scope-policy leg (#1832 C2): the post-wire pass must agree with
// contracts/fixtures/snapshot-scope-policy.json — the same table the Android projection and the
// shared predicate are asserted against. Fixture position rides in `rect.x` so the check is
// text-independent.
test('scopeSnapshotNodes agrees with every golden scope-policy table case', () => {
  const cases = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, '../../contracts/fixtures/snapshot-scope-policy.json'),
      'utf8',
    ),
  ) as Array<{
    name: string;
    scope: string;
    nodes: Array<{
      depth: number;
      label?: string;
      value?: string;
      identifier?: string;
      presented?: boolean;
    }>;
    expectedSubtreeIndexes: number[];
  }>;
  expect(cases.length).toBeGreaterThan(0);
  for (const fixture of cases) {
    const parents: number[] = [];
    const nodes = fixture.nodes.map((node, index) => {
      parents.length = node.depth;
      const parentIndex = node.depth > 0 ? parents[node.depth - 1] : undefined;
      parents[node.depth] = index;
      return { ...node, index, parentIndex, rect: { x: index, y: 0, width: 1, height: 1 } };
    });
    const scoped = scopeSnapshotNodes(nodes, fixture.scope, (range) =>
      nodes.slice(range.start, range.end).some((node) => node.presented !== false),
    );
    expect(
      scoped.map((node) => node.rect?.x),
      fixture.name,
    ).toEqual(fixture.expectedSubtreeIndexes);
    if (scoped.length > 0) expect(scoped[0]?.depth, fixture.name).toBe(0);
  }
});
