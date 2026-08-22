import { expect, test } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  androidRecordingDevice,
  recordingHost,
  recordingInput,
  recordingProcess,
} from './fixtures.ts';
import { createCompletedNativeManifest, createNativeManifest } from './manifest.ts';
import { bindAndroidScreenRecordingRuntime } from './runtime.ts';

const start = async (overrides: Record<string, unknown>) =>
  await bindAndroidScreenRecordingRuntime({
    host: recordingHost(overrides),
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal: new AbortController().signal,
  });
const newInput = () => ({ ...recordingInput(), fence: { token: 'fence-2', generation: 3 } });

test('reconciles coherent completed evidence before output preparation or launch', async () => {
  let marker = JSON.stringify(completedEvidence());
  const calls: string[] = [];
  const runtime = await start({
    readManifest: async (path: string) =>
      path.startsWith('/sdcard') && marker
        ? { status: 'read' as const, contents: marker }
        : { status: 'missing' as const },
    inspect: async () => 'missing' as const,
    remove: async (path: string) => {
      calls.push(`artifact:${path}`);
      return true;
    },
    removeManifest: async () => {
      calls.push('manifest');
      marker = '';
      return true;
    },
    outputs: {
      prepare: async () => {
        calls.push('prepare');
      },
    },
    start: async () => {
      calls.push('launch');
      return recordingProcess('77');
    },
  });
  const started = await runtime.screenRecordingStart(newInput());
  expect(calls).toEqual([
    'artifact:/sdcard/agent-device-recording-1.mp4',
    'manifest',
    'prepare',
    'launch',
  ]);
  await started.pendingHandle.transfer().forceCleanup();
});

test('retirement failure blocks launch and can succeed on a later retry', async () => {
  let marker = JSON.stringify(completedEvidence());
  let allowRemoval = false;
  const calls: string[] = [];
  const runtime = await start({
    readManifest: async (path: string) =>
      path.startsWith('/sdcard') && marker
        ? { status: 'read' as const, contents: marker }
        : { status: 'missing' as const },
    inspect: async () => 'missing' as const,
    remove: async () => allowRemoval,
    removeManifest: async () => {
      marker = '';
      return true;
    },
    outputs: {
      prepare: async () => {
        calls.push('prepare');
      },
    },
    start: async () => {
      calls.push('launch');
      return recordingProcess('77');
    },
  });
  await expect(runtime.screenRecordingStart(newInput())).rejects.toThrow('failed to remove');
  expect(calls).toEqual([]);
  expect(marker).not.toBe('');
  allowRemoval = true;
  const started = await runtime.screenRecordingStart(newInput());
  expect(calls).toEqual(['prepare', 'launch']);
  await started.pendingHandle.transfer().forceCleanup();
});

test('requires manifest retirement confirmation after artifact cleanup', async () => {
  const marker = JSON.stringify(completedEvidence());
  const calls: string[] = [];
  const runtime = await start({
    readManifest: async (path: string) =>
      path.startsWith('/sdcard')
        ? { status: 'read' as const, contents: marker }
        : { status: 'missing' as const },
    inspect: async () => 'missing' as const,
    remove: async () => {
      calls.push('artifact');
      return true;
    },
    removeManifest: async () => {
      calls.push('manifest');
      return true;
    },
    outputs: {
      prepare: async () => {
        calls.push('prepare');
      },
    },
    start: async () => {
      calls.push('launch');
      return recordingProcess('77');
    },
  });
  await expect(runtime.screenRecordingStart(newInput())).rejects.toThrow(
    'removal could not be confirmed',
  );
  expect(calls).toEqual(['artifact', 'manifest']);
});

test.each([
  [
    'open',
    JSON.stringify(
      createNativeManifest(
        androidRecordingDevice,
        recordingInput(),
        1,
        [
          {
            index: 1,
            remotePath: '/sdcard/agent-device-recording-1.mp4',
            remotePid: '41',
            remoteStartTime: '7',
          },
        ],
        undefined,
        'local',
      ),
    ),
  ],
  ['corrupt', '{broken'],
  ['wrong device', JSON.stringify({ ...completedEvidence(), deviceId: 'other-device' })],
  [
    'changed completion outPath',
    JSON.stringify(tamperCompletion({ outPath: '/tmp/unrelated.mp4' })),
  ],
  ['changed completion backend', JSON.stringify(tamperCompletion({ backend: 'other recorder' }))],
  ['changed completion startedAt', JSON.stringify(tamperCompletion({ startedAt: 9 }))],
  [
    'changed completion chunk path',
    JSON.stringify(tamperCompletion({ chunks: [{ index: 1, path: '/tmp/unrelated.mp4' }] })),
  ],
])('does not retire %s native evidence', async (_name, marker) => {
  const calls: string[] = [];
  const runtime = await start({
    readManifest: async (path: string) =>
      path.startsWith('/sdcard')
        ? { status: 'read' as const, contents: marker }
        : { status: 'missing' as const },
    remove: async () => {
      calls.push('artifact');
      return true;
    },
    removeManifest: async () => {
      calls.push('manifest');
      return true;
    },
    outputs: {
      prepare: async () => {
        calls.push('prepare');
      },
    },
    start: async () => {
      calls.push('launch');
      return recordingProcess('77');
    },
  });
  await expect(runtime.screenRecordingStart(newInput())).rejects.toThrow(
    'native recovery evidence',
  );
  expect(calls).toEqual([]);
});

function completedEvidence() {
  const input = recordingInput();
  return createCompletedNativeManifest(
    createNativeManifest(
      androidRecordingDevice,
      input,
      1,
      [
        {
          index: 1,
          remotePath: '/sdcard/agent-device-recording-1.mp4',
          remotePid: '41',
          remoteStartTime: '7',
        },
      ],
      undefined,
      'local',
    ),
    {
      backend: 'adb screenrecord',
      outPath: input.outputPath,
      startedAt: 1,
      completedAt: 2,
      scope: input.scope,
      showTouches: input.showTouches,
      recordOnlySession: input.recordOnlySession,
    },
  );
}

function tamperCompletion(patch: Record<string, unknown>) {
  const evidence = completedEvidence();
  return { ...evidence, completion: { ...evidence.completion!, ...patch } };
}
