import { beforeEach, expect, test, vi } from 'vitest';

const { snapshotLinux } = vi.hoisted(() => ({
  snapshotLinux: vi.fn(),
}));

vi.mock('../snapshot.ts', () => ({ snapshotLinux }));

import { captureLinuxSurfaceSnapshot } from '../surface-snapshot.ts';

beforeEach(() => {
  snapshotLinux.mockReset();
});

test('Linux surface snapshots preserve interactive ancestors before depth filtering', async () => {
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

  const result = await captureLinuxSurfaceSnapshot(
    { surface: 'desktop', interactiveOnly: true, depth: 1 },
    signal,
  );

  expect(snapshotLinux).toHaveBeenCalledWith('desktop', signal);
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
