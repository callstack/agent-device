import { expect, test, vi } from 'vitest';
import { doctorAppleAppLogs } from './doctor.ts';
import { appleDevice, hostFixture } from './runtime.fixtures.ts';

test('simulator doctor routes the exact simctl probe through appleTools', async () => {
  const appleToolRun = vi.fn(async () => ({ stdout: 'simctl help', stderr: '', exitCode: 0 }));
  const fixture = hostFixture({
    appleToolRun,
    commandRun: async (request) => {
      if (request.executable === 'xcrun') throw new Error('raw xcrun must not run');
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });

  await expect(
    doctorAppleAppLogs(fixture.host, appleDevice(), 'com.example.app'),
  ).resolves.toMatchObject({ checks: { simctlAvailable: true } });
  expect(appleToolRun).toHaveBeenCalledWith(
    { tool: 'simctl', args: ['help'], allowFailure: true },
    undefined,
  );
});

test('CoreDevice doctor routes version discovery through appleTools', async () => {
  const appleToolRun = vi.fn(async (request) => ({
    stdout: request.args.includes('--help')
      ? 'USAGE: devicectl device process launch --console --terminate-existing'
      : 'devicectl 1.0',
    stderr: '',
    exitCode: 0,
  }));
  const fixture = hostFixture({ appleToolRun });

  await expect(
    doctorAppleAppLogs(
      fixture.host,
      appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'coredevice' }),
      'com.example.app',
    ),
  ).resolves.toMatchObject({
    checks: { devicectlAvailable: true, devicectlConsoleCapture: true },
  });
  expect(appleToolRun).toHaveBeenNthCalledWith(
    1,
    { tool: 'devicectl', args: ['--version'], allowFailure: true },
    undefined,
  );
});
