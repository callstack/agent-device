import { expect, test, vi } from 'vitest';
import type { AgentDeviceRuntimeConfig } from '@agent-device/contracts/runtime-contract';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { forwardingCreateCommandSurface } from './command-surface-fake.ts';

const node = { index: 0, ref: 'e1', type: 'Button', label: 'Go' } as SnapshotNode;

function configReturning(
  captured: Record<string, unknown>,
  existing?: { snapshot: SnapshotState },
) {
  const set = vi.fn(async () => {});
  const config = {
    backend: { captureSnapshot: vi.fn(async () => captured) },
    sessions: {
      get: vi.fn(async () => (existing ? { name: 'default', ...existing } : undefined)),
      set,
    },
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

test('the forwarding surface diff stores the observed tree and reports whether it initialized the baseline', async () => {
  const snapshot: SnapshotState = { nodes: [node], createdAt: 1, backend: 'android' };
  const first = configReturning({ snapshot });
  const initialized = await (
    await forwardingCreateCommandSurface(first.config)
  ).capture.diffSnapshot({ session: 'default' });

  expect(initialized.baselineInitialized).toBe(true);
  expect(first.set).toHaveBeenCalledWith(expect.objectContaining({ snapshot }));

  const second = configReturning({ snapshot }, { snapshot: { ...snapshot, createdAt: 0 } });
  const compared = await (
    await forwardingCreateCommandSurface(second.config)
  ).capture.diffSnapshot({ session: 'default' });

  expect(compared.baselineInitialized).toBe(false);
  expect(second.set).toHaveBeenCalledWith(expect.objectContaining({ snapshot }));
});

test('the forwarding surface hands the backend the capture options of both snapshot and diff', async () => {
  const snapshot: SnapshotState = { nodes: [node], createdAt: 1, backend: 'android' };
  const { config } = configReturning({ snapshot });
  const surface = await forwardingCreateCommandSurface(config);
  const options = { session: 'default', interactiveOnly: true, depth: 3, scope: '@e1', raw: true };

  await surface.capture.snapshot(options);
  await surface.capture.diffSnapshot(options);

  const expected = { interactiveOnly: true, depth: 3, scope: '@e1', raw: true };
  expect(config.backend.captureSnapshot).toHaveBeenNthCalledWith(1, expect.anything(), expected);
  expect(config.backend.captureSnapshot).toHaveBeenNthCalledWith(2, expect.anything(), expected);
});
