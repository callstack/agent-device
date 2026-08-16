import { test, expect, vi, beforeEach } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { WEB_DESKTOP_DEVICE } from '../../../__tests__/test-utils/device-fixtures.ts';
import {
  makeAndroidSession as makeBaseAndroidSession,
  makeIosSession,
} from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { expireRefFrame } from '../../ref-frame.ts';
import { setSessionSnapshot, STALE_SNAPSHOT_REFS_WARNING } from '../../session-snapshot.ts';
import { handleInteractionCommands } from '../interaction.ts';
import { buildSnapshotState } from '../snapshot-capture.ts';
import {
  contextFromFlags,
  makeSession,
  makeStaleRefSession,
  makeVisibleButtonSnapshot,
  runInteraction,
} from './interaction-touch-fixtures.ts';

// Non-touch interaction routing: the `get` and `is` reads the public handler
// owns. Touch commands live in the interaction-touch* test files.

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({})),
  };
});

vi.mock('../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../__tests__/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});

vi.mock('../../../platforms/android/app-lifecycle.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/app-lifecycle.ts')>();
  return {
    ...actual,
    getAndroidAppState: vi.fn(async () => ({})),
    getAndroidBlockingDialogFocus: vi.fn(async () => null),
  };
});

vi.mock('../../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner/runner-client.ts')>();
  return {
    ...actual,
    runAppleRunnerCommand: mockRunAppleRunnerCommand,
  };
});

import { dispatchCommand } from '../../../core/dispatch.ts';
const mockDispatch = vi.mocked(dispatchCommand);
import {
  getAndroidAppState,
  getAndroidBlockingDialogFocus,
} from '../../../platforms/android/app-lifecycle.ts';
const mockGetAndroidAppState = vi.mocked(getAndroidAppState);
const mockGetAndroidBlockingDialogFocus = vi.mocked(getAndroidBlockingDialogFocus);
beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockGetAndroidAppState.mockReset();
  mockGetAndroidAppState.mockResolvedValue({});
  mockGetAndroidBlockingDialogFocus.mockReset();
  mockGetAndroidBlockingDialogFocus.mockResolvedValue(null);
  mockRunAppleRunnerCommand.mockReset();
  mockRunAppleRunnerCommand.mockResolvedValue({});
});

test('get text prefers underlying value for text surfaces and avoids recording giant ref labels', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'get-text-editor';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        depth: 0,
        type: 'TextView',
        label: 'Editor for MainActivity.kt',
        value: 'package com.example.app\nclass MainActivity {}',
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockRejectedValue(
    new Error('dispatch should not be called for snapshot-derived get text'),
  );

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'get',
      positionals: ['text', '@e1'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.ref).toBe('e1');
    expect(response.data?.text).toBe('package com.example.app\nclass MainActivity {}');
  }

  const recorded = sessionStore.get(sessionName)?.actions.at(-1);
  expect(recorded?.result?.text).toBe('package com.example.app\nclass MainActivity {}');
  expect(recorded?.result?.refLabel).toBeUndefined();
});

test('get text uses backend read expansion when the resolved node has a rect', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'get-text-backend-read';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        depth: 0,
        type: 'TextView',
        label: 'Editor for MainActivity.kt',
        value: 'preview only',
        rect: { x: 20, y: 40, width: 120, height: 80 },
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({
    action: 'read',
    text: 'package com.example.app\nclass MainActivity {}',
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'get',
      positionals: ['text', '@e1'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('read');
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['80', '80']);
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.text).toBe('package com.example.app\nclass MainActivity {}');
  }
});

