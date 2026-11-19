import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  createDurableResourceEnvelope,
  createHostAudioProbeCaptureOperations,
} from '@agent-device/capture-kit';
import { audioProbeDurableResource } from '@agent-device/capture-kit/audio-probe-session-resource';
import { perfCaptureDurableResource } from '@agent-device/capture-kit/perf-capture-session-resource';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { deviceIdentity } from '@agent-device/kernel/device';
import { IOS_SIMULATOR, mkdtempForTestSync } from '@agent-device/test-kit';
import {
  inspectManagedProcess,
  terminateManagedProcessSet,
} from './platform-runtime-screen-recording-process-host.ts';
import {
  cleanupApplePerfCaptureDescriptor,
  inspectApplePerfCaptureDescriptor,
} from './platform-runtime-perf-capture-host.ts';

vi.mock('@agent-device/host-kit/process', async (original) => ({
  ...(await original<typeof import('@agent-device/host-kit/process')>()),
  isProcessAlive: () => true,
  readProcessIdentityFacts: async () => ({
    startTime: 'posix:2000',
    command: 'recorder',
    zombie: false,
  }),
}));

const marker = { pid: 4242, startTime: 'legacy start time', command: 'recorder' };
const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};
const owner = localRuntimeOwner('apple');
const sessionsDir = mkdtempForTestSync('unprovable-capture-');
const sessionDir = path.join(sessionsDir, 'session');
fs.mkdirSync(sessionDir, { recursive: true });
const common = {
  sessionId: 'session',
  device: deviceIdentity(IOS_SIMULATOR),
  owner,
  fence: { token: 'fence', generation: 1 },
  lifecycle: 'open' as const,
};

test('perf reattach retains a live process with unprovable identity', async () => {
  const envelope = createDurableResourceEnvelope({
    ...common,
    resourceKind: 'perf-capture',
    descriptor: {
      version: 1,
      body: {
        family: 'apple',
        marker,
        capture: {
          kind: 'xctrace',
          mode: 'cpu-profile',
          template: 'Time Profiler',
          outPath: '/tmp/capture.trace',
          appBundleId: 'com.example.app',
          deviceId: IOS_SIMULATOR.id,
          platform: 'ios',
          targetPids: [42],
          targetProcesses: ['com.example.app'],
          startedAt: '2026-10-02T09:00:00.000Z',
        },
      },
    },
  });
  const store = perfCaptureDurableResource.store;
  const resourcePath = store.resolvePath(sessionDir);
  store.write(resourcePath, envelope);
  expect(await inspectManagedProcess(marker)).toBe('unprovable');
  expect(await inspectApplePerfCaptureDescriptor(envelope)).toEqual({
    status: 'unreattachable',
    reason: 'transport-not-reattachable',
  });
  expect(
    await perfCaptureDurableResource.recoverOne(
      {
        sessionsDir,
        scope,
        acquireControl: async () => ({
          reattach: async (value) => inspectApplePerfCaptureDescriptor(value),
          cleanup: async (value) => cleanupApplePerfCaptureDescriptor(value),
          [Symbol.asyncDispose]: async () => {},
        }),
      },
      resourcePath,
    ),
  ).toBe('retained');
  expect(store.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open' },
  });
});

test('audio reattach retains a live process with unprovable identity', async () => {
  const envelope = createDurableResourceEnvelope({
    ...common,
    resourceKind: 'audio-probe',
    descriptor: {
      version: 1,
      body: {
        backend: 'macos-screencapturekit',
        source: 'system-audio',
        sourceCount: 1,
        notes: [],
        statusPath: path.join(sessionDir, 'audio.json'),
        startedAt: 1,
        durationMs: 1000,
        bucketMs: 500,
        marker,
      },
    },
  });
  const store = audioProbeDurableResource.store;
  const resourcePath = store.resolvePath(sessionDir);
  store.write(resourcePath, envelope);
  const operations = createHostAudioProbeCaptureOperations({
    device: IOS_SIMULATOR,
    owner,
    host: {
      info: {
        source: 'system-audio',
        backend: 'macos-screencapturekit',
        sourceCount: 1,
        notes: () => [],
      },
      start: async () => {
        throw new Error('not used');
      },
      inspectProcess: inspectManagedProcess,
      terminateProcess: async (value) => terminateManagedProcessSet([value]),
    },
  });
  expect(await inspectManagedProcess(marker)).toBe('unprovable');
  expect(await operations.audioProbeReattach({ envelope })).toEqual({
    status: 'unreattachable',
    reason: 'transport-not-reattachable',
  });
  expect(
    await audioProbeDurableResource.recoverOne(
      {
        sessionsDir,
        scope,
        acquireControl: async () => ({
          reattach: async (value) => operations.audioProbeReattach({ envelope: value }),
          cleanup: async (value) => operations.audioProbeCleanup({ envelope: value }),
          [Symbol.asyncDispose]: async () => {},
        }),
      },
      resourcePath,
    ),
  ).toBe('retained');
  expect(store.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open' },
  });
});
