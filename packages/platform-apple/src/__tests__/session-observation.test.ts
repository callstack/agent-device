import { beforeEach, expect, test, vi } from 'vitest';
import { createAppleSessionObservation } from '../session-observation.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';

const { snapshot, runningApp } = vi.hoisted(() => ({
  snapshot: vi.fn(),
  runningApp: vi.fn(),
}));
vi.mock('../core/runner-client.ts', () => ({ readRunnerSessionLiveness: snapshot }));
vi.mock('../core/app-resolution.ts', () => ({ detectSoleRunningIosSimulatorApp: runningApp }));

const host = {
  listLocalDevices: vi.fn(),
  shouldPropagateProbeError: vi.fn(),
};
const observation = createAppleSessionObservation(host);

beforeEach(() => {
  vi.resetAllMocks();
});

test('runner observation reports a registered runner, whatever lifecycle state it is in', async () => {
  snapshot.mockReturnValue({ sessionId: 'runner-1', liveness: 'starting' });

  await expect(observation.observeRunnerSession('sim-1')).resolves.toEqual({
    alive: true,
    sessionId: 'runner-1',
  });
  expect(snapshot).toHaveBeenCalledWith('sim-1');
  expect(host.listLocalDevices).not.toHaveBeenCalled();
});

test('a missing runner session has no observation', async () => {
  snapshot.mockReturnValue(null);
  await expect(observation.observeRunnerSession('sim-1')).resolves.toBeUndefined();
});

test('foreground observation preserves the exact simulator set and app identity', async () => {
  host.listLocalDevices.mockResolvedValue([IOS_SIMULATOR]);
  runningApp.mockResolvedValue({ bundleId: 'xyz.blueskyweb.app', name: 'Bluesky' });

  await expect(
    observation.resolveSoleForegroundApp({ simulatorSetPath: '/custom/set' }),
  ).resolves.toEqual({ device: IOS_SIMULATOR, app: { bundleId: 'xyz.blueskyweb.app' } });
  expect(host.listLocalDevices).toHaveBeenCalledWith({
    platform: 'ios',
    iosSimulatorSetPath: '/custom/set',
    kind: 'simulator',
    booted: true,
  });
  expect(runningApp).toHaveBeenCalledWith(IOS_SIMULATOR);
});

test.each([{ devices: [] }, { devices: [IOS_SIMULATOR, { ...IOS_SIMULATOR, id: 'other' }] }])(
  'an ambiguous simulator inventory never probes an app: $devices',
  async ({ devices }) => {
    host.listLocalDevices.mockResolvedValue(devices);
    await expect(observation.resolveSoleForegroundApp()).resolves.toBeUndefined();
    expect(runningApp).not.toHaveBeenCalled();
  },
);

test('an inconclusive running-app probe never guesses', async () => {
  host.listLocalDevices.mockResolvedValue([IOS_SIMULATOR]);
  runningApp.mockResolvedValue(undefined);
  await expect(observation.resolveSoleForegroundApp()).resolves.toBeUndefined();
});

test.each(['inventory', 'foreground'])(
  '%s failures obey the host control-flow classification',
  async (probe) => {
    const error = new Error('probe failed');
    host.listLocalDevices.mockResolvedValue([IOS_SIMULATOR]);
    (probe === 'inventory' ? host.listLocalDevices : runningApp).mockRejectedValue(error);

    host.shouldPropagateProbeError.mockReturnValue(false);
    await expect(observation.resolveSoleForegroundApp()).resolves.toBeUndefined();
    expect(host.shouldPropagateProbeError).toHaveBeenCalledWith(error);

    host.shouldPropagateProbeError.mockReturnValue(true);
    await expect(observation.resolveSoleForegroundApp()).rejects.toBe(error);
  },
);