test('get text simple iOS id selector uses runner query without snapshot', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'get-text-ios-direct-selector';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  mockRunAppleRunnerCommand.mockResolvedValue({
    found: true,
    text: 'Ada Lovelace',
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'TextField',
        label: 'Name',
        identifier: 'field-name',
        value: 'Ada Lovelace',
        rect: { x: 24, y: 220, width: 320, height: 48 },
        enabled: true,
        hittable: true,
      },
    ],
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'get',
      positionals: ['text', 'id="field-name"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockRunAppleRunnerCommand).toHaveBeenCalledWith(
    expect.anything(),
    {
      command: 'querySelector',
      selectorKey: 'id',
      selectorValue: 'field-name',
      appBundleId: 'com.example.app',
    },
    expect.anything(),
  );
  expect(mockDispatch).not.toHaveBeenCalledWith(
    expect.anything(),
    'snapshot',
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
  if (response?.ok) {
    expect(response.data?.text).toBe('Ada Lovelace');
    expect(response.data?.selector).toBe('id="field-name"');
  }
  const recorded = sessionStore.get(sessionName)?.actions.at(-1);
  expect(recorded?.result?.selectorChain).toEqual(['id="field-name"']);
});

test('get text iOS label selector uses snapshot disambiguation instead of runner query', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'get-text-ios-label-selector';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  mockDispatch.mockResolvedValue({
    backend: 'xctest',
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Application',
        rect: { x: 0, y: 0, width: 393, height: 852 },
        enabled: true,
        hittable: true,
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'Cell',
        label: 'General',
        rect: { x: 0, y: 100, width: 393, height: 48 },
        enabled: true,
        hittable: true,
      },
      {
        index: 2,
        depth: 2,
        parentIndex: 1,
        type: 'Button',
        label: 'General',
        rect: { x: 0, y: 100, width: 393, height: 48 },
        enabled: true,
        hittable: true,
      },
      {
        index: 3,
        depth: 2,
        parentIndex: 1,
        type: 'StaticText',
        label: 'General',
        rect: { x: 18, y: 112, width: 80, height: 24 },
        enabled: true,
        hittable: false,
      },
    ],
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'get',
      positionals: ['text', 'label="General"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockRunAppleRunnerCommand).not.toHaveBeenCalled();
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('snapshot');
  if (response?.ok) {
    expect(response.data?.text).toBe('General');
    expect(response.data?.selector).toBe('label="General"');
  }
});

test('get text simple iOS id selector does not snapshot-fallback on ambiguous runner match', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'get-text-ios-direct-selector-ambiguous';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  mockRunAppleRunnerCommand.mockRejectedValue(
    new AppError('AMBIGUOUS_MATCH', 'selector matched multiple elements'),
  );

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'get',
      positionals: ['text', 'id="field-name"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(false);
  if (response?.ok === false) {
    expect(response.error.code).toBe('AMBIGUOUS_MATCH');
  }
  expect(mockDispatch).not.toHaveBeenCalledWith(
    expect.anything(),
    'snapshot',
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
});

test('is visible preserves CLI snapshot flags during runtime snapshot capture', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'snapshot-flags';
  sessionStore.set(sessionName, makeSession(sessionName));

  mockDispatch.mockImplementation(async (_device, command) => {
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
    };
  });

  const response = await handleInteractionCommands({
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
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatch.mock.calls[0]?.[4]).toMatchObject({
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
  session.snapshot = makeVisibleButtonSnapshot('Cached action', 'xctest');
  sessionStore.set(sessionName, session);
  mockDispatch.mockRejectedValue(new Error('unexpected fresh snapshot'));

  const response = await handleInteractionCommands({
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
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatch).not.toHaveBeenCalled();
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
    },
    { snapshotInteractiveOnly: false },
  );
  sessionStore.set(sessionName, session);
  mockDispatch.mockResolvedValue(makeVisibleButtonSnapshot('Submit order', 'web'));

  const response = await handleInteractionCommands({
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
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatch.mock.calls[0]?.[4]).toMatchObject({
    snapshotIncludeRects: true,
  });
});

test('is selected simple iOS id selector uses runner query without snapshot', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'is-selected-ios-direct-selector';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  mockRunAppleRunnerCommand.mockResolvedValue({
    found: true,
    text: 'Pickup',
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        label: 'Pickup',
        identifier: 'shipping-pickup',
        selected: true,
        rect: { x: 126, y: 555, width: 75, height: 38 },
        enabled: true,
        hittable: true,
      },
    ],
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'is',
      positionals: ['selected', 'id="shipping-pickup"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockRunAppleRunnerCommand).toHaveBeenCalledWith(
    expect.anything(),
    {
      command: 'querySelector',
      selectorKey: 'id',
      selectorValue: 'shipping-pickup',
      appBundleId: 'com.example.app',
    },
    expect.anything(),
  );
  expect(mockDispatch).not.toHaveBeenCalledWith(
    expect.anything(),
    'snapshot',
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
  if (response?.ok) {
    expect(response.data?.predicate).toBe('selected');
    expect(response.data?.pass).toBe(true);
  }
  const recorded = sessionStore.get(sessionName)?.actions.at(-1);
  expect(recorded?.result?.selectorChain).toEqual(['id="shipping-pickup"']);
});

test('is simple iOS selector returns false directly when runner predicate fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'is-selected-ios-direct-selector-false';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  mockRunAppleRunnerCommand.mockResolvedValue({
    found: true,
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        label: 'Submit',
        identifier: 'submit',
        selected: false,
        rect: { x: 126, y: 555, width: 75, height: 38 },
      },
    ],
  });

  const response = await handleInteractionCommands({
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
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatch.mock.calls.filter((call) => call[1] === 'snapshot')).toHaveLength(0);
  if (response?.ok) {
    expect(response.data?.predicate).toBe('selected');
    expect(response.data?.pass).toBe(false);
  }
});

