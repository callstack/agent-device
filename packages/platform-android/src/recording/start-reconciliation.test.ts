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

test('retires completed evidence whose recorder pid was reassigned, signaling nothing', async () => {
  let marker = JSON.stringify(completedEvidence());
  const calls: string[] = [];
  const runtime = await start({
    readManifest: async (path: string) =>
      path.startsWith('/sdcard') && marker
        ? { status: 'read' as const, contents: marker }
        : { status: 'missing' as const },
    inspect: async () => 'ownership-lost' as const,
    stop: async ({ pid }: { pid: string }) => {
      calls.push(`signal:${pid}`);
      return 'already-missing' as const;
    },
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

test.each([
  ['an unconfirmed recorder identity', 'uncertain', 'cannot be safely retired'],
  ['a live recorder', 'owned-alive', 'its recorder is writing'],
])('refuses completed evidence named by %s', async (_name, ownership, message) => {
  const marker = JSON.stringify(completedEvidence());
  const calls: string[] = [];
  const runtime = await start({
    readManifest: async (path: string) =>
      path.startsWith('/sdcard')
        ? { status: 'read' as const, contents: marker }
        : { status: 'missing' as const },
    inspect: async () => ownership,
    stop: async ({ pid }: { pid: string }) => {
      calls.push(`signal:${pid}`);
      return 'already-missing' as const;
    },
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
  await expect(runtime.screenRecordingStart(newInput())).rejects.toThrow(message);
  expect(calls).toEqual([]);
});

test('retains completed evidence and its marker while a replacement recorder writes the same path', async () => {
  const marker = JSON.stringify(completedEvidence());
  const calls: string[] = [];
  const runtime = await start({
    readManifest: async (path: string) =>
      path.startsWith('/sdcard')
        ? { status: 'read' as const, contents: marker }
        : { status: 'missing' as const },
    inspect: async () => 'foreign-writer' as const,
    stop: async ({ pid }: { pid: string }) => {
      calls.push(`signal:${pid}`);
      return 'already-missing' as const;
    },
    remove: async (path: string) => {
      calls.push(`artifact:${path}`);
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
    'another recorder is writing',
  );
  expect(calls).toEqual([]);
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

/**
 * One marker the runtime can read, plus transport stubs that record every retirement side effect in
 * the order it happens. New scenarios name only the probe outcome they are about; the scenarios
 * above build their transport inline.
 */
function evidenceRig(marker: string, directory = '/sdcard') {
  let contents = marker;
  const calls: string[] = [];
  const transport: Record<string, unknown> = {
    readManifest: async (path: string) =>
      path.startsWith(directory) && contents
        ? { status: 'read' as const, contents }
        : { status: 'missing' as const },
    remove: async (remotePath: string) => {
      calls.push(`artifact:${remotePath}`);
      return true;
    },
    removeManifest: async () => {
      calls.push('manifest');
      contents = '';
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
  };
  return {
    calls,
    remains: () => contents !== '',
    clear: () => {
      contents = '';
    },
    bind: async (overrides: Record<string, unknown> = {}) =>
      await bindAndroidScreenRecordingRuntime({
        host: recordingHost({ ...transport, ...overrides }),
        device: androidRecordingDevice,
        owner: localRuntimeOwner('android'),
        signal: new AbortController().signal,
      }),
  };
}

const retirementOf = (remotePath: string) => [
  `artifact:${remotePath}`,
  'manifest',
  'prepare',
  'launch',
];

test('retires evidence a re-adopted device identity stranded, before output preparation or launch', async () => {
  const rig = evidenceRig(strandedEvidence(completedEvidence()));
  const runtime = await rig.bind({ inspect: async () => 'missing' });
  const started = await runtime.screenRecordingStart(newInput());
  expect(rig.calls).toEqual(retirementOf('/sdcard/agent-device-recording-1.mp4'));
  await started.pendingHandle.transfer().forceCleanup();
});

test('retains open evidence from this device identity even after its recorder is gone', async () => {
  const rig = evidenceRig(JSON.stringify(openEvidence()));
  const runtime = await rig.bind({ inspect: async () => 'missing' });
  await expect(runtime.screenRecordingStart(newInput())).rejects.toMatchObject({
    code: 'DEVICE_IN_USE',
    details: { reason: 'native_recovery_evidence_open', sessionId: 'one', retriable: false },
  });
  expect(rig.calls).toEqual([]);
});

test('refuses stranded evidence whose recorder is still writing its artifact', async () => {
  const rig = evidenceRig(strandedEvidence(completedEvidence()));
  const runtime = await rig.bind({ inspect: async () => 'owned-alive' });
  await expect(runtime.screenRecordingStart(newInput())).rejects.toMatchObject({
    code: 'DEVICE_IN_USE',
    details: {
      reason: 'native_recording_artifact_claimed',
      writer: 'named-recorder',
      retriable: false,
    },
  });
  expect(rig.calls).toEqual([]);
});

test('retires a stranded interrupted launch and drops the artifact it never committed', async () => {
  const rig = evidenceRig(strandedEvidence(interruptedEvidence()));
  const runtime = await rig.bind({ findRunning: async () => [] });
  const started = await runtime.screenRecordingStart(newInput());
  expect(rig.calls).toEqual(retirementOf('/sdcard/agent-device-recording-9.mp4'));
  await started.pendingHandle.transfer().forceCleanup();
});

test('refuses a stranded interrupted launch whose artifact a recorder is still writing', async () => {
  const rig = evidenceRig(strandedEvidence(interruptedEvidence()));
  const runtime = await rig.bind({
    findRunning: async () => ({
      writers: [{ pid: '88', remotePath: '/sdcard/x', startTime: '4' }],
      conclusive: true,
    }),
  });
  await expect(runtime.screenRecordingStart(newInput())).rejects.toMatchObject({
    code: 'DEVICE_IN_USE',
    details: { reason: 'native_recording_artifact_claimed', writer: 'other-recorder' },
  });
  expect(rig.calls).toEqual([]);
});

test('refuses a stranded interrupted launch whose writers cannot be read', async () => {
  const rig = evidenceRig(strandedEvidence(interruptedEvidence()));
  const runtime = await rig.bind({
    findRunning: async () => ({ writers: [], conclusive: false }),
  });
  await expect(runtime.screenRecordingStart(newInput())).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      reason: 'native_recording_recorder_unproven',
      remotePath: '/sdcard/agent-device-recording-9.mp4',
    },
  });
  expect(rig.calls).toEqual([]);
});

test('retires stranded evidence parked in the fallback directory', async () => {
  const rig = evidenceRig(
    strandedEvidence({
      ...openEvidence(),
      chunks: [
        {
          index: 1,
          remotePath: '/data/local/tmp/agent-device-recording-1.mp4',
          remotePid: '41',
          remoteStartTime: '7',
        },
      ],
    }),
    '/data/local/tmp',
  );
  const runtime = await rig.bind({ inspect: async () => 'missing' });
  const started = await runtime.screenRecordingStart(newInput());
  expect(rig.calls).toEqual(retirementOf('/data/local/tmp/agent-device-recording-1.mp4'));
  await started.pendingHandle.transfer().forceCleanup();
});

test('refuses evidence a different transport mode wrote', async () => {
  const rig = evidenceRig(
    JSON.stringify({ ...openEvidence(), transportMode: 'transport-composed' }),
  );
  const runtime = await rig.bind();
  await expect(runtime.screenRecordingStart(newInput())).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'native_recovery_evidence_transport_mismatch' },
  });
  expect(rig.calls).toEqual([]);
});

function openEvidence() {
  return createNativeManifest(
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
  );
}

function interruptedEvidence() {
  return createNativeManifest(
    androidRecordingDevice,
    recordingInput(),
    1,
    [],
    '/sdcard/agent-device-recording-9.mp4',
    'local',
  );
}

function strandedEvidence(evidence: object) {
  return JSON.stringify({ ...evidence, deviceId: 'emulator-5556' });
}

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
