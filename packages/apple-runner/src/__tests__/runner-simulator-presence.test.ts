import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { appleRunnerTestHost } from '../test-host.ts';
import { assertBootedSimulatorStillListed } from '../runner-simulator-presence.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';

// The refusal itself is covered on the runner start route in runner-session.test.ts; these cases
// pin the listings that must NOT refuse a start.
const DEVICE = { ...IOS_SIMULATOR, id: '54A531E3-0610-48D3-9904-07E9F028397F' };

const runXcrun = vi.fn();

beforeEach(() => {
  runXcrun.mockReset();
  appleRunnerTestHost.update({ runXcrun });
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
