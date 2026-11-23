import { test, expect, vi } from 'vitest';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { errorResponse, type DaemonResponse } from '@agent-device/kernel/contracts';
import { makeAndroidSession } from '../../__tests__/support/session-factories.ts';
import { SessionStore } from '../../core/session-store.ts';
import { createLiveTestHostEnvironment } from '@agent-device/test-kit';
import type { SelectorRuntimeParams } from '../selector-runtime-backend.ts';
import { maybeAndroidForegroundBlockerResponse } from '../selector-runtime.ts';

function annotatorParams(
  sessionName: string,
  sessionStore: SessionStore,
  observation: AndroidObservationAdapter,
): SelectorRuntimeParams {
  // The annotator reads only the session store and the observation adapter; the rest of the
  // runtime params surface is inert for this route.
  return {
    sessionName,
    sessionStore,
    androidObservation: observation,
  } as SelectorRuntimeParams;
}

test('failed command is re-annotated with the escape surface it hit', async () => {
  const session = makeAndroidSession('annotate-escape', { appBundleId: 'com.example.app' });
  const observation = {
    readAppFocus: vi.fn(async () => false),
    readAppState: vi.fn(async () => ({ package: 'com.android.settings' })),
    isPermissionPackage: vi.fn(async () => false),
  } satisfies AndroidObservationAdapter;
  const sessionStore = new SessionStore('/tmp/annotate-escape', createLiveTestHostEnvironment());
  sessionStore.publish(session.name, session);
  const failed: DaemonResponse = errorResponse('COMMAND_FAILED', 'press e10 tap dispatch failed');

  const response = await maybeAndroidForegroundBlockerResponse(
    annotatorParams(session.name, sessionStore, observation),
    failed,
    'press',
  );

  expect(observation.readAppFocus).toHaveBeenCalledTimes(1);
  expect(observation.readAppState).toHaveBeenCalledTimes(1);
  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message:
        'press failed because com.android.settings is foreground instead of com.example.app.',
      details: {
        expectedPackage: 'com.example.app',
        foregroundPackage: 'com.android.settings',
        blockedBy: 'android_foreground_surface',
        originalMessage: 'press e10 tap dispatch failed',
      },
    },
  });
});

test('failed command passes through untouched when the session app owns focus', async () => {
  const session = makeAndroidSession('annotate-in-focus', { appBundleId: 'com.example.app' });
  const observation = {
    readAppFocus: vi.fn(async () => true),
    readAppState: vi.fn(async () => ({ package: 'com.example.app' })),
  } satisfies Partial<AndroidObservationAdapter> as AndroidObservationAdapter;
  const sessionStore = new SessionStore('/tmp/annotate-in-focus', createLiveTestHostEnvironment());
  sessionStore.publish(session.name, session);
  const failed: DaemonResponse = errorResponse('COMMAND_FAILED', 'press e10 tap dispatch failed');

  await expect(
    maybeAndroidForegroundBlockerResponse(
      annotatorParams(session.name, sessionStore, observation),
      failed,
      'press',
    ),
  ).resolves.toEqual(failed);
  expect(observation.readAppState).not.toHaveBeenCalled();
});
