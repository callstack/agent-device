import { test, expect, vi, beforeEach } from 'vitest';
import {
  legacyDispatchCapture,
  resetLegacySnapshotCapture,
} from '../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { WEB_DESKTOP_DEVICE } from '@agent-device/test-kit/device-fixtures';
import {
  makeAndroidSession as makeBaseAndroidSession,
  makeIosSession,
} from '../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../__tests__/support/store-factory.ts';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import {
  installInteractorSnapshotResolution,
  mockInteractorSnapshot,
} from '../__tests__/support/interactor-resolution-fixture.ts';
import { touchCreateCommandSurface } from '../__tests__/support/touch-command-surface-fake.ts';
import { handleInteractionCommands } from './interaction/index.ts';
import {
  contextFromFlags,
  makeSession,
  makeVisibleButtonSnapshot,
} from './interaction/internal/__tests__/interaction-touch-fixtures.ts';

// The `is` reads the public interaction handler owns: the capture each predicate takes, and the
// Android foreground blocker a failed assertion discloses.

vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    getAndroidAppState: vi.fn(async () => ({})),
    getAndroidBlockingDialogObservation: vi.fn(async () => ({ status: 'clear' }) as const),
  };
});

import {
  getRuntimeBindings,
  resetGetRuntimeFixture,
} from './__tests__/interaction-get-runtime-fixture.ts';
import {
  getAndroidAppState,
  getAndroidBlockingDialogObservation,
} from '@agent-device/platform-android/mechanics';
const mockGetAndroidAppState = vi.mocked(getAndroidAppState);
const mockGetAndroidBlockingDialogObservation = vi.mocked(getAndroidBlockingDialogObservation);

beforeEach(() => {
  installInteractorSnapshotResolution();
  resetLegacySnapshotCapture(mockInteractorSnapshot);
  mockGetAndroidAppState.mockReset();
  mockGetAndroidAppState.mockResolvedValue({});
  mockGetAndroidBlockingDialogObservation.mockReset();
  mockGetAndroidBlockingDialogObservation.mockResolvedValue({ status: 'clear' });
  resetGetRuntimeFixture();
});

test('is visible preserves CLI snapshot flags during runtime snapshot capture', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'snapshot-flags';
  sessionStore.publish(sessionName, makeSession(sessionName));

  legacyDispatchCapture.mockImplementation(async (_device, command) => {
    if (command !== 'snapshot') throw new Error(`unexpected command: ${command}`);
    return {
      nodes: [
        {
          index: 0,
          depth: 0,
          type: 'XCUIElementTypeWindow',
          label: 'Login',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'XCUIElementTypeButton',
          label: 'Continue',
          identifier: 'auth_continue',
          rect: { x: 10, y: 20, width: 100, height: 40 },
          enabled: true,
          hittable: true,
          visible: true,
        },
      ],
      backend: 'xctest',
      producer: 'apple-runner',
    };
  });

  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'is',
      positionals: ['visible', 'id=auth_continue'],
      flags: { snapshotDepth: 2, snapshotScope: 'Login', snapshotRaw: true },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(legacyDispatchCapture.mock.calls[0]?.[4]).toMatchObject({
    snapshotDepth: 2,
    snapshotScope: 'Login',
    snapshotRaw: true,
    snapshotInteractiveOnly: false,
    snapshotIncludeRects: true,
  });
});

test('is visible reuses fresh cached iOS snapshots with rects', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-visible-cached';
  const session = makeSession(sessionName);
  session.snapshot = makeVisibleButtonSnapshot('Cached action', {
    backend: 'xctest',
    producer: 'apple-runner',
  });
  sessionStore.publish(sessionName, session);
  legacyDispatchCapture.mockRejectedValue(new Error('unexpected fresh snapshot'));

  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'is',
      positionals: ['visible', 'label="Cached action"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
});

test('is visible recaptures web snapshots when cached nodes may lack rects', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'web-visible-refreshes-rects';
  const session = makeSession(sessionName);
  session.device = WEB_DESKTOP_DEVICE;
  session.snapshot = buildSnapshotState(
    {
      nodes: [{ index: 0, type: 'button', label: 'Submit order' }],
      backend: 'web',
      producer: 'agent-browser',
    },
    { snapshotInteractiveOnly: false },
  );
  sessionStore.publish(sessionName, session);
  legacyDispatchCapture.mockResolvedValue(
    makeVisibleButtonSnapshot('Submit order', {
      backend: 'web',
      producer: 'agent-browser',
    }),
  );

  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'is',
      positionals: ['visible', 'label="Submit order"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(legacyDispatchCapture.mock.calls[0]?.[4]).toMatchObject({
    snapshotIncludeRects: true,
  });
});

// PIN CHANGED TWICE (#1739, R37). #557 asserted `ok: true` with `pass: false` and zero snapshots
// here, from the direct-iOS shortcut. That broke `is`'s documented contract — it "exits non-zero
// on failure" (website/docs/docs/commands.md) — and on device printed `Passed: is text` with exit
// 0 for a failed assertion. The reversal made the shortcut answer only when the predicate held;
// the shortcut is now retired outright, so the bound capture answers every predicate and this is
// simply what `is` does. The assertion below is unchanged across both edits because it was always
// about the OUTCOME, not about which path produced it.
test('a failing is predicate is COMMAND_FAILED, never a zero-exit pass', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'is-selected-ios-direct-selector-false';
  sessionStore.publish(
    sessionName,
    makeIosSession(sessionName, { appBundleId: 'com.example.app' }),
  );
  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'is',
      positionals: ['selected', 'id="submit"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  // The session snapshot has no `id=submit`, so the bound capture reports the typed selector
  // failure. Nothing can report a failed assertion as a completed command.
  expect(response?.ok).toBe(false);
  expect(legacyDispatchCapture.mock.calls.filter((call) => call[1] === 'snapshot')).toHaveLength(1);
  if (response?.ok === false) {
    expect(response.error?.code).toBe('COMMAND_FAILED');
  }
});

test('is reports Android permission dialog blocker when app content assertion fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-permission-blocked';
  sessionStore.publish(
    sessionName,
    makeBaseAndroidSession(sessionName, { appBundleId: 'com.example.demo' }),
  );

  legacyDispatchCapture.mockImplementation(async (_device, command) => {
    if (command !== 'snapshot') throw new Error(`unexpected command: ${command}`);
    return { nodes: [], backend: 'uiautomator' };
  });
  mockGetAndroidAppState.mockResolvedValue({
    package: 'com.google.android.permissioncontroller',
    activity: 'com.android.permissioncontroller.permission.ui.GrantPermissionsActivity',
  });

  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'is',
      positionals: ['visible', 'label="Metro Ready"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.message).toMatch(/permission dialog is blocking/);
    expect(response.error.details).toMatchObject({
      blockedBy: 'android_foreground_surface',
      expectedPackage: 'com.example.demo',
      foregroundPackage: 'com.google.android.permissioncontroller',
      permissionDialog: true,
    });
  }
});
