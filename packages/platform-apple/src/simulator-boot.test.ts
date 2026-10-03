import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn() };
});

import { runCmd } from '@agent-device/host-kit/command';
import { IOS_DEVICE, IOS_SIMULATOR, MACOS_DEVICE } from './__tests__/device-fixtures.ts';
import { observeSimulatorBootTimeMs } from './simulator-boot.ts';

const mockRunCmd = vi.mocked(runCmd);

const BOOTED_AT = new Date(2024, 0, 15, 10, 20, 30).getTime();
const LAUNCHD = '/usr/bin/coresimd/launchd_sim';
const BOOTSTRAP = `/data/users/*/library/developer/core simulator/devices/${IOS_SIMULATOR.id}/data/var/run/launchd_bootstrap.plist`;

function psRow(pid: number, lstart: string, command: string): string {
  return `${pid} ${lstart} ${command}`;
}

function launchdRow(pid: number, lstart: string, udid: string): string {
  return psRow(pid, lstart, `${LAUNCHD} -c ${BOOTSTRAP.replace(IOS_SIMULATOR.id, udid)}`);
}

function succeed(...stdout: string[]) {
  mockRunCmd.mockResolvedValueOnce({ exitCode: 0, stdout: stdout.join('\n'), stderr: '' } as never);
}

beforeEach(() => {
  mockRunCmd.mockReset();
});

test('a device that is not an iOS Simulator is answered without probing the host', async () => {
  for (const device of [IOS_DEVICE, MACOS_DEVICE]) {
    assert.deepEqual(await observeSimulatorBootTimeMs(device), {
      observed: false,
      reason: 'unsupported-device',
    });
  }
  assert.equal(mockRunCmd.mock.calls.length, 0);
});

test('reads the boot from the launchd_sim that names this device and no other', async () => {
  succeed(String(4242));
  succeed(launchdRow(4242, 'Mon Jan 15 10:20:30 2024', IOS_SIMULATOR.id));

  assert.deepEqual(await observeSimulatorBootTimeMs(IOS_SIMULATOR), {
    observed: true,
    bootedAtMs: BOOTED_AT,
  });
  const [pgrep, ps] = mockRunCmd.mock.calls;
  assert.deepEqual(pgrep?.slice(0, 2), ['/usr/bin/pgrep', ['-x', 'launchd_sim']]);
  assert.equal(ps?.[0], '/bin/ps');
  assert.deepEqual(ps?.[1], ['-p', '4242', '-o', 'pid=,lstart=,command=']);
  // `lstart` spells weekday and month names in the caller's locale, which the parser rejects.
  assert.deepEqual((ps?.[2] as { env?: Record<string, string> })?.env, { LC_ALL: 'C' });
});

test('the newest boot wins when a device appears in more than one row', async () => {
  succeed('4242\n4343');
  succeed(
    launchdRow(4242, 'Mon Jan 15 10:20:30 2024', IOS_SIMULATOR.id),
    launchdRow(4343, 'Tue Jan 16 11:20:30 2024', IOS_SIMULATOR.id),
  );

  const observation = await observeSimulatorBootTimeMs(IOS_SIMULATOR);
  assert.equal(observation.observed, true);
  if (!observation.observed) return;
  assert.ok(observation.bootedAtMs > BOOTED_AT);
});

test('another device launchd_sim answers nothing about this one', async () => {
  succeed('4242');
  succeed(launchdRow(4242, 'Mon Jan 15 10:20:30 2024', 'OTHER-UDID'));

  assert.deepEqual(await observeSimulatorBootTimeMs(IOS_SIMULATOR), {
    observed: false,
    reason: 'unobserved',
  });
});

test('a boot that begins after the probe instant is a moved clock, not evidence', async () => {
  succeed('4242');
  succeed(launchdRow(4242, 'Sat Jan 15 10:20:30 2099', IOS_SIMULATOR.id));

  assert.deepEqual(await observeSimulatorBootTimeMs(IOS_SIMULATOR), {
    observed: false,
    reason: 'unobserved',
  });
});

test('an absent launchd_sim or a failed probe leaves the caller as cautious as it was', async () => {
  mockRunCmd.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' } as never);
  assert.deepEqual(await observeSimulatorBootTimeMs(IOS_SIMULATOR), {
    observed: false,
    reason: 'unobserved',
  });
  assert.equal(mockRunCmd.mock.calls.length, 1);

  succeed('4242');
  mockRunCmd.mockRejectedValueOnce(new Error('ps unavailable'));
  assert.deepEqual(await observeSimulatorBootTimeMs(IOS_SIMULATOR), {
    observed: false,
    reason: 'unobserved',
  });
});