test('is simple iOS selector falls back to snapshot while gesture stabilization is pending', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'is-selected-ios-stabilizing';
  const session = makeIosSession(sessionName, { appBundleId: 'com.example.app' });
  session.postGestureStabilization = { action: 'swipe', positionals: [], markedAt: Date.now() };
  sessionStore.set(sessionName, session);

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command !== 'snapshot') throw new Error(`unexpected command: ${command}`);
    return {
      nodes: [
        {
          index: 0,
          depth: 0,
          type: 'Window',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'Button',
          label: 'Pickup',
          identifier: 'shipping-pickup',
          selected: true,
          rect: { x: 126, y: 555, width: 75, height: 38 },
          enabled: true,
          hittable: true,
        },
      ],
      backend: 'xctest',
    };
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'is',
      positionals: ['selected', 'id="shipping-pickup"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockRunAppleRunnerCommand).not.toHaveBeenCalled();
  expect(mockDispatch.mock.calls.some((call) => call[1] === 'snapshot')).toBe(true);
});

test('is visible passes for list text that inherits viewport visibility from an ancestor', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'visible-list-item';
  sessionStore.set(sessionName, makeSession(sessionName));

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command !== 'snapshot') throw new Error(`unexpected command: ${command}`);
    return {
      nodes: [
        { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
        {
          index: 1,
          parentIndex: 0,
          type: 'XCUIElementTypeCell',
          rect: { x: 0, y: 160, width: 390, height: 44 },
          hittable: false,
        },
        {
          index: 2,
          parentIndex: 1,
          type: 'XCUIElementTypeStaticText',
          label: 'Trip ideas',
          hittable: false,
        },
      ],
      backend: 'xctest',
    };
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'is',
      positionals: ['visible', 'label="Trip ideas"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.predicate).toBe('visible');
    expect(response.data?.pass).toBe(true);
    expect(response.data?.selector).toBe('label="Trip ideas"');
  }
});

test('is visible fails for nodes outside the current viewport', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'visible-offscreen';
  sessionStore.set(sessionName, makeSession(sessionName));

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command !== 'snapshot') throw new Error(`unexpected command: ${command}`);
    return {
      nodes: [
        { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
        {
          index: 1,
          parentIndex: 0,
          type: 'XCUIElementTypeStaticText',
          label: 'Far item',
          rect: { x: 20, y: 2600, width: 120, height: 40 },
          hittable: false,
        },
      ],
      backend: 'xctest',
    };
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'is',
      positionals: ['visible', 'label="Far item"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/actual=\{"visible":false/);
  }
});

