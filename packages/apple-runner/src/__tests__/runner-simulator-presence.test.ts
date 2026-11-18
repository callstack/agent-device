import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { appleRunnerTestHost } from '../test-host.ts';
import { assertBootedSimulatorStillListed } from '../runner-simulator-presence.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';

const DEVICE = { ...IOS_SIMULATOR, id: '54A531E3-0610-48D3-9904-07E9F028397F' };

const runXcrun = vi.fn();

function simctlListing(udids: readonly string[]) {
  const devices = udids.map((udid) => ({ udid, state: 'Booted' }));
  return {
    exitCode: 0,
    stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-2': devices } }),
    stderr: '',
  };
}

beforeEach(() => {
  runXcrun.mockReset();
  appleRunnerTestHost.update({ runXcrun });
});

test('a booted session simulator missing from the listing is refused with its udid', async () => {
  runXcrun.mockResolvedValue(simctlListing(['9D788936-DC32-4CA9-BFB8-CAF6807D2F16']));

  await assert.rejects(assertBootedSimulatorStillListed(DEVICE), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'DEVICE_NOT_FOUND');
    assert.match(error.message, new RegExp(DEVICE.id));
    assert.equal(error.details?.deviceId, DEVICE.id);
    assert.equal(error.details?.dispatched, 'no');
    // The runner cache is shared by every agent on the host; a missing device is no reason to wipe it.
    assert.doesNotMatch(String(error.details?.hint), /apple-runner\/derived|clean:xcuitest/);
    return true;
  });
  assert.deepEqual(runXcrun.mock.calls[0]?.[0]?.slice(-3), ['list', 'devices', '-j']);
});

test('a booted session simulator still in the listing passes', async () => {
  runXcrun.mockResolvedValue(simctlListing([DEVICE.id]));

  await assertBootedSimulatorStillListed(DEVICE);

  assert.equal(runXcrun.mock.calls.length, 1);
});

test('a listing that cannot be read does not refuse the start', async () => {
  runXcrun.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'CoreSimulator unavailable' });
  await assertBootedSimulatorStillListed(DEVICE);

  runXcrun.mockResolvedValueOnce({ exitCode: 0, stdout: 'not json', stderr: '' });
  await assertBootedSimulatorStillListed(DEVICE);

  runXcrun.mockRejectedValueOnce(new Error('simctl timed out'));
  await assertBootedSimulatorStillListed(DEVICE);
});

test('a simulator this process just observed booted is not listed again', async () => {
  appleRunnerTestHost.update({ wasSimulatorRecentlyObservedBooted: async () => true });

  await assertBootedSimulatorStillListed(DEVICE);

  assert.equal(runXcrun.mock.calls.length, 0);
});

test('a cancelled listing reports the cancellation, not a missing simulator', async () => {
  const controller = new AbortController();
  runXcrun.mockImplementation(async () => {
    controller.abort(new Error('request canceled'));
    throw new Error('aborted');
  });

  await assert.rejects(assertBootedSimulatorStillListed(DEVICE, controller.signal), /canceled/);
});
