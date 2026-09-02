import { test, expect, vi, beforeEach } from 'vitest';
import { legacyDispatchCapture } from '../../../__tests__/legacy-snapshot-capture-fixture.ts';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { WEB_DESKTOP_DEVICE } from '../../../../__tests__/test-utils/device-fixtures.ts';
import {
  makeAndroidSession as makeBaseAndroidSession,
  makeIosSession,
} from '../../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { expireRefFrame } from '../../../ref-frame.ts';
import { setSessionSnapshot, STALE_SNAPSHOT_REFS_WARNING } from '../../../session-snapshot.ts';
import { handleInteractionCommands } from '../../index.ts';
import { buildSnapshotState } from '../../../../core/snapshot-state.ts';
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

vi.mock('../../../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../../__tests__/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});

vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    getAndroidAppState: vi.fn(async () => ({})),
    getAndroidBlockingDialogObservation: vi.fn(async () => ({ status: 'clear' }) as const),
  };
});

vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return {
    ...actual,
    runAppleRunnerCommand: mockRunAppleRunnerCommand,
  };
});

import { elementTextRead } from '@agent-device/contracts/element-text-runtime';
import {
  elementReadFixtureState,
  getRuntimeBindings,
  mockReadTextAtPoint,
  resetGetRuntimeFixture,
} from '../../../__tests__/interaction-get-runtime-fixture.ts';
import {
  getAndroidAppState,
  getAndroidBlockingDialogObservation,
} from '@agent-device/platform-android/mechanics';
const mockGetAndroidAppState = vi.mocked(getAndroidAppState);
const mockGetAndroidBlockingDialogObservation = vi.mocked(getAndroidBlockingDialogObservation);
beforeEach(() => {
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
  mockGetAndroidAppState.mockReset();
  mockGetAndroidAppState.mockResolvedValue({});
  mockGetAndroidBlockingDialogObservation.mockReset();
  mockGetAndroidBlockingDialogObservation.mockResolvedValue({ status: 'clear' });
  mockRunAppleRunnerCommand.mockReset();
  mockRunAppleRunnerCommand.mockResolvedValue({});
  resetGetRuntimeFixture();
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

  legacyDispatchCapture.mockRejectedValue(
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
    ...getRuntimeBindings(),
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

  mockReadTextAtPoint.mockResolvedValue(
    elementTextRead('package com.example.app\nclass MainActivity {}'),
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
    ...getRuntimeBindings(),
  });

  // The live read now reaches the bound runtime operation, not the legacy `read` dispatch.
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
  expect(mockReadTextAtPoint).toHaveBeenCalledTimes(1);
  expect(mockReadTextAtPoint.mock.calls[0]?.[0].point).toEqual({ x: 80, y: 80 });
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.text).toBe('package com.example.app\nclass MainActivity {}');
  }
});

test('get text answers from the captured tree when the bound owner advertises no live read', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'get-text-no-live-read';
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
  elementReadFixtureState.readTextAtPointAvailable = false;

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
    ...getRuntimeBindings(),
  });

  // Preferred-operation absence is not a failure and not a fallback: the required capture path
  // answers completely, and nothing reaches the legacy dispatcher.
  expect(mockReadTextAtPoint).not.toHaveBeenCalled();
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.text).toBe('preview only');
  }
});

// ADR 0019 regression: `get` declares `device-runtime`, so an ELIGIBLE direct-iOS selector —
// one the fast path would otherwise answer without a tree capture — must not reach the device
// until the request has resolved, admitted, and bound. A refused admission means zero runner
// queries, not a fast-path answer that skipped exact-owner facts entirely.
test('an eligible direct iOS selector cannot operate before admission', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'get-text-direct-before-admission';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  elementReadFixtureState.captureSnapshotAvailable = false;
  mockRunAppleRunnerCommand.mockResolvedValue({
    found: true,
    text: 'Ada Lovelace',
    nodes: [{ index: 0, depth: 0, type: 'StaticText', label: 'Ada Lovelace' }],
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'get',
      positionals: ['text', 'id=name'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
  // The whole point: the fast path never ran.
  expect(mockRunAppleRunnerCommand).not.toHaveBeenCalled();
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
});

// The direct-iOS shortcut is RETIRED (#1739): `get` declares `device-runtime`, so a simple
// `id=` selector resolves through the bound capture like every other shape rather than through a
// raw runner query R36 declares no operation for. The cost is real and accepted — this selector
// no longer skips the tree capture.
test('get text simple iOS id selector resolves through the bound capture, not a runner query', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'get-text-ios-direct-selector';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  legacyDispatchCapture.mockResolvedValue({
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
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.text).toBe('Ada Lovelace');
    expect(response.data?.selector).toBe('id="field-name"');
  }
  // No querySelector: the retired bypass was the only caller on this path.
  expect(mockRunAppleRunnerCommand).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ command: 'querySelector' }),
    expect.anything(),
  );
});

test('get text iOS label selector uses snapshot disambiguation instead of runner query', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'get-text-ios-label-selector';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  legacyDispatchCapture.mockResolvedValue({
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
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockRunAppleRunnerCommand).not.toHaveBeenCalled();
  expect(legacyDispatchCapture).toHaveBeenCalledTimes(1);
  expect(legacyDispatchCapture.mock.calls[0]?.[1]).toBe('snapshot');
  if (response?.ok) {
    expect(response.data?.text).toBe('General');
    expect(response.data?.selector).toBe('label="General"');
  }
});

test('is visible preserves CLI snapshot flags during runtime snapshot capture', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'snapshot-flags';
  sessionStore.set(sessionName, makeSession(sessionName));

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
  session.snapshot = makeVisibleButtonSnapshot('Cached action', 'xctest');
  sessionStore.set(sessionName, session);
  legacyDispatchCapture.mockRejectedValue(new Error('unexpected fresh snapshot'));

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
    },
    { snapshotInteractiveOnly: false },
  );
  sessionStore.set(sessionName, session);
  legacyDispatchCapture.mockResolvedValue(makeVisibleButtonSnapshot('Submit order', 'web'));

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

test('is visible passes for list text that inherits viewport visibility from an ancestor', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'visible-list-item';
  sessionStore.set(sessionName, makeSession(sessionName));

  legacyDispatchCapture.mockImplementation(async (_device, command) => {
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
    ...getRuntimeBindings(),
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

  legacyDispatchCapture.mockImplementation(async (_device, command) => {
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
    ...getRuntimeBindings(),
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

  legacyDispatchCapture.mockImplementation(async (_device, command) => {
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
    });
  }
});

// fallow-ignore-next-line complexity
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
  legacyDispatchCapture.mockRejectedValue(new Error('get text @ref must not recapture'));

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
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
});

test('get text @ref warns while the frame is expired (retained evidence still resolves)', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'stale-ref-get-text';
  const session = makeStaleRefSession(sessionName);
  // A device action expired the frame; the read still resolves against the
  // retained frame tree and stays fail-open with a warning (ADR 0014).
  expireRefFrame(session);
  sessionStore.set(sessionName, session);
  legacyDispatchCapture.mockRejectedValue(
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
  legacyDispatchCapture.mockRejectedValue(
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
