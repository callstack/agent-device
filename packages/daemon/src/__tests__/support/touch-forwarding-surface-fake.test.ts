import { expect, test, vi } from 'vitest';
import type { AgentDeviceRuntimeConfig } from '@agent-device/contracts/runtime-contract';
import { attachRefs, type SnapshotState } from '@agent-device/kernel/snapshot';
import { touchForwardingCreateCommandSurface } from './touch-forwarding-surface-fake.ts';

function tree(rect: { x: number; y: number; width: number; height: number }): SnapshotState {
  return {
    nodes: attachRefs([{ index: 0, type: 'Button', label: 'Go', rect, hittable: true }]),
    createdAt: 1,
    backend: 'xctest',
  };
}

test('a ref resolves against the authorized ref frame before the latest observation', async () => {
  const tap = vi.fn(async () => undefined);
  const config = {
    backend: { platform: 'ios', tap },
    sessions: {
      get: async () => ({
        name: 'default',
        snapshot: tree({ x: 200, y: 200, width: 20, height: 20 }),
        refFrameSnapshot: tree({ x: 0, y: 0, width: 20, height: 20 }),
      }),
      set: async () => {},
    },
  } as unknown as AgentDeviceRuntimeConfig;
  const surface = await touchForwardingCreateCommandSurface()(config);

  await surface.interactions.press({ kind: 'ref', ref: '@e1' }, { session: 'default' });

  expect(tap).toHaveBeenCalledWith(expect.anything(), { x: 10, y: 10 });
});
