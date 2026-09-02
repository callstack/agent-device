import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { eagerClosureOf } from '../__tests__/eager-import-closure.fixtures.ts';

const { captureLinuxSurfaceSnapshot, captureMacOsSurfaceSnapshot } = vi.hoisted(() => ({
  captureLinuxSurfaceSnapshot: vi.fn(),
  captureMacOsSurfaceSnapshot: vi.fn(),
}));

vi.mock('@agent-device/platform-linux', () => ({ captureLinuxSurfaceSnapshot }));

import { createSnapshotRuntimeHost } from './snapshot-desktop-surface.ts';

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
  captureLinuxSurfaceSnapshot.mockReset();
  captureMacOsSurfaceSnapshot.mockReset();
});

function createHost() {
  return createSnapshotRuntimeHost({
    linux: captureLinuxSurfaceSnapshot,
    macos: captureMacOsSurfaceSnapshot,
  });
}

test('desktop snapshot host keeps iOS presentation outside its eager import closure', () => {
  const closure = eagerClosureOf(path.join(import.meta.dirname, 'snapshot-desktop-surface.ts'));
  expect(closure).not.toContain(path.join(import.meta.dirname, 'ios-snapshot-runtime.ts'));
});

test('Apple snapshot host preserves non-app macOS surface capture and menubar identity', async () => {
  captureMacOsSurfaceSnapshot.mockResolvedValue({
    nodes: [{ index: 0, depth: 0, type: 'MenuBar', label: 'System menu' }],
    truncated: false,
    backend: 'macos-helper',
    producer: 'macos-helper',
  });
  const signal = new AbortController().signal;

  const result = await createHost().captureSurface(
    macosDevice,
    { surface: 'menubar', appBundleId: 'com.example.app' },
    signal,
  );

  expect(captureMacOsSurfaceSnapshot).toHaveBeenCalledWith(
    { surface: 'menubar', appBundleId: 'com.example.app' },
    signal,
  );
  expect(result).toEqual({
    nodes: [{ index: 0, depth: 0, type: 'MenuBar', label: 'System menu' }],
    truncated: false,
    backend: 'macos-helper',
    producer: 'macos-helper',
  });
});

test('Linux snapshot host preserves interactive ancestor projection before depth filtering', async () => {
  captureLinuxSurfaceSnapshot.mockResolvedValue({
    backend: 'linux-atspi',
    producer: 'linux-atspi',
    truncated: false,
    nodes: [
      { index: 0, depth: 0, type: 'Application', label: 'App', parentIndex: undefined },
      { index: 1, parentIndex: 0, depth: 1, type: 'Group', label: 'Panel' },
    ],
  });
  const signal = new AbortController().signal;

  const result = await createHost().captureSurface(
    linuxDevice,
    { surface: 'desktop', interactiveOnly: true, depth: 1 },
    signal,
  );

  expect(captureLinuxSurfaceSnapshot).toHaveBeenCalledWith(
    { surface: 'desktop', interactiveOnly: true, depth: 1 },
    signal,
  );
  expect(result).toEqual({
    backend: 'linux-atspi',
    producer: 'linux-atspi',
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

test('iOS snapshot host presents provider facts and keeps raw truncation evidence explicit', async () => {
  const acquired: SnapshotRuntimeAcquiredResult = {
    stage: 'acquired',
    acquisition: {
      producer: 'limrun-ios-tree',
      intent: 'full',
      nodes: [
        {
          index: 0,
          depth: 0,
          type: 'Application',
          label: 'App',
          rect: { x: 0, y: 0, width: 320, height: 240 },
        },
        {
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'Button',
          label: 'Continue',
          rect: { x: 16, y: 16, width: 120, height: 40 },
          hittable: true,
        },
      ],
      viewport: { kind: 'derived', rect: { x: 0, y: 0, width: 320, height: 240 } },
      lineage: { targetId: 'limrun-instance' },
      residue: [
        { kind: 'unavailable-fact', fact: 'hittability' },
        { kind: 'unavailable-fact', fact: 'acquisition-depth' },
        { kind: 'unavailable-fact', fact: 'truncation' },
      ],
    },
  };

  const host = createHost();
  const regular = await host.presentIosAcquisition(acquired, {});
  expect(regular).toMatchObject({ backend: 'xctest', producer: 'limrun-ios-tree' });
  expect(regular.nodes?.map((node) => node.label)).toEqual(['App', 'Continue']);
  expect(regular.nodes?.[1]).not.toHaveProperty('hittable');
  expect(regular.warnings).toHaveLength(3);
  expect(regular.truncated).toBeUndefined();

  const raw = await host.presentIosAcquisition(acquired, { raw: true });
  expect(raw.nodes?.[1]).toHaveProperty('hittable', true);
  expect(raw.truncated).toBeUndefined();
});
