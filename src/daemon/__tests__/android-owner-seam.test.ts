import { test, expect, vi } from 'vitest';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { makeAndroidSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeTestScreenRecordingResource } from '../../__tests__/test-utils/screen-recording-live-handle.ts';
import {
  ensureAndroidBlockingSystemDialogReady,
  recoverAndroidBlockingSystemDialog,
} from '../android-system-dialog.ts';
import { detectAndroidEscapeSurface } from '../handlers/interaction-android-escape.ts';
import { resolveDirectTouchReferenceFrameSafely } from '../handlers/interaction-touch-reference-frame.ts';
import { SessionStore } from '../session-store.ts';

test('provider-owned Android sessions bypass local observation and recovery', async () => {
  const session = makeAndroidSession('provider-owned-android', {
    appBundleId: 'com.example.app',
    lease: {
      leaseId: 'lease',
      tenantId: 'tenant',
      runId: 'run',
      leaseProvider: 'provider',
    },
  });
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'adb screenrecord',
    outPath: '/tmp/provider-owned-android.mp4',
    startedAt: 0,
  });
  const observation = {
    readAppState: vi.fn(async () => ({ package: 'com.android.settings' })),
    readBlockingDialog: vi.fn(async () => ({
      status: 'dialog' as const,
      focus: { focusedWindow: 'ANR', raw: 'ANR' },
    })),
    readAppFocus: vi.fn(async () => true),
    readSnapshotNodes: vi.fn(async () => []),
    tap: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    openApp: vi.fn(async () => undefined),
    readScreenSize: vi.fn(async () => ({ width: 100, height: 100 })),
    isPermissionPackage: vi.fn(async () => false),
  } satisfies AndroidObservationAdapter;

  await expect(
    ensureAndroidBlockingSystemDialogReady({
      session,
      command: 'press',
      phase: 'before-command',
      observation,
    }),
  ).resolves.toEqual({ status: 'clear' });
  await expect(recoverAndroidBlockingSystemDialog({ session, observation })).resolves.toEqual({
    status: 'absent',
  });
  await expect(detectAndroidEscapeSurface(session, observation)).resolves.toBeNull();
  session.snapshot = {
    createdAt: 0,
    nodes: [
      {
        index: 0,
        ref: 'e1',
        type: 'android.widget.FrameLayout',
        rect: { x: 0, y: 0, width: 1080, height: 1920 },
      },
    ],
  };
  await expect(
    resolveDirectTouchReferenceFrameSafely({
      session,
      flags: undefined,
      sessionStore: new SessionStore('/tmp/provider-owned-android'),
      contextFromFlags: () => ({}),
      captureSnapshotForSession: async () => session.snapshot!,
      observation,
    }),
  ).resolves.toEqual({ referenceWidth: 1080, referenceHeight: 1920 });

  expect(observation.readBlockingDialog).not.toHaveBeenCalled();
  expect(observation.readSnapshotNodes).not.toHaveBeenCalled();
  expect(observation.readAppState).not.toHaveBeenCalled();
  expect(observation.readAppFocus).not.toHaveBeenCalled();
  expect(observation.tap).not.toHaveBeenCalled();
  expect(observation.openApp).not.toHaveBeenCalled();
  expect(observation.readScreenSize).not.toHaveBeenCalled();
  expect(observation.isPermissionPackage).not.toHaveBeenCalled();
});
