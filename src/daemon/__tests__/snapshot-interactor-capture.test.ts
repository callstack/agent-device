import { expect, test, vi } from 'vitest';
import type {
  Interactor,
  SnapshotOptions,
  SnapshotResult,
  SnapshotRuntimeAcquiredResult,
} from '@agent-device/contracts/interactor-types';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { captureSnapshotWithInteractor } from '../snapshot-interactor-capture.ts';

const getInteractor = vi.hoisted(() => vi.fn());
vi.mock('../../core/interactors.ts', () => ({ getInteractor }));

const presentIosSnapshotAcquisition = vi.hoisted(() => vi.fn());
vi.mock('@agent-device/capture-kit/ios-snapshot-runtime', () => ({
  presentIosSnapshotAcquisition,
}));

const presented: SnapshotResult = { backend: 'xctest', producer: 'simulator-ax-bridge', nodes: [] };

const acquired: SnapshotRuntimeAcquiredResult = {
  stage: 'acquired',
  acquisition: {
    producer: 'simulator-ax-bridge',
    intent: 'full',
    nodes: [],
    viewport: { kind: 'missing', reason: 'not-supported' },
    lineage: {},
    residue: [],
  },
};

function interactorReturning(result: SnapshotResult | SnapshotRuntimeAcquiredResult): Interactor {
  return { snapshot: async () => result } as unknown as Interactor;
}

test('a presented snapshot passes through without the acquisition presenter', async () => {
  getInteractor.mockReset();
  presentIosSnapshotAcquisition.mockReset();
  getInteractor.mockResolvedValue(interactorReturning(presented));

  const options: SnapshotOptions = { interactiveOnly: true };
  await expect(
    captureSnapshotWithInteractor({
      device: IOS_SIMULATOR,
      runnerContext: {},
      options,
    }),
  ).resolves.toEqual(presented);

  expect(presentIosSnapshotAcquisition).not.toHaveBeenCalled();
});

test('an acquired snapshot is presented through the capture-kit runtime', async () => {
  getInteractor.mockReset();
  presentIosSnapshotAcquisition.mockReset();
  getInteractor.mockResolvedValue(interactorReturning(acquired));
  const rePresented: SnapshotResult = {
    backend: 'xctest',
    producer: 'simulator-ax-bridge',
    nodes: [],
  };
  presentIosSnapshotAcquisition.mockReturnValue(rePresented);

  const options: SnapshotOptions = {};
  await expect(
    captureSnapshotWithInteractor({
      device: IOS_SIMULATOR,
      runnerContext: {},
      options,
    }),
  ).resolves.toBe(rePresented);

  expect(presentIosSnapshotAcquisition).toHaveBeenCalledOnce();
  expect(presentIosSnapshotAcquisition).toHaveBeenCalledWith(acquired, options);
});
