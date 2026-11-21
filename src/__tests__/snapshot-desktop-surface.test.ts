import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { eagerClosureOf } from '@agent-device/test-kit';

const { captureMacOsSurfaceSnapshot } = vi.hoisted(() => ({
  captureMacOsSurfaceSnapshot: vi.fn(),
}));

import { createSnapshotRuntimeHost } from '@agent-device/capture-kit/snapshot-desktop-surface';

const macosDevice = {
  id: 'desktop',
  name: 'macOS Desktop',
  platform: 'apple',
  appleOs: 'macos',
  kind: 'device',
} as DeviceInfo;

beforeEach(() => {
  captureMacOsSurfaceSnapshot.mockReset();
});

function createHost() {
  return createSnapshotRuntimeHost({
    macos: captureMacOsSurfaceSnapshot,
  });
}

test('desktop snapshot host keeps iOS presentation outside its eager import closure', () => {
  const entry = path.resolve(
    import.meta.dirname,
    '../../packages/capture-kit/src/snapshot/snapshot-desktop-surface.ts',
  );
  const closure = eagerClosureOf(entry);
  expect(closure).not.toContain(
    path.resolve(
      import.meta.dirname,
      '../../packages/capture-kit/src/snapshot/ios-snapshot-runtime.ts',
    ),
  );
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

test('desktop snapshot host refuses a device whose surface the core does not project', async () => {
  // The Linux desktop capture moved to the Linux plugin (#4676): the core's host no longer answers
  // for it, so a Linux device reaching this host is a routing mistake, not a missing loader.
  const linuxDevice = {
    id: 'linux-desktop',
    name: 'Linux Desktop',
    platform: 'linux',
    kind: 'device',
  } as DeviceInfo;

  await expect(
    createHost().captureSurface(linuxDevice, { surface: 'desktop' }, new AbortController().signal),
  ).rejects.toThrow(/macOS surface/i);
  expect(captureMacOsSurfaceSnapshot).not.toHaveBeenCalled();
});

test('iOS snapshot host presents provider facts and keeps raw truncation evidence explicit', async () => {
  const acquired: SnapshotRuntimeAcquiredResult = {
    stage: 'acquired',
    acquisition: {
      producer: 'revyl-ios-tree',
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
      lineage: { targetId: 'revyl-instance' },
      residue: [
        { kind: 'unavailable-fact', fact: 'hittability' },
        { kind: 'unavailable-fact', fact: 'acquisition-depth' },
        { kind: 'unavailable-fact', fact: 'truncation' },
      ],
    },
  };

  const host = createHost();
  const regular = await host.presentIosAcquisition(acquired, {});
  expect(regular).toMatchObject({ backend: 'xctest', producer: 'revyl-ios-tree' });
  expect(regular.nodes?.map((node) => node.label)).toEqual(['App', 'Continue']);
  expect(regular.nodes?.[1]).not.toHaveProperty('hittable');
  expect(regular.warnings).toHaveLength(3);
  expect(regular.truncated).toBeUndefined();

  const raw = await host.presentIosAcquisition(acquired, { raw: true });
  expect(raw.nodes?.[1]).toHaveProperty('hittable', true);
  expect(raw.truncated).toBeUndefined();
});
