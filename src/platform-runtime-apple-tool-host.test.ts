import { expect, test, vi } from 'vitest';
import {
  createLocalAppleToolProvider,
  type AppleToolProvider,
  withAppleToolProvider,
} from './platforms/apple/core/tool-provider.ts';
import { createAppleToolHost } from './platform-runtime-apple-tool-host.ts';

test('Apple tool host uses a full scoped provider when local xcrun is unavailable', async () => {
  const whichCommand = vi.fn(async () => true);
  const run = vi.fn(async () => ({ stdout: 'devices', stderr: '', exitCode: 0 }));
  const provider: AppleToolProvider = {
    runCommand: async () => {
      throw new Error('local command fallback is unavailable');
    },
    whichCommand,
    devicectl: { run },
  };
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

test('Apple tool host preserves the exact abort reason when the provider rejects differently', async () => {
  const reason = new Error('cancelled');
  const transportError = new Error('provider transport failed');
  const controller = new AbortController();
  const runCommand = vi.fn(async () => {
    controller.abort(reason);
    throw transportError;
  });
  const provider = createLocalAppleToolProvider({ runCommand });
  const host = createAppleToolHost();

  await withAppleToolProvider(provider, async () => {
    await expect(
      host.run({ tool: 'xctrace', args: ['list', 'devices'] }, controller.signal),
    ).rejects.toBe(reason);
  });
});

test('Apple tool availability preserves the exact abort reason when lookup rejects differently', async () => {
  const reason = new Error('cancelled');
  const transportError = new Error('provider lookup failed');
  const controller = new AbortController();
  const whichCommand = vi.fn(async () => {
    controller.abort(reason);
    throw transportError;
  });
  const provider = createLocalAppleToolProvider({ whichCommand });
  const host = createAppleToolHost();

  await withAppleToolProvider(provider, async () => {
    await expect(host.isXcrunAvailable(controller.signal)).rejects.toBe(reason);
  });
});
