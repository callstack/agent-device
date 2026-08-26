import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import { audioProbeRuntimeOperationFacts } from '@agent-device/contracts/audio-probe-runtime';
import {
  type DeviceRuntimeGateway,
  localRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { deviceIdentity } from '@agent-device/kernel/device';
import {
  createDurableResourceEnvelope,
  createHostAudioProbeCaptureOperations,
  encodeDurableDescriptor,
  hostAudioProbeDescriptorCodec,
} from '@agent-device/capture-kit';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '../../__tests__/test-utils/runtime-operation-facts.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { recoverAudioProbeResourceAfterDaemonLock } from '../audio-probe-resource-recovery.ts';
import { audioProbeResourceStore } from '../audio-probe-resource-store.ts';

const device = {
  platform: 'apple' as const,
  appleOs: 'macos' as const,
  id: 'macos-host',
  name: 'macOS',
  kind: 'device' as const,
};
const marker = { pid: 4242, startTime: 'boot+1', command: 'helper' };
const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

// Daemon-restart regression for the mid-capture death misreport: an orphaned probe whose helper
// is gone but whose status file still holds a `running` checkpoint must terminalize as
// already-missing — never as a completion carrying the checkpoint's data.
test('recovery never finalizes a running checkpoint from a dead helper as completed', async () => {
  const sessionsDir = mkdtempForTestSync('audio-probe-recovery-');
  const sessionName = 'session';
  const statusPath = path.join(sessionsDir, sessionName, 'audio-probe.json');
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  await fs.writeFile(
    statusPath,
    JSON.stringify({ state: 'running', rmsDbfs: [-10], peakDbfs: [-5], sampleCount: 1 }),
  );
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'audio-probe',
    sessionId: sessionName,
    device: deviceIdentity(device),
    owner: localRuntimeOwner('apple'),
    fence: { token: 'fence-1', generation: 1 },
    lifecycle: 'open',
    descriptor: encodeDurableDescriptor(hostAudioProbeDescriptorCodec, {
      backend: 'macos-screencapturekit',
      source: 'system-audio',
      sourceCount: 1,
      notes: [],
      statusPath,
      startedAt: Date.now() - 5_000,
      durationMs: 30_000,
      bucketMs: 1_000,
      marker,
    }),
  });
  const resourcePath = audioProbeResourceStore.resolvePath(path.join(sessionsDir, sessionName));
  audioProbeResourceStore.write(resourcePath, envelope);

  const operations = createHostAudioProbeCaptureOperations({
    host: {
      info: {
        source: 'system-audio',
        backend: 'macos-screencapturekit',
        sourceCount: 1,
        notes: () => [],
      },
      start: async () => {
        throw new Error('start is not part of recovery');
      },
      inspectProcess: async () => 'missing' as const,
      terminateProcess: async () => 'already-missing' as const,
    },
    device,
    owner: localRuntimeOwner('apple'),
  });
  const bind = vi.fn(async ({ device: boundDevice }) => ({
    device: boundDevice,
    owner: localRuntimeOwner('apple'),
    facts: {
      device: {
        family: 'apple' as const,
        kind: boundDevice.kind,
        providerMode: 'local' as const,
      },
      operations: {
        appLogInspect: unavailable,
        appLogDoctor: unavailable,
        appLogStart: unavailable,
        appLogReattach: unavailable,
        appLogCleanup: unavailable,
        appState: unavailable,
        networkDump: unavailable,
        screenRecordingStart: unavailable,
        screenRecordingReattach: unavailable,
        screenRecordingCleanup: unavailable,
        ensureReady: unavailable,
        bootTarget: unavailable,
        bootTargetHeadless: unavailable,
        listApps: unavailable,
        ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
        ...audioProbeRuntimeOperationFacts({
          capture: { available: true as const },
          query: unavailable,
        }),
        ...applicationLifecycleOperationFacts({
          resolveOpenTarget: unavailable,
          prepareApplicationOpen: unavailable,
          openApplication: unavailable,
          applyRuntimeHints: unavailable,
          clearRuntimeHints: unavailable,
          closeApplication: unavailable,
          finalizeApplicationClose: unavailable,
          prepareAppleRunner: unavailable,
          configureProviderPortReverse: unavailable,
        }),
      },
    },
    operations: {
      audioProbeReattach: operations.audioProbeReattach,
      audioProbeCleanup: operations.audioProbeCleanup,
    },
    [Symbol.asyncDispose]: async () => {},
  }));
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    inspectFacts: async () => {
      throw new Error('unused');
    },
    bind,
    shutdown: async () => {},
  };

  await expect(
    recoverAudioProbeResourceAfterDaemonLock({
      sessionsDir,
      resourcePath,
      gateway,
      scope,
    }),
  ).resolves.toBe('recovered');
  const record = audioProbeResourceStore.read(resourcePath);
  expect(record).toMatchObject({
    status: 'decoded',
    envelope: {
      lifecycle: 'completed',
      metadata: { phase: 'completed', recoveryStatus: 'already-missing' },
    },
  });
  if (record.status === 'decoded') {
    expect(record.envelope.metadata).not.toHaveProperty('heard');
    expect(record.envelope.metadata).not.toHaveProperty('sampleCount');
  }
});

const unavailable = Object.freeze({
  available: false as const,
  reason: 'owner-capability-missing' as const,
});
