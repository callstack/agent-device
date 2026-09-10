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

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

const local = (resolveInteractor: LocalInteractorOperationResolver) =>
  localInteractorSource({ device, resolveInteractor });

test('builds the exact clipboard operation fact catalog for an owner that names both halves', () => {
  const read = { available: true } as const;
  const write = {
    available: false,
    reason: 'owner-capability-missing',
  } as const;
  expect(
    clipboardRuntimeOperationFacts({
      unsupported: write,
      read,
      write,
    }),
  ).toEqual({
    readClipboard: read,
    writeClipboard: write,
  });
});

test('a half the owner never names reports the denial the owner stated for the family, verbatim — omission is a classified refusal, never an unclassified half and never an implied success', () => {
  const denial = {
    available: false,
    reason: 'unsupported-platform-leaf',
    hint: 'clipboard is not supported on Vega OS.',
  } as const;

  expect(
    clipboardRuntimeOperationFacts({ unsupported: denial, read: { available: true } }),
  ).toEqual({
    readClipboard: { available: true },
    writeClipboard: denial,
  });
});

test('an owner serving neither clipboard half names the family denial once and still answers with the exhaustive shape', () => {
  const denial = { available: false, reason: 'unsupported-platform-leaf' } as const;

  const facts = clipboardRuntimeOperationFacts({ unsupported: denial });

  expect(facts).toEqual({
    readClipboard: denial,
    writeClipboard: denial,
  });
  expect(Object.isFrozen(facts)).toBe(true);
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
