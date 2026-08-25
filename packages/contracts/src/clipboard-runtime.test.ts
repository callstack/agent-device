import { expect, test, vi } from 'vitest';
import {
  bindClipboardRead,
  bindClipboardWrite,
  clipboardRuntimeOperationFacts,
} from './clipboard-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource, providerInteractorSource } from './interactor-operation-binding.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

// The composition the interactor catalog performs, spelled out so each assertion below
// still exercises one facet executor reached through one interactor source.
const bindLocalClipboardReadInteractor = (params: {
  device: typeof device;
  signal: AbortSignal;
  resolveInteractor: any;
}) => bindClipboardRead(params.signal, localInteractorSource(params));
const bindLocalClipboardWriteInteractor = (params: {
  device: typeof device;
  signal: AbortSignal;
  resolveInteractor: any;
}) => bindClipboardWrite(params.signal, localInteractorSource(params));
const bindProviderClipboardReadInteractor = (params: {
  device: typeof device;
  signal: AbortSignal;
  resolveInteractor: any;
}) =>
  bindClipboardRead(
    params.signal,
    providerInteractorSource({ ...params, operation: 'clipboard read' }),
  );
const bindProviderClipboardWriteInteractor = (params: {
  device: typeof device;
  signal: AbortSignal;
  resolveInteractor: any;
}) =>
  bindClipboardWrite(
    params.signal,
    providerInteractorSource({ ...params, operation: 'clipboard write' }),
  );

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

  const operations = bindLocalClipboardReadInteractor({ device, signal, resolveInteractor });
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

  const operations = bindLocalClipboardWriteInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor,
  });
  await operations.writeClipboard({ text: 'hello world' });

  expect(writeClipboard).toHaveBeenCalledWith('hello world');
});

test('a provider binding drives its own resolved interactor', async () => {
  const readClipboard = vi.fn(async () => 'provider text');
  const resolveInteractor = vi.fn(() => ({ readClipboard }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindProviderClipboardReadInteractor({ device, signal, resolveInteractor });
  await expect(operations.readClipboard({ execution: { requestId: 'clipboard-2' } })).resolves.toBe(
    'provider text',
  );

  expect(resolveInteractor).toHaveBeenCalledWith({
    requestId: 'clipboard-2',
    appBundleId: undefined,
    signal,
  });
});

test.each([
  { half: 'read', bind: bindProviderClipboardReadInteractor },
  { half: 'write', bind: bindProviderClipboardWriteInteractor },
])('a provider $half binding fails closed with no owner interactor', async ({ bind }) => {
  const operations = bind({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
  });

  const invoke =
    'readClipboard' in operations
      ? operations.readClipboard({})
      : operations.writeClipboard({ text: '' });
  await expect(invoke).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
  });
});

test('an already-cancelled request never resolves an interactor', async () => {
  const controller = new AbortController();
  controller.abort();
  const readClipboard = vi.fn(async () => '');
  const resolveInteractor = vi.fn(async () => ({ readClipboard }) as unknown as Interactor);

  const operations = bindLocalClipboardReadInteractor({
    device,
    signal: controller.signal,
    resolveInteractor,
  });

  await expect(operations.readClipboard({})).rejects.toThrow();
  expect(resolveInteractor).not.toHaveBeenCalled();
  expect(readClipboard).not.toHaveBeenCalled();
});
