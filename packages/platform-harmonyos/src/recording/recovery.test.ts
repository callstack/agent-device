import { expect, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createHarmonyScreenRecordingOperations } from './runtime.ts';
import {
  harmonyCommandSuccess,
  harmonyDevice,
  harmonyRecordingHost,
  harmonyRecordingInput,
} from './runtime.fixtures.ts';

test('rejects incoherent recovery paths before stop or removal', async () => {
  const stop = vi.fn(async () => harmonyCommandSuccess());
  const remove = vi.fn(async () => true);
  const operations = createHarmonyScreenRecordingOperations({
    host: harmonyRecordingHost({ stop, remove }),
    device: harmonyDevice,
    owner: localRuntimeOwner('harmonyos'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart(harmonyRecordingInput());
  stop.mockClear();
  remove.mockClear();
  const corruptEnvelope = {
    ...started.envelope,
    descriptor: {
      ...started.envelope.descriptor,
      body: {
        ...started.envelope.descriptor.body,
        remotePath: '/data/local/tmp/unrelated.mp4',
      },
    },
  };

  await expect(
    operations.screenRecordingCleanup({ envelope: corruptEnvelope }),
  ).resolves.toMatchObject({ status: 'cleanup-pending' });
  expect(stop).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

test('recreated cleanup never stops or removes an unproven recorder', async () => {
  const stop = vi.fn(async () => harmonyCommandSuccess());
  const remove = vi.fn(async () => true);
  const removeMedia = vi.fn(async () => true);
  const operations = createHarmonyScreenRecordingOperations({
    host: harmonyRecordingHost({ stop, remove, removeMedia }),
    device: harmonyDevice,
    owner: localRuntimeOwner('harmonyos'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart(harmonyRecordingInput());
  stop.mockClear();
  remove.mockClear();
  removeMedia.mockClear();

  await expect(
    operations.screenRecordingCleanup({ envelope: started.envelope }),
  ).resolves.toMatchObject({ status: 'cleanup-pending' });
  expect(stop).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(removeMedia).not.toHaveBeenCalled();
});
