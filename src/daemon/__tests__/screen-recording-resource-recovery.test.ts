import path from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  localRuntimeOwner,
  type DeviceRuntimeGateway,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import { makeTestScreenRecordingResource } from '../../__tests__/test-utils/screen-recording-live-handle.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { recoverScreenRecordingResourceAfterDaemonLock } from '../screen-recording-resource-recovery.ts';
import { screenRecordingResourceStore } from '../screen-recording-resource-store.ts';

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

test('recovery cleans a recording through its exact runtime owner', async () => {
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
        networkDump: unavailable,
        screenRecordingStart: unavailable,
        screenRecordingReattach: { available: true as const },
        screenRecordingCleanup: { available: true as const },
      },
    },
    operations: {
      screenRecordingReattach: async () => ({ status: 'active' as const, handle: resource.handle }),
      screenRecordingCleanup: async () => ({ status: 'cleaned' as const }),
    },
    [Symbol.asyncDispose]: async () => {},
  }));
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
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
  expect(screenRecordingResourceStore.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed' },
  });
});

const unavailable = Object.freeze({
  available: false as const,
  reason: 'owner-capability-missing' as const,
});
