import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { isScreenRecordingStartNotDispatched } from '@agent-device/contracts/screen-recording-runtime';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { androidRecordingDevice, recordingHost, recordingInput } from './fixtures.ts';
import { createNativeManifest } from './manifest.ts';
import { recordingArtifactPath, recordingMarkerPath } from './native-path.ts';
import { bindAndroidScreenRecordingRuntime } from './runtime.ts';

const input = { ...recordingInput(), claimToken: 'claim-token' };
const generation = {
  deviceId: androidRecordingDevice.id,
  sessionId: input.sessionId,
  fence: input.fence,
  claimToken: input.claimToken,
};
const pending = recordingArtifactPath('/sdcard', generation, 1);
const markerPath = recordingMarkerPath('/sdcard', generation);
const recovery = { sessionId: input.sessionId, fence: input.fence, claimToken: input.claimToken };

const bind = async (overrides: Record<string, unknown>) =>
  await bindAndroidScreenRecordingRuntime({
    host: recordingHost(overrides),
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal: new AbortController().signal,
  });

test.each(['/sdcard', '/data/local/tmp'])(
  'retains every legacy shared marker in %s without touching its artifact',
  async (directory) => {
    const legacyPath = `${directory}/agent-device-recording-active.json`;
    const bytes = '{"version":1,"pendingRemotePath":"legacy-artifact"}';
    const effects: string[] = [];
    const runtime = await bind({
      forceLegacy: true,
      readManifest: async (path: string) =>
        path === legacyPath
          ? { status: 'read' as const, contents: bytes }
          : { status: 'missing' as const },
      remove: async () => {
        effects.push('remove');
        return true;
      },
      stop: async () => {
        effects.push('signal');
        return 'stopped' as const;
      },
      writeManifest: async () => {
        effects.push('write');
      },
      outputs: {
        prepare: async () => {
          effects.push('prepare');
        },
      },
    });
    const error = await runtime.screenRecordingStart(input).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'DEVICE_IN_USE',
      details: { reason: 'legacy_native_recording_evidence_unproven' },
    });
    expect(isScreenRecordingStartNotDispatched(error)).toBe(true);
    expect(effects).toEqual([]);
    expect(await runtime.recoverIncompleteRecordingStart(recovery)).toBe('retained');
  },
);

test('retains an unreadable legacy marker without dispatching or claiming no effect', async () => {
  const runtime = await bind({
    readManifest: async () => ({ status: 'unavailable' as const, message: 'offline' }),
  });
  const error = await runtime.screenRecordingStart(input).catch((error: unknown) => error);
  expect(error).toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'native_recovery_evidence_unavailable' },
  });
  expect(isScreenRecordingStartNotDispatched(error)).toBe(true);
});

test('cancels only an exact armed generation after writer and artifact proof', async () => {
  let marker = JSON.stringify({
    ...createNativeManifest(androidRecordingDevice, input, 1, [], pending),
    launchDisposition: 'armed',
  });
  let writers = true;
  let exists = false;
  const signals: string[] = [];
  const runtime = await bind({
    readManifest: async (path: string) =>
      path === markerPath && marker
        ? { status: 'read' as const, contents: marker }
        : { status: 'missing' as const },
    writeManifest: async ({ contents }: { contents: string }) => {
      marker = contents;
    },
    releaseAdmission: async () => 'released' as const,
    findRunning: async () => (writers ? ['42'] : []),
    exists: async () => exists,
    stop: async ({ pid }: { pid: string }) => {
      signals.push(pid);
      return 'stopped' as const;
    },
  });
  expect(
    await runtime.recoverIncompleteRecordingStart({ ...recovery, claimToken: 'foreign' }),
  ).toBe('retained');
  expect(await runtime.recoverIncompleteRecordingStart(recovery)).toBe('retained');
  writers = false;
  exists = true;
  expect(await runtime.recoverIncompleteRecordingStart(recovery)).toBe('retained');
  exists = false;
  expect(await runtime.recoverIncompleteRecordingStart(recovery)).toBe('confirmed-no-effect');
  expect(JSON.parse(marker)).toMatchObject({
    launchDisposition: 'canceled',
    startNoEffectConfirmed: true,
  });
  expect(await runtime.recoverIncompleteRecordingStart(recovery)).toBe('confirmed-no-effect');
  expect(signals).toEqual([]);
});

test('retains admitted and older evidence even when no writer is visible', async () => {
  const evidence = createNativeManifest(androidRecordingDevice, input, 1, [], pending);
  let marker = JSON.stringify({ ...evidence, launchDisposition: 'admitted' });
  const runtime = await bind({
    readManifest: async (path: string) =>
      path === markerPath
        ? { status: 'read' as const, contents: marker }
        : { status: 'missing' as const },
    writeManifest: async ({ contents }: { contents: string }) => {
      marker = contents;
    },
    findRunning: async () => [],
    exists: async () => false,
  });
  const before = marker;
  expect(await runtime.recoverIncompleteRecordingStart(recovery)).toBe('retained');
  expect(marker).toBe(before);
  for (const version of [1, 2]) {
    marker = JSON.stringify({ ...evidence, version, launchDisposition: 'armed' });
    expect(await runtime.recoverIncompleteRecordingStart(recovery)).toBe('retained');
  }
});

test('preserves a typed device refusal raised before dispatch', async () => {
  const refusal = new AppError('DEVICE_IN_USE', 'device owned', { reason: 'typed-device-owner' });
  const runtime = await bind({
    readManifest: async () => {
      throw refusal;
    },
  });
  const error = await runtime.screenRecordingStart(input).catch((error: unknown) => error);
  expect(error).toBe(refusal);
  expect(error).toMatchObject({ code: 'DEVICE_IN_USE', details: { reason: 'typed-device-owner' } });
  expect(isScreenRecordingStartNotDispatched(error)).toBe(true);
});