test('is reports Android permission dialog blocker when app content assertion fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-permission-blocked';
  sessionStore.set(
    sessionName,
    makeBaseAndroidSession(sessionName, { appBundleId: 'com.example.demo' }),
  );

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command !== 'snapshot') throw new Error(`unexpected command: ${command}`);
    return { nodes: [], backend: 'uiautomator' };
  });
  mockGetAndroidAppState.mockResolvedValue({
    package: 'com.google.android.permissioncontroller',
    activity: 'com.android.permissioncontroller.permission.ui.GrantPermissionsActivity',
  });

  const response = await handleInteractionCommands({
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
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.message).toMatch(/permission dialog is blocking/);
    expect(response.error.details).toMatchObject({
      blockedBy: 'android_foreground_surface',
      expectedPackage: 'com.example.demo',
      foregroundPackage: 'com.google.android.permissioncontroller',
    });
  }
});

test('ADR 0014 evidence #17: get text @ref reads the retained frame tree, not a newer observation', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'read-frame-tree';
  // Frame tree: @e1 = Continue, @e2 = Cancel.
  const session = makeStaleRefSession(sessionName);
  // A read-only capture replaced the OBSERVATION with a divergent tree where the
  // same index means a different element. The frame tree is untouched.
  setSessionSnapshot(session, {
    nodes: attachRefs([
      { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
      {
        index: 1,
        parentIndex: 0,
        type: 'XCUIElementTypeButton',
        label: 'Different',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ] as never),
    createdAt: Date.now(),
    backend: 'xctest',
  });
  sessionStore.set(sessionName, session);
  mockDispatch.mockRejectedValue(new Error('get text @ref must not recapture'));

  // Resolves against the frame tree's @e2 (Continue), never the observation's
  // positional @e2 (Different) — no fall-through by positional coincidence.
  const response = await runInteraction(sessionStore, sessionName, 'get', ['text', '@e2']);
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.ref).toBe('e2');
    expect(String(response.data?.text)).toContain('Continue');
    expect(String(response.data?.text)).not.toContain('Different');
  }

  // Missing frame evidence FAILS rather than resolving a newer observation.
  const missing = await runInteraction(sessionStore, sessionName, 'get', ['text', '@e9']);
  expect(missing?.ok).toBe(false);
  if (missing && !missing.ok) {
    expect(missing.error.code).toBe('COMMAND_FAILED');
    expect(missing.error.message).toMatch(/not found/i);
  }
  expect(mockDispatch).not.toHaveBeenCalled();
});

test('get text @ref warns while the frame is expired (retained evidence still resolves)', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'stale-ref-get-text';
  const session = makeStaleRefSession(sessionName);
  // A device action expired the frame; the read still resolves against the
  // retained frame tree and stays fail-open with a warning (ADR 0014).
  expireRefFrame(session);
  sessionStore.set(sessionName, session);
  mockDispatch.mockRejectedValue(
    new Error('dispatch should not be called for snapshot-derived get text'),
  );

  const response = await runInteraction(sessionStore, sessionName, 'get', ['text', '@e1']);
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warning).toBe(STALE_SNAPSHOT_REFS_WARNING);
    expect(response.data?.ref).toBe('e1');
  }
});

test('get text with a pinned stale ref gets the precise warning', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'pinned-get-text';
  const session = makeStaleRefSession(sessionName);
  session.snapshotGeneration = 4;
  sessionStore.set(sessionName, session);
  mockDispatch.mockRejectedValue(
    new Error('dispatch should not be called for snapshot-derived get text'),
  );

  const response = await runInteraction(sessionStore, sessionName, 'get', ['text', '@e1~s2']);
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warning).toBe(
      "Ref @e1 was minted from snapshot s2 but the session's ref frame is now s4 — re-run snapshot -i.",
    );
    expect(response.data?.ref).toBe('e1');
  }
});
