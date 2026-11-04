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

test('recovery retains a recording whose runtime lacks preservation authority', async () => {
  const sessionsDir = mkdtempForTestSync('screen-recording-recovery-');
  const session = { name: 'session', device };
  const resource = makeTestScreenRecordingResource(session);
  const resourcePath = screenRecordingResourceStore.resolvePath(
    path.join(sessionsDir, session.name),
  );
  screenRecordingResourceStore.write(resourcePath, resource.envelope);
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
      screenRecordingReattach: async () => ({ status: 'active' as const, handle: resource.handle }),
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
      claim: { sessionId: resource.envelope.sessionId, device: resource.envelope.device },
    }),
  ).resolves.toEqual({ status: 'retained', reason: 'preservation-unavailable' });
  expect(screenRecordingResourceStore.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open' },
  });
});

const unavailable = Object.freeze({
  available: false as const,
  reason: 'owner-capability-missing' as const,
});

test('a cancelled late recording reattach settles before releasing control and never disposes the live handle', async () => {
  const sessionsDir = mkdtempForTestSync('recording-late-preservation-');
  const resource = makeTestScreenRecordingResource({ name: 'session', device });
  const resourcePath = screenRecordingResourceStore.resolvePath(path.join(sessionsDir, 'session'));
  screenRecordingResourceStore.write(resourcePath, resource.envelope);
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const forceCleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
  const disposeHandle = vi.fn(async () => {});
  const settle = vi.fn(async () => ({ status: 'export' as const }));
  const disposeControl = vi.fn(async () => {});
  const handle = {
    ...resource.handle,
    forceCleanup,
    settleForExport: settle,
    [Symbol.asyncDispose]: disposeHandle,
  };
  const gateway = {
    bind: async ({ device: boundDevice }: { device: unknown }) => ({
      device: boundDevice,
      owner: localRuntimeOwner('android'),
      facts: {
        device: { family: 'android', kind: 'emulator', providerMode: 'local' },
        operations: {
          screenRecordingReattach: { available: true },
          screenRecordingCleanup: { available: true },
        },
      },
      operations: {
        screenRecordingReattach: async () => {
          entered();
          await pending;
          return { status: 'active' as const, handle };
        },
        screenRecordingCleanup: forceCleanup,
      },
      [Symbol.asyncDispose]: disposeControl,
    }),
  } as unknown as DeviceRuntimeGateway<PlatformRuntimeOperations>;
  const controller = new AbortController();
  const task = recoverScreenRecordingResourceAfterDaemonLock({
    sessionsDir,
    resourcePath,
    gateway,
    scope: { ...scope, signal: controller.signal },
    claim: { sessionId: resource.envelope.sessionId, device: resource.envelope.device },
  });
  await started;
  controller.abort();
  await Promise.resolve();
  expect(disposeControl).not.toHaveBeenCalled();
  expect(forceCleanup).not.toHaveBeenCalled();
  release();
  await expect(task).resolves.toEqual({ status: 'retained', reason: 'preservation-cancelled' });
  expect(settle).not.toHaveBeenCalled();
  expect(forceCleanup).not.toHaveBeenCalled();
  expect(disposeHandle).not.toHaveBeenCalled();
  expect(disposeControl).toHaveBeenCalledOnce();
  expect(screenRecordingResourceStore.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open' },
  });
});
