import { expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { bindTvRemote, tvRemoteRuntimeOperationFacts } from './tv-remote-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource } from './interactor-operation-binding.ts';

const device = {
  platform: 'vega',
  id: 'vega-vvd',
  name: 'Vega VVD',
  kind: 'emulator',
  booted: true,
} as const;

test('builds the exact tv-remote operation fact catalog', () => {
  const tvRemote = { available: true } as const;
  expect(tvRemoteRuntimeOperationFacts({ tvRemote })).toEqual({ tvRemote });
});

test('a local binding drives the interactor with the button and duration', async () => {
  const tvRemote = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ tvRemote }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindTvRemote(signal, localInteractorSource({ device, resolveInteractor }));
  await operations.tvRemote({
    button: 'down',
    durationMs: 250,
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'tv-remote-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'tv-remote-1',
    appBundleId: 'com.example.app',
    signal,
  });
  // Positional (button, durationMs), not an object: swapping the argument order or dropping
  // durationMs is the one transposition a point-shaped assertion would not catch.
  expect(tvRemote).toHaveBeenCalledWith('down', 250);
});

// Facts admitted the press, so an interactor without the member is an ownership bug the caller
// must see rather than a refusal to degrade around. The label is the one the command used.
test('a press whose fact admitted but whose interactor cannot serve it fails closed', async () => {
  const resolveInteractor = vi.fn(async () => ({}) as unknown as Interactor);

  const operations = bindTvRemote(new AbortController().signal, localInteractorSource({ device, resolveInteractor }));
  await expect(operations.tvRemote({ button: 'up' })).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      error.details?.['reason'] === 'interactor-method-missing' &&
      error.message.includes('tv-remote'),
  );
});
