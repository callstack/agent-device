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

const newInput = () => ({ ...recordingInput(), fence: { token: 'fence-2', generation: 3 } });

/**
 * One device marker the runtime can read, plus transport stubs that record every retirement side
 * effect in the order it happens. A test overrides only what its scenario is about.
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
    bind: async (overrides: Record<string, unknown>) =>
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

test('reconciles coherent completed evidence before output preparation or launch', async () => {
  const rig = evidenceRig(JSON.stringify(completedEvidence()));
  const runtime = await rig.bind({ inspect: async () => 'missing' });
  const started = await runtime.screenRecordingStart(newInput());
  expect(rig.calls).toEqual(retirementOf('/sdcard/agent-device-recording-1.mp4'));
  await started.pendingHandle.transfer().forceCleanup();
});

test('retires completed evidence whose recorder pid was reassigned, signaling nothing', async () => {
  const rig = evidenceRig(JSON.stringify(completedEvidence()));
  const runtime = await rig.bind({
    inspect: async () => 'ownership-lost',
    stop: async ({ pid }: { pid: string }) => {
      rig.calls.push(`signal:${pid}`);
      return 'already-missing' as const;
    },
  });
  const started = await runtime.screenRecordingStart(newInput());
  expect(rig.calls).toEqual(retirementOf('/sdcard/agent-device-recording-1.mp4'));
  await started.pendingHandle.transfer().forceCleanup();
});

test.each([
  ['an unconfirmed recorder identity', 'uncertain', 'native_recording_recorder_unproven'],
  ['a live recorder', 'owned-alive', 'native_recording_artifact_claimed'],
  ['a replacement recorder', 'foreign-writer', 'native_recording_artifact_claimed'],
])('refuses completed evidence named by %s', async (_name, ownership, reason) => {
  const rig = evidenceRig(JSON.stringify(completedEvidence()));
  const runtime = await rig.bind({
    inspect: async () => ownership,
    stop: async ({ pid }: { pid: string }) => {
      rig.calls.push(`signal:${pid}`);
      return 'already-missing' as const;
    },
  });
  await expect(runtime.screenRecordingStart(newInput())).rejects.toMatchObject({
    code: ownership === 'uncertain' ? 'COMMAND_FAILED' : 'DEVICE_IN_USE',
    details: { reason },
  });
  expect(rig.calls).toEqual([]);
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

test('retires evidence a re-adopted device identity stranded, before output preparation or launch', async () => {
  const rig = evidenceRig(strandedEvidence(openEvidence()));
  const runtime = await rig.bind({ inspect: async () => 'missing' });
  const started = await runtime.screenRecordingStart(newInput());
  expect(rig.calls).toEqual(retirementOf('/sdcard/agent-device-recording-1.mp4'));
  await started.pendingHandle.transfer().forceCleanup();
});

test('refuses stranded evidence whose recorder is still writing its artifact', async () => {
  const rig = evidenceRig(strandedEvidence(openEvidence()));
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
  const runtime = await rig.bind({
    findRunning: async () => [],
    inspect: async () => 'missing',
  });
  const started = await runtime.screenRecordingStart(newInput());
  expect(rig.calls).toEqual(retirementOf('/sdcard/agent-device-recording-9.mp4'));
  await started.pendingHandle.transfer().forceCleanup();
});

test('refuses a stranded interrupted launch whose artifact a recorder is still writing', async () => {
  const rig = evidenceRig(strandedEvidence(interruptedEvidence()));
  const runtime = await rig.bind({
    findRunning: async () => [{ pid: '88', remotePath: '/sdcard/x', startTime: '4' }],
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

test('retirement failure blocks launch and can succeed on a later retry', async () => {
  let allowRemoval = false;
  const rig = evidenceRig(JSON.stringify(completedEvidence()));
  const runtime = await rig.bind({
    inspect: async () => 'missing',
    remove: async () => allowRemoval,
    removeManifest: async () => {
      rig.clear();
      return true;
    },
  });
  await expect(runtime.screenRecordingStart(newInput())).rejects.toThrow('failed to remove');
  expect(rig.calls).toEqual([]);
  expect(rig.remains()).toBe(true);
  allowRemoval = true;
  const started = await runtime.screenRecordingStart(newInput());
  expect(rig.calls).toEqual(['prepare', 'launch']);
  await started.pendingHandle.transfer().forceCleanup();
});

test('requires manifest retirement confirmation after artifact cleanup', async () => {
  const rig = evidenceRig(JSON.stringify(completedEvidence()));
  const runtime = await rig.bind({
    inspect: async () => 'missing',
    removeManifest: async () => {
      rig.calls.push('manifest');
      return true;
    },
  });
  await expect(runtime.screenRecordingStart(newInput())).rejects.toThrow(
    'removal could not be confirmed',
  );
  expect(rig.calls).toEqual(['artifact:/sdcard/agent-device-recording-1.mp4', 'manifest']);
});

test.each([
  ['open', JSON.stringify(openEvidence())],
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
  const rig = evidenceRig(marker);
  const runtime = await rig.bind();
  await expect(runtime.screenRecordingStart(newInput())).rejects.toThrow(
    'native recovery evidence',
  );
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
  return createCompletedNativeManifest(openEvidence(), {
    backend: 'adb screenrecord',
    outPath: input.outputPath,
    startedAt: 1,
    completedAt: 2,
    scope: input.scope,
    showTouches: input.showTouches,
    recordOnlySession: input.recordOnlySession,
  });
}

function tamperCompletion(patch: Record<string, unknown>) {
  const evidence = completedEvidence();
  return { ...evidence, completion: { ...evidence.completion!, ...patch } };
}
