import { expect, test, vi } from 'vitest';
import {
  createLocalAppleToolProvider,
  withAppleToolProvider,
} from './platforms/apple/core/tool-provider.ts';
import { createAppleToolHost } from './platform-runtime-apple-tool-host.ts';

test('Apple tool host forwards availability and execution to the request-scoped provider', async () => {
  const whichCommand = vi.fn(async () => true);
  const run = vi.fn(async () => ({ stdout: 'devices', stderr: '', exitCode: 0 }));
  const provider = createLocalAppleToolProvider({
    whichCommand,
    devicectl: { run },
  });
  const host = createAppleToolHost();
  const signal = new AbortController().signal;

  await withAppleToolProvider(provider, async () => {
    await expect(host.isXcrunAvailable(signal)).resolves.toBe(true);
    await expect(
      host.run(
        { tool: 'devicectl', args: ['list', 'devices'], allowFailure: true, timeoutMs: 42 },
        signal,
      ),
    ).resolves.toEqual({ stdout: 'devices', stderr: '', exitCode: 0 });
  });

  expect(whichCommand).toHaveBeenCalledWith('xcrun');
  expect(run).toHaveBeenCalledWith(['list', 'devices'], {
    allowFailure: true,
    signal,
    timeoutMs: 42,
  });
});

test('Apple tool host rejects pre-aborted requests before invoking the provider', async () => {
  const reason = new Error('cancelled');
  const controller = new AbortController();
  controller.abort(reason);
  const runCommand = vi.fn();
  const provider = createLocalAppleToolProvider({ runCommand });
  const host = createAppleToolHost();

  await withAppleToolProvider(provider, async () => {
    await expect(
      host.run({ tool: 'xctrace', args: ['list', 'devices'] }, controller.signal),
    ).rejects.toBe(reason);
  });
  expect(runCommand).not.toHaveBeenCalled();
});
