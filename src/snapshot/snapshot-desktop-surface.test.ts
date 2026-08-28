import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

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
