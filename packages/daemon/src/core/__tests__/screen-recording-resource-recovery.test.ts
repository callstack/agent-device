import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  type DeviceRuntimeGateway,
  localRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { makeTestScreenRecordingResource } from '../../__tests__/support/screen-recording-live-handle.ts';
import {
  mkdtempForTestSync,
  unavailableDeploymentSnapshotAndShutdownOperationFacts,
} from '@agent-device/test-kit';
import { recoverScreenRecordingResourceAfterDaemonLock } from '@agent-device/capture-kit/screen-recording-recovery';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';

const device = {
  platform: 'android' as const,
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator' as const,
};
const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

test.each(['active', 'completed'] as const)(
  'recovery settles a native recording that reattaches as %s through its exact owner',
  async (reattached) => {
    const sessionsDir = mkdtempForTestSync('screen-recording-recovery-');
    const session = { name: 'session', device };
    const outPath = path.join(sessionsDir, 'recording.mp4');
    const resource = makeTestScreenRecordingResource(session, { outPath });
    const resourcePath = screenRecordingResourceStore.resolvePath(
      path.join(sessionsDir, session.name),
    );
    fs.writeFileSync(outPath, 'recovered file without producer proof');
    screenRecordingResourceStore.write(resourcePath, {
      ...resource.envelope,
      metadata: {
        ...resource.envelope.metadata,
        remoteCaptureOutput: true,
        remoteCapturePath: outPath,
        remoteCaptureReservation: resource.envelope.fence.token,
      },
    });
    const bind = vi.fn(async ({ device: boundDevice }) => ({
      device: boundDevice,
      owner: localRuntimeOwner('android'),
      facts: {
        device: {
          family: 'android' as const,
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
          screenRecordingReattach: { available: true as const },
          screenRecordingCleanup: { available: true as const },
          ensureReady: unavailable,
          bootTarget: unavailable,
          bootTargetHeadless: unavailable,
          listApps: unavailable,
          ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
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
        screenRecordingReattach: async () => {
          if (reattached === 'active')
            return { status: 'active' as const, handle: resource.handle };
          const completion = await resource.handle.finish();
          if (completion.status !== 'completed') throw new Error('Expected completed fixture');
          return completion;
        },
        screenRecordingCleanup: async () => ({ status: 'cleaned' as const }),
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
      recoverScreenRecordingResourceAfterDaemonLock({
        sessionsDir,
        resourcePath,
        gateway,
        scope,
      }),
    ).resolves.toBe('recovered');
    const settled = screenRecordingResourceStore.read(resourcePath);
    expect(settled).toMatchObject({ status: 'decoded', envelope: { lifecycle: 'completed' } });
    if (settled.status !== 'decoded') throw new Error('Expected terminal manifest');
    expect(settled.envelope.metadata).not.toHaveProperty('remoteCaptureExport');
    if (reattached === 'completed') {
      expect(settled.envelope.metadata?.completion).toMatchObject({ outPath });
      expect(fs.readFileSync(outPath, 'utf8')).toBe('recovered file without producer proof');
    }
  },
);

const unavailable = Object.freeze({
  available: false as const,
  reason: 'owner-capability-missing' as const,
});
