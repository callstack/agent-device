import { expect, test, vi } from 'vitest';
import type { AgentDeviceRuntimeConfig } from '@agent-device/contracts/runtime-contract';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { forwardingCreateCommandSurface } from './command-surface-fake.ts';

const node = { index: 0, ref: 'e1', type: 'Button', label: 'Go' } as SnapshotNode;

function configReturning(captured: Record<string, unknown>) {
  const set = vi.fn(async () => {});
  const config = {
    backend: { captureSnapshot: vi.fn(async () => captured) },
    sessions: { get: vi.fn(async () => undefined), set },
  } as unknown as AgentDeviceRuntimeConfig;
  return { config, set };
}

test('the forwarding surface returns and stores the snapshot tree the daemon backend produced', async () => {
  const snapshot: SnapshotState = { nodes: [node], createdAt: 1, backend: 'android' };
  const { config, set } = configReturning({ snapshot });
  const surface = await forwardingCreateCommandSurface(config);

  const result = await surface.capture.snapshot({ session: 'default' });

  expect(result.nodes).toEqual([node]);
  expect(set).toHaveBeenCalledWith(expect.objectContaining({ name: 'default', snapshot }));
});

test('the forwarding surface falls back to a flat node list from a backend that returns no snapshot', async () => {
  const { config, set } = configReturning({ nodes: [node] });
  const surface = await forwardingCreateCommandSurface(config);

  const result = await surface.capture.snapshot({ session: 'default' });

  expect(result.nodes).toEqual([node]);
  expect(set).toHaveBeenCalledWith(
    expect.objectContaining({ snapshot: expect.objectContaining({ nodes: [node] }) }),
  );
});
