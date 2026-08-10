import { expect, test, vi } from 'vitest';
import { checkCoreDeviceConsoleCaptureSupport } from './coredevice-console.ts';
import { hostFixture } from './runtime.fixtures.ts';

test('CoreDevice support uses the exact focused devicectl help probe', async () => {
  const run = vi.fn(async () => ({
    stdout: 'USAGE: devicectl device process launch --console --terminate-existing',
    stderr: '',
    exitCode: 0,
  }));
  const fixture = hostFixture({ appleToolRun: run });
  const signal = new AbortController().signal;

  await expect(checkCoreDeviceConsoleCaptureSupport(fixture.host, signal)).resolves.toEqual({
    supported: true,
  });
  expect(run).toHaveBeenCalledWith(
    {
      tool: 'devicectl',
      args: ['device', 'process', 'launch', '--help'],
      allowFailure: true,
      timeoutMs: 5_000,
    },
    signal,
  );
});

test('CoreDevice support preserves the exact Apple-tool cancellation reason', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  const fixture = hostFixture({
    appleToolRun: async () => {
      controller.abort(reason);
      throw reason;
    },
  });

  await expect(checkCoreDeviceConsoleCaptureSupport(fixture.host, controller.signal)).rejects.toBe(
    reason,
  );
});
