import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform';
import { createHarmonyScreenRecordingOperations, harmonyScreenRecordingFacts } from './runtime.ts';
import {
  harmonyCommandSuccess as success,
  harmonyDevice as device,
  harmonyRecordingHost as harmonyHost,
  harmonyRecordingInput as input,
} from './runtime.fixtures.ts';

test('runs whole-screen capture and finalizes through the closed Harmony host', async () => {
  const operations = createHarmonyScreenRecordingOperations({
    host: harmonyHost(),
    device,
    owner: localRuntimeOwner('harmonyos'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart({
    sessionId: 'one',
    outputPath: '/tmp/harmony.mp4',
    scope: 'device',
    showTouches: true,
    hideTouchesRequested: false,
    recordOnlySession: false,
    fence: { token: 'fence', generation: 1 },
  });
  await assert.doesNotReject(async () => await started.pendingHandle.transfer().finish());
});

test('keeps HarmonyOS recording physical-device-only', () => {
  assert.deepEqual(harmonyScreenRecordingFacts({ ...device, kind: 'emulator' }), {
    available: false,
    reason: 'unsupported-device-kind',
    hint: 'HarmonyOS recording is supported on physical devices only.',
  });
});

test.each([
  [{ scope: 'app' as const }, 'HarmonyOS recording captures the whole physical-device screen'],
  [{ fps: 30 }, 'HarmonyOS recordings do not support --fps'],
  [{ exportQuality: 'high' as const }, 'HarmonyOS recordings do not support --quality'],
  [{ hideTouchesRequested: true }, 'HarmonyOS recordings do not support --hide-touches'],
])(
  'rejects unsupported HarmonyOS recording option %# before starting',
  async (override, message) => {
    const start = async () => {
      throw new Error('must not start');
    };
    const operations = createHarmonyScreenRecordingOperations({
      host: harmonyHost({ start }),
      device,
      owner: localRuntimeOwner('harmonyos'),
      signal: new AbortController().signal,
    });
    await expect(
      operations.screenRecordingStart({
        sessionId: 'one',
        outputPath: '/tmp/harmony.mp4',
        scope: 'device',
        showTouches: true,
        hideTouchesRequested: false,
        recordOnlySession: false,
        fence: { token: 'fence', generation: 1 },
        ...override,
      }),
    ).rejects.toThrow(message);
  },
);

test('forced cleanup stops the recorder and removes exact media before reporting cleaned', async () => {
  const calls: string[] = [];
  const operations = createHarmonyScreenRecordingOperations({
    host: harmonyHost({
      stop: async () => {
        calls.push('stop');
        return success();
      },
      remove: async () => {
        calls.push('remove');
        return true;
      },
      findMedia: async () => {
        calls.push('findMedia');
        return 'file://media/video';
      },
      removeMedia: async () => {
        calls.push('removeMedia');
        return true;
      },
    }),
    device,
    owner: localRuntimeOwner('harmonyos'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart(input());
  await expect(started.pendingHandle.transfer().forceCleanup()).resolves.toEqual({
    status: 'cleaned',
  });
  expect(calls).toEqual(['stop', 'remove', 'findMedia', 'removeMedia']);

  calls.length = 0;
  await expect(
    operations.screenRecordingCleanup({ envelope: started.envelope }),
  ).resolves.toMatchObject({
    status: 'cleanup-pending',
    reason: 'manual-recovery-required',
  });
  expect(calls).toEqual([]);
});

test('stop failure keeps Harmony cleanup pending', async () => {
  const operations = createHarmonyScreenRecordingOperations({
    host: harmonyHost({
      stop: async () => ({ stdout: 'ability failed', stderr: '', exitCode: 0 }),
    }),
    device,
    owner: localRuntimeOwner('harmonyos'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart(input());

  await expect(started.pendingHandle.transfer().forceCleanup()).resolves.toMatchObject({
    status: 'cleanup-pending',
    reason: 'transport-failed',
  });
});

test.each([
  ['staging artifact', false, true],
  ['media artifact', true, false],
] as const)(
  'keeps cleanup pending when %s deletion is not confirmed',
  async (_label, removeStaging, removeMedia) => {
    const operations = createHarmonyScreenRecordingOperations({
      host: harmonyHost({
        remove: async () => removeStaging,
        findMedia: async () => 'file://media/video',
        removeMedia: async () => removeMedia,
      }),
      device,
      owner: localRuntimeOwner('harmonyos'),
      signal: new AbortController().signal,
    });
    const started = await operations.screenRecordingStart(input());

    await expect(started.pendingHandle.transfer().forceCleanup()).resolves.toMatchObject({
      status: 'cleanup-pending',
      reason: 'transport-failed',
    });
  },
);

test('retries zero-byte Harmony staging and retains media when finalization fails', async () => {
  let sizeReads = 0;
  const sizes = [0, 0, 12, 12] as const;
  const removeMedia = vi.fn(async () => true);
  const stageMedia = vi.fn(async () => true);
  const operations = createHarmonyScreenRecordingOperations({
    host: harmonyHost({
      stageMedia,
      stagedFileSize: async () => sizes[sizeReads++] ?? 12,
      removeMedia,
      complete: async () => {
        throw new Error('unplayable output');
      },
    }),
    device,
    owner: localRuntimeOwner('harmonyos'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart(input());

  await expect(started.pendingHandle.transfer().finish()).rejects.toThrow('unplayable output');
  expect(stageMedia).toHaveBeenCalledTimes(4);
  expect(removeMedia).not.toHaveBeenCalled();
});

test('compensates finalizer failure without stopping the native recorder twice', async () => {
  const stop = vi.fn(async () => success());
  const removeMedia = vi.fn(async () => true);
  const operations = createHarmonyScreenRecordingOperations({
    host: harmonyHost({
      stop,
      findMedia: async () => 'file://media/video',
      stagedFileSize: async () => 12,
      removeMedia,
      complete: async () => {
        throw new Error('finalizer failed after Harmony stop');
      },
    }),
    device,
    owner: localRuntimeOwner('harmonyos'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart(input());
  const handle = started.pendingHandle.transfer();

  await expect(handle.finish()).rejects.toThrow('finalizer failed after Harmony stop');
  await expect(handle.forceCleanup()).resolves.toEqual({ status: 'cleaned' });
  expect(stop).toHaveBeenCalledOnce();
  expect(removeMedia).toHaveBeenCalledOnce();
});

test('cancellation after Harmony acquisition stops the recorder and preserves its reason', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel Harmony acquisition');
  const stop = vi.fn(async () => success());
  const operations = createHarmonyScreenRecordingOperations({
    host: harmonyHost({
      start: async () => {
        controller.abort(reason);
        return success();
      },
      stop,
    }),
    device,
    owner: localRuntimeOwner('harmonyos'),
    signal: controller.signal,
  });

  await expect(operations.screenRecordingStart(input())).rejects.toBe(reason);
  expect(stop).toHaveBeenCalledOnce();
});

test('Harmony start rejection after cancellation preserves the exact reason', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled during HDC start');
  const operations = createHarmonyScreenRecordingOperations({
    host: harmonyHost({
      start: async () => {
        controller.abort(reason);
        throw new Error('different transport rejection');
      },
    }),
    device,
    owner: localRuntimeOwner('harmonyos'),
    signal: controller.signal,
  });

  await expect(operations.screenRecordingStart(input())).rejects.toBe(reason);
});

test('invalid Harmony options leave an existing output untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-harmony-output-'));
  const outputPath = path.join(root, 'capture.mp4');
  fs.writeFileSync(outputPath, 'keep me');
  const prepare = vi.fn(async (pathname: string) => fs.rmSync(pathname, { force: true }));
  const operations = createHarmonyScreenRecordingOperations({
    host: harmonyHost({ prepare }),
    device,
    owner: localRuntimeOwner('harmonyos'),
    signal: new AbortController().signal,
  });

  await expect(
    operations.screenRecordingStart({ ...input(), outputPath, fps: 30 }),
  ).rejects.toThrow('HarmonyOS recordings do not support --fps');
  expect(prepare).not.toHaveBeenCalled();
  expect(fs.readFileSync(outputPath, 'utf8')).toBe('keep me');
});
