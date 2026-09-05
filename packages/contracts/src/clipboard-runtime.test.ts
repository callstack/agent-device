import { expect, test, vi } from 'vitest';
import {
  bindClipboardRead,
  bindClipboardWrite,
  clipboardRuntimeOperationFacts,
} from './clipboard-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import {
  localInteractorSource,
  type LocalInteractorOperationResolver,
} from './interactor-operation-binding.ts';
import { conformInteractorOperations } from './interactor-operation-conformance.fixtures.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

const local = (resolveInteractor: LocalInteractorOperationResolver) =>
  localInteractorSource({ device, resolveInteractor });

test('builds the exact clipboard operation fact catalog', () => {
  const read = { available: true } as const;
  const write = { available: false, reason: 'owner-capability-missing' } as const;
  expect(clipboardRuntimeOperationFacts({ read, write })).toEqual({
    readClipboard: read,
    writeClipboard: write,
  });
});

test('a local read binding returns the interactor pasteboard text verbatim', async () => {
  const readClipboard = vi.fn(async () => 'copied\ntext');
  const resolveInteractor = vi.fn(async () => ({ readClipboard }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindClipboardRead(signal, local(resolveInteractor));
  await expect(
    operations.readClipboard({
      options: { appBundleId: 'com.example.app' },
      execution: { logPath: '/tmp/daemon.log', requestId: 'clipboard-1' },
    }),
  ).resolves.toBe('copied\ntext');

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'clipboard-1',
    appBundleId: 'com.example.app',
    signal,
  });
});

test('a local write binding hands the interactor the already-joined text', async () => {
  const writeClipboard = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ writeClipboard }) as unknown as Interactor);

  const operations = bindClipboardWrite(new AbortController().signal, local(resolveInteractor));
  await operations.writeClipboard({ text: 'hello world' });

  expect(writeClipboard).toHaveBeenCalledWith('hello world');
});

conformInteractorOperations({
  device,
  rows: [
    {
      operation: 'readClipboard',
      label: 'clipboard read',
      bind: bindClipboardRead,
      method: 'readClipboard',
      input: {},
    },
    {
      operation: 'writeClipboard',
      label: 'clipboard write',
      bind: bindClipboardWrite,
      method: 'writeClipboard',
      input: { text: '' },
    },
  ],
});
