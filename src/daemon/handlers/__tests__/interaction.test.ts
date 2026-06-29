import { test, expect, vi, beforeEach } from 'vitest';
import { handleInteractionCommands } from '../interaction.ts';
import type { SessionStore } from '../../session-store.ts';
import type { SessionState } from '../../types.ts';
import type { CommandFlags } from '../../../core/dispatch.ts';
import { attachRefs, type SnapshotBackend } from '../../../kernel/snapshot.ts';
import { AppError } from '../../../kernel/errors.ts';
import { buildSnapshotState } from '../snapshot-capture.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import {
  makeIosSession,
  makeAndroidSession as makeBaseAndroidSession,
  makeMacOsSession as makeBaseMacOsSession,
} from '../../../__tests__/test-utils/session-factories.ts';
import { WEB_DESKTOP_DEVICE } from '../../../__tests__/test-utils/device-fixtures.ts';

const { mockRunIosRunnerCommand } = vi.hoisted(() => ({
  mockRunIosRunnerCommand: vi.fn(),
}));

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({})),
  };
});

vi.mock('../../../platforms/android/input-actions.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/input-actions.ts')>();
  return {
    ...actual,
    getAndroidScreenSize: vi.fn(async () => ({ width: 1344, height: 2992 })),
  };
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

vi.mock('../interaction-snapshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../interaction-snapshot.ts')>();
  return {
    ...actual,
    captureSnapshotForSession: vi.fn(async () => ({
      nodes: [],
      createdAt: 0,
      backend: 'xctest' as const,
    })),
  };
});

vi.mock('../../../platforms/ios/runner-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platforms/ios/runner-client.ts')>();
  return {
    ...actual,
    runIosRunnerCommand: mockRunIosRunnerCommand,
  };
});

import { dispatchCommand } from '../../../core/dispatch.ts';
import {
  getAndroidAppState,
  getAndroidBlockingDialogFocus,
} from '../../../platforms/android/app-lifecycle.ts';
import { getAndroidScreenSize } from '../../../platforms/android/input-actions.ts';
import { captureSnapshotForSession } from '../interaction-snapshot.ts';
const mockDispatch = vi.mocked(dispatchCommand);
const mockGetAndroidAppState = vi.mocked(getAndroidAppState);
const mockGetAndroidBlockingDialogFocus = vi.mocked(getAndroidBlockingDialogFocus);
const mockGetAndroidScreenSize = vi.mocked(getAndroidScreenSize);
const mockCaptureSnapshotForSession = vi.mocked(captureSnapshotForSession);

async function emulateCaptureSnapshotForSession(
  session: SessionState,
  flags: CommandFlags | undefined,
  sessionStore: SessionStore,
  contextFromFlags: (
    flags: CommandFlags | undefined,
    appBundleId?: string,
    traceLogPath?: string,
  ) => Record<string, unknown>,
  options: {
    interactiveOnly: boolean;
    androidFreshnessMode?: 'ref-refresh';
    includeRects?: boolean;
  },
) {
  const effectiveFlags = {
    ...(flags ?? {}),
    snapshotInteractiveOnly: options.interactiveOnly,
  };
  const snapshotData = (await mockDispatch(
    session.device,
    'snapshot',
    [],
    effectiveFlags.out,
    contextFromFlags(effectiveFlags, session.appBundleId, session.trace?.outPath),
  )) as { nodes?: never[]; truncated?: boolean; backend?: SnapshotBackend };
  const snapshot = buildSnapshotState(snapshotData ?? {}, effectiveFlags);
  session.snapshot = snapshot;
  sessionStore.set(session.name, session);
  return snapshot;
}

function makeSession(name: string): SessionState {
  return makeIosSession(name);
}

function makeAndroidSession(name: string): SessionState {
  return makeBaseAndroidSession(name, { appBundleId: 'com.android.settings' });
}

function makeMacOsDesktopSession(name: string): SessionState {
  return makeBaseMacOsSession(name, { surface: 'desktop' });
}

function makeMacOsMenubarSession(name: string): SessionState {
  return makeBaseMacOsSession(name, { surface: 'menubar' });
}

function makeVisibleButtonSnapshot(label: string, backend: SnapshotBackend) {
  return buildSnapshotState(
    {
      nodes: [
        { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
        {
          index: 1,
          parentIndex: 0,
          type: 'Button',
          label,
          rect: { x: 10, y: 20, width: 120, height: 44 },
          hittable: true,
        },
      ],
      backend,
    },
    { snapshotInteractiveOnly: false },
  );
}

const contextFromFlags = (flags: CommandFlags | undefined) => ({
  count: flags?.count,
  intervalMs: flags?.intervalMs,
  delayMs: flags?.delayMs,
  holdMs: flags?.holdMs,
  jitterPx: flags?.jitterPx,
  doubleTap: flags?.doubleTap,
  clickButton: flags?.clickButton,
});

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockGetAndroidAppState.mockReset();
  mockGetAndroidAppState.mockResolvedValue({});
  mockGetAndroidBlockingDialogFocus.mockReset();
  mockGetAndroidBlockingDialogFocus.mockResolvedValue(null);
  mockGetAndroidScreenSize.mockReset();
  mockGetAndroidScreenSize.mockResolvedValue({ width: 1344, height: 2992 });
  mockCaptureSnapshotForSession.mockReset();
  mockCaptureSnapshotForSession.mockImplementation(emulateCaptureSnapshotForSession);
  mockRunIosRunnerCommand.mockReset();
  mockRunIosRunnerCommand.mockResolvedValue({});
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
  mockRunIosRunnerCommand.mockResolvedValue({
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
  expect(mockRunIosRunnerCommand).toHaveBeenCalledWith(
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
  expect(mockRunIosRunnerCommand).not.toHaveBeenCalled();
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
  mockRunIosRunnerCommand.mockRejectedValue(
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

test('press coordinates dispatches press and records as press', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const storedSession = makeSession(sessionName);
  sessionStore.set(sessionName, storedSession);

  mockDispatch.mockResolvedValue({ ok: true });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['100', '200'],
      flags: { count: 3, intervalMs: 1, doubleTap: true },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('press');
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['100', '200']);
  const context = mockDispatch.mock.calls[0]?.[4] as Record<string, unknown> | undefined;
  expect(context?.count).toBe(3);
  expect(context?.intervalMs).toBe(1);
  expect(context?.doubleTap).toBe(true);

  const session = sessionStore.get(sessionName);
  expect(session).toBeTruthy();
  expect(session?.actions.length).toBe(1);
  expect(session?.actions[0]?.command).toBe('press');
  expect(session?.actions[0]?.positionals).toEqual(['100', '200']);
});

test('click simple iOS id selector uses direct runner selector tap without snapshot', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-direct-selector';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatch.mockResolvedValue({
    message: 'tapped',
    x: 80,
    y: 100,
    referenceWidth: 390,
    referenceHeight: 844,
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['id="submit"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockRunIosRunnerCommand).not.toHaveBeenCalled();
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  const pressCalls = mockDispatch.mock.calls.filter((call) => call[1] === 'press');
  expect(pressCalls.length).toBe(1);
  expect(pressCalls[0]?.[2]).toEqual([]);
  expect((pressCalls[0]?.[4] as Record<string, unknown>)?.directElementSelector).toEqual({
    key: 'id',
    value: 'submit',
    raw: 'id="submit"',
  });
  if (response?.ok) {
    expect(response.data?.selector).toBe('id="submit"');
  }
});

test('fill simple iOS id selector uses direct runner selector fill without snapshot coordinates', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-direct-selector-fill';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatch.mockResolvedValue({
    message: 'filled',
    x: 439.5,
    y: 100.5,
    referenceWidth: 440,
    referenceHeight: 956,
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['id="email"', 'ada@example.com'],
      flags: { delayMs: 25 },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('fill');
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['ada@example.com']);
  const context = mockDispatch.mock.calls[0]?.[4] as Record<string, unknown>;
  expect(context.directElementSelector).toEqual({
    key: 'id',
    value: 'email',
    raw: 'id="email"',
  });
  expect(context.delayMs).toBe(25);
  if (response?.ok) {
    expect(response.data?.selector).toBe('id="email"');
    expect(response.data?.text).toBe('ada@example.com');
  }
});

test('click simple iOS selector forwards Maestro non-hittable coordinate fallback', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-maestro-selector-fallback';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatch.mockResolvedValue({
    message: 'tapped via non-hittable coordinate fallback',
    x: 439.5,
    y: 101.5,
    referenceWidth: 440,
    referenceHeight: 956,
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['id="hiddenTestLogin"'],
      flags: { maestro: { allowNonHittableCoordinateFallback: true } },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  const pressCalls = mockDispatch.mock.calls.filter((call) => call[1] === 'press');
  expect(pressCalls.length).toBe(1);
  expect((pressCalls[0]?.[4] as Record<string, unknown>)?.directElementSelector).toEqual({
    key: 'id',
    value: 'hiddenTestLogin',
    raw: 'id="hiddenTestLogin"',
    allowNonHittableCoordinateFallback: true,
  });
  if (response?.ok) {
    expect(response.data?.maestroNonHittableCoordinateFallbackAllowed).toBe(true);
    expect(response.data?.maestroNonHittableCoordinateFallbackUsed).toBe(true);
    expect(response.data?.maestroFallbackReason).toBe('non-hittable-coordinate');
  }
});

test('click simple iOS id selector falls back to snapshot coordinates on transport failure', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-direct-selector-fallback-transport';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatch.mockImplementation(async (_device, command, positionals, _out, context) => {
    if (command === 'press' && (context as Record<string, unknown>)?.directElementSelector) {
      throw new AppError('COMMAND_FAILED', 'fetch failed');
    }
    if (command === 'snapshot') {
      return {
        nodes: attachRefs([
          {
            index: 0,
            type: 'Window',
            rect: { x: 0, y: 0, width: 390, height: 844 },
          },
          {
            index: 1,
            parentIndex: 0,
            type: 'XCUIElementTypeButton',
            identifier: 'submit',
            rect: { x: 20, y: 80, width: 120, height: 40 },
            enabled: true,
            hittable: true,
          },
        ]),
        backend: 'xctest',
      };
    }
    if (command === 'press') {
      return { x: Number(positionals[0]), y: Number(positionals[1]), pressed: true };
    }
    return {};
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['id="submit"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  const pressCalls = mockDispatch.mock.calls.filter((call) => call[1] === 'press');
  expect(pressCalls.length).toBe(2);
  expect(pressCalls[0]?.[2]).toEqual([]);
  expect(pressCalls[1]?.[2]).toEqual(['80', '100']);
  if (response?.ok) {
    expect(response.data?.selectorChain).toContain('id="submit"');
  }
});

test('click simple iOS id selector does not snapshot-fallback on runner element miss', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-direct-selector-element-miss';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatch.mockImplementation(async (_device, command, _positionals, _out, context) => {
    if (command === 'press' && (context as Record<string, unknown>)?.directElementSelector) {
      throw new AppError('ELEMENT_NOT_FOUND', 'element not found');
    }
    if (command === 'snapshot') {
      throw new Error('snapshot fallback should not run');
    }
    return {};
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['id="submit"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(false);
  if (response?.ok === false) {
    expect(response.error.code).toBe('ELEMENT_NOT_FOUND');
  }
  expect(mockDispatch.mock.calls.filter((call) => call[1] === 'snapshot')).toHaveLength(0);
});

test('click simple iOS id selector does not snapshot-fallback on ambiguous runner match', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-direct-selector-ambiguous';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatch.mockImplementation(async (_device, command, _positionals, _out, context) => {
    if (command === 'press' && (context as Record<string, unknown>)?.directElementSelector) {
      throw new AppError('AMBIGUOUS_MATCH', 'Selector matched multiple elements');
    }
    if (command === 'snapshot') {
      throw new Error('snapshot fallback should not run');
    }
    return {};
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['id="submit"'],
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
  expect(mockDispatch.mock.calls.filter((call) => call[1] === 'snapshot')).toHaveLength(0);
});

test('click simple iOS id selector waits for snapshot path after pending gesture stabilization', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-direct-selector-after-swipe';
  const session = makeIosSession(sessionName, { appBundleId: 'com.example.app' });
  session.postGestureStabilization = { action: 'swipe', markedAt: Date.now() };
  sessionStore.set(sessionName, session);

  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    if (command === 'snapshot') {
      return {
        nodes: attachRefs([
          {
            index: 0,
            type: 'Window',
            rect: { x: 0, y: 0, width: 390, height: 844 },
          },
          {
            index: 1,
            parentIndex: 0,
            type: 'XCUIElementTypeButton',
            identifier: 'shipping-pickup',
            rect: { x: 126, y: 555, width: 75, height: 38 },
            enabled: true,
            hittable: true,
          },
        ]),
        backend: 'xctest',
      };
    }
    if (command === 'press') {
      return { x: Number(positionals[0]), y: Number(positionals[1]), pressed: true };
    }
    return {};
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['id="shipping-pickup"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  const pressCalls = mockDispatch.mock.calls.filter((call) => call[1] === 'press');
  expect(pressCalls.length).toBe(1);
  expect((pressCalls[0]?.[4] as Record<string, unknown>)?.directElementSelector).toBeUndefined();
  expect(pressCalls[0]?.[2]).toEqual(['164', '574']);
});

test('click rejects macOS desktop surface interactions until helper routing exists', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-desktop-click';
  sessionStore.set(sessionName, makeMacOsDesktopSession(sessionName));

  mockDispatch.mockRejectedValue(new Error('dispatch should not be called'));

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['100', '200'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/macOS desktop sessions/);
  }
});

test('click on a macOS menubar wrapper ref promotes to the same-rect menu bar item', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-menubar-wrapper-ref-click';
  const session = makeMacOsMenubarSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        depth: 0,
        type: 'MenuBarSurface',
        label: 'Menu Bar',
        surface: 'menubar',
        rect: { x: 0, y: 0, width: 1512, height: 982 },
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'MenuBar',
        rect: { x: 989, y: 4.5, width: 29, height: 24 },
        hittable: true,
        surface: 'menubar',
      },
      {
        index: 2,
        depth: 2,
        parentIndex: 1,
        type: 'MenuBarItem',
        rect: { x: 989, y: 4.5, width: 29, height: 24 },
        hittable: true,
        surface: 'menubar',
      },
    ]),
    createdAt: Date.now(),
    backend: 'macos-helper',
  };
  sessionStore.set(sessionName, session);

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['@e2'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('press');
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['1004', '17']);
  if (response?.ok) {
    expect(response.data?.selectorChain).toEqual(['role="menubaritem"']);
  }
});

test('fill rejects macOS menubar surface interactions until helper routing exists', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-menubar-fill';
  sessionStore.set(sessionName, makeMacOsMenubarSession(sessionName));

  mockDispatch.mockRejectedValue(new Error('dispatch should not be called'));

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e2', 'hello'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/macOS menubar sessions/);
  }
});

// fallow-ignore-next-line complexity
test('press coordinates appends touch-visualization events while recording', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeApplication',
        rect: { x: 0, y: 0, width: 402, height: 874 },
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  session.recording = {
    platform: 'ios',
    outPath: '/tmp/demo.mp4',
    startedAt: Date.now() - 1_000,
    showTouches: true,
    gestureEvents: [],
    child: { kill: () => {} } as any,
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({
    ok: true,
    videoPath: '/tmp/demo.mp4',
    artifactUri: 'agent-device://artifacts/demo.mp4',
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['100', '200'],
      flags: { count: 2, intervalMs: 150, doubleTap: true },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  const recorded = sessionStore.get(sessionName)?.recording;
  expect(recorded).toBeTruthy();
  expect(recorded?.gestureEvents.length).toBe(4);
  expect(recorded?.gestureEvents[0]?.kind).toBe('tap');
  expect(recorded?.gestureEvents[0]?.x).toBe(100);
  expect(recorded?.gestureEvents[0]?.y).toBe(200);
  expect(recorded?.gestureEvents[0]?.referenceWidth).toBe(402);
  expect(recorded?.gestureEvents[0]?.referenceHeight).toBe(874);
  const actionResult = sessionStore.get(sessionName)?.actions[0]?.result;
  expect(actionResult?.videoPath).toBe('/tmp/demo.mp4');
  expect(actionResult?.artifactUri).toBe('agent-device://artifacts/demo.mp4');
  if (response?.ok) {
    expect(response.data?.videoPath).toBe('/tmp/demo.mp4');
    expect(response.data?.artifactUri).toBe('agent-device://artifacts/demo.mp4');
  }
});

test('press coordinates on iOS recording captures a full snapshot for the touch reference frame', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-direct-press-frame';
  const session = makeSession(sessionName);
  session.snapshot = undefined;
  session.recording = {
    platform: 'ios',
    outPath: '/tmp/demo.mp4',
    startedAt: Date.now() - 1_000,
    showTouches: true,
    gestureEvents: [],
    child: { kill: () => {} } as any,
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ x: 220, y: 600 });
  // Regression: a filtered snapshot has no Application/Window node, so viewport inference would
  // return a leaf-element bounding box and the recording overlay would misplace tap markers.
  mockCaptureSnapshotForSession.mockResolvedValueOnce({
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeApplication',
        rect: { x: 0, y: 0, width: 440, height: 956 },
      },
      {
        index: 1,
        type: 'XCUIElementTypeCell',
        rect: { x: 16, y: 156, width: 370, height: 52 },
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['220', '600'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockCaptureSnapshotForSession.mock.calls[0]?.[4]).toEqual({
    interactiveOnly: true,
  });
  const event = sessionStore.get(sessionName)?.recording?.gestureEvents[0];
  expect(event?.kind).toBe('tap');
  expect(event?.referenceWidth).toBe(440);
  expect(event?.referenceHeight).toBe(956);
});

test('press coordinates on Android recording uses physical screen size when no snapshot exists', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-direct-press-frame';
  const session = makeAndroidSession(sessionName);
  session.recording = {
    platform: 'android',
    outPath: '/tmp/demo.mp4',
    remotePath: '/sdcard/demo.mp4',
    remotePid: '1234',
    startedAt: Date.now() - 1_000,
    showTouches: true,
    gestureEvents: [],
  };
  session.snapshot = undefined;
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ x: 300, y: 2300 });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['300', '2300'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  const event = sessionStore.get(sessionName)?.recording?.gestureEvents[0];
  expect(event?.kind).toBe('tap');
  expect(event?.referenceWidth).toBe(1344);
  expect(event?.referenceHeight).toBe(2992);
});

test('press coordinates on Android recording caches physical screen size across interactions', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-direct-press-frame-cache';
  const session = makeAndroidSession(sessionName);
  session.recording = {
    platform: 'android',
    outPath: '/tmp/demo.mp4',
    remotePath: '/sdcard/demo.mp4',
    remotePid: '1234',
    startedAt: Date.now() - 1_000,
    showTouches: true,
    gestureEvents: [],
  };
  session.snapshot = undefined;
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ x: 300, y: 2300 });

  await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['300', '2300'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  mockDispatch.mockResolvedValue({ x: 320, y: 2200 });

  await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['320', '2200'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(mockGetAndroidScreenSize).toHaveBeenCalledTimes(1);
  const recording = sessionStore.get(sessionName)?.recording;
  expect(recording?.touchReferenceFrame).toEqual({
    referenceWidth: 1344,
    referenceHeight: 2992,
  });
});

test('press coordinates without recording skips Android screen-size lookup', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-direct-press-no-recording';
  const session = makeAndroidSession(sessionName);
  session.snapshot = undefined;
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ x: 300, y: 2300 });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['300', '2300'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockGetAndroidScreenSize).not.toHaveBeenCalled();
});

test('press coordinates during recording still dispatches when Android screen-size lookup fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-direct-press-screen-size-failure';
  const session = makeAndroidSession(sessionName);
  session.recording = {
    platform: 'android',
    outPath: '/tmp/demo.mp4',
    remotePath: '/sdcard/demo.mp4',
    remotePid: '1234',
    startedAt: Date.now() - 1_000,
    showTouches: true,
    gestureEvents: [],
  };
  session.snapshot = undefined;
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ x: 300, y: 2300 });
  mockGetAndroidScreenSize.mockRejectedValue(new Error('adb unavailable'));

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['300', '2300'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  const event = sessionStore.get(sessionName)?.recording?.gestureEvents[0];
  expect(event?.kind).toBe('tap');
  expect(event?.x).toBe(300);
  expect(event?.y).toBe(2300);
  expect(event?.referenceWidth).toBeUndefined();
  expect(event?.referenceHeight).toBeUndefined();
});

test('press @ref preserves native timing in recorded result and touch visualization', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        identifier: 'auth_continue',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  session.recording = {
    platform: 'ios',
    outPath: '/tmp/demo.mp4',
    startedAt: 1_000,
    showTouches: true,
    gestureEvents: [],
    child: { kill: () => {} } as any,
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  };
  sessionStore.set(sessionName, session);

  const originalNow = Date.now;
  let now = 1_500;
  Date.now = () => now;

  try {
    mockDispatch.mockImplementation(async () => {
      now = 1_650;
      return {
        gestureStartUptimeMs: 5_100,
        gestureEndUptimeMs: 5_180,
      };
    });

    const response = await handleInteractionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'press',
        positionals: ['@e1'],
        flags: {},
      },
      sessionName,
      sessionStore,
      contextFromFlags,
    });

    expect(response?.ok).toBe(true);
  } finally {
    Date.now = originalNow;
  }

  const stored = sessionStore.get(sessionName);
  const result = (stored?.actions[0]?.result ?? {}) as Record<string, unknown>;
  expect(result.gestureStartUptimeMs).toBe(5_100);
  expect(result.gestureEndUptimeMs).toBe(5_180);
  expect(stored?.recording?.gestureEvents[0]?.tMs).toBe(570);
});

test('press @ref stores resolved coordinate retry payload for lazy outcome retry', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'retry-ref';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        identifier: 'auth_continue',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);
  mockDispatch.mockResolvedValue({});

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e1'],
      flags: { interactionOutcome: { retryOnNoChange: true } },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  const stored = sessionStore.get(sessionName);
  expect(stored?.pendingInteractionOutcome?.command).toBe('press');
  expect(stored?.pendingInteractionOutcome?.positionals).toEqual(['60', '40']);
  expect(stored?.actions[0]?.positionals).toEqual(['@e1']);
  expect(stored?.actions[0]?.flags).toEqual({});
});

test('longpress @ref resolves the target and dispatches coordinate longpress', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'longpress-ref';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeStaticText',
        label: 'Last message',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ native: true });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'longpress',
      positionals: ['@e1', '800'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.x).toBe(60);
    expect(response.data?.y).toBe(40);
    expect(response.data?.durationMs).toBe(800);
    expect(response.data?.message).toMatch(/Long pressed @e1/);
  }
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('longpress');
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['60', '40', '800']);
  expect(sessionStore.get(sessionName)?.actions[0]?.command).toBe('longpress');
});

test('press @ref refreshes stale stored refs and syncs the daemon session snapshot', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'stale-ref-refresh';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') {
      return {
        nodes: [
          {
            index: 0,
            type: 'XCUIElementTypeButton',
            label: 'Continue',
            rect: { x: 10, y: 20, width: 100, height: 40 },
            enabled: true,
            hittable: true,
          },
        ],
        backend: 'xctest',
      };
    }
    return { pressed: true };
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e1'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.x).toBe(60);
    expect(response.data?.y).toBe(40);
  }
  expect(mockDispatch.mock.calls.map((call) => call[1])).toEqual(['snapshot', 'press']);
  expect(sessionStore.get(sessionName)?.snapshot?.nodes[0]?.rect).toEqual({
    x: 10,
    y: 20,
    width: 100,
    height: 40,
  });
});

test('press @ref refreshes Android snapshot when freshness tracking is active', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-fresh-ref-refresh';
  const session = makeAndroidSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Continue',
        rect: { x: 0, y: 0, width: 40, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: 1,
    routeComparable: false,
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockImplementation(async (_device, command, args) => {
    if (command === 'snapshot') {
      return {
        nodes: [
          {
            index: 0,
            type: 'android.widget.Button',
            label: 'Continue',
            rect: { x: 100, y: 200, width: 80, height: 40 },
            enabled: true,
            hittable: true,
          },
        ],
        backend: 'android',
      };
    }
    return { pressed: true, args };
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e1', 'Continue'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockCaptureSnapshotForSession.mock.calls[0]?.[4]).toEqual({
    interactiveOnly: true,
    androidFreshnessMode: 'ref-refresh',
  });
  expect(mockDispatch.mock.calls.map((call) => call[1])).toEqual(['snapshot', 'press']);
  expect(mockDispatch.mock.calls[1]?.[2]).toEqual(['140', '220']);
  expect(sessionStore.get(sessionName)?.androidSnapshotFreshness).toMatchObject({
    action: 'press',
    baselineCount: 1,
    routeComparable: true,
  });
});

test('press @ref falls back to cached Android ref when freshness refresh fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-fresh-ref-refresh-failure';
  const session = makeAndroidSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Continue',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: 1,
    routeComparable: true,
  };
  sessionStore.set(sessionName, session);

  mockCaptureSnapshotForSession.mockRejectedValueOnce(new Error('uiautomator timeout'));
  mockDispatch.mockResolvedValue({ pressed: true });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e1', 'Continue'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockCaptureSnapshotForSession).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls.map((call) => call[1])).toEqual(['press']);
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['60', '40']);
  expect(sessionStore.get(sessionName)?.androidSnapshotFreshness).toMatchObject({
    action: 'press',
    baselineCount: 1,
    routeComparable: true,
  });
});

test('coordinate press preserves Android route freshness from last comparable snapshot', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-coordinate-freshness-baseline';
  const session = makeAndroidSession(sessionName);
  const comparableSnapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.ScrollView',
        label: 'Albums',
        rect: { x: 0, y: 0, width: 400, height: 700 },
      },
      {
        index: 1,
        type: 'android.widget.Button',
        label: 'Go to Contacts',
        rect: { x: 16, y: 120, width: 160, height: 48 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android' as const,
    comparisonSafe: true,
  };
  session.lastComparisonSafeSnapshot = comparableSnapshot;
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Go to Contacts',
        rect: { x: 16, y: 120, width: 160, height: 48 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: false,
  };
  sessionStore.set(sessionName, session);
  mockDispatch.mockResolvedValue({ pressed: true });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['96', '144'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(sessionStore.get(sessionName)?.androidSnapshotFreshness).toMatchObject({
    action: 'press',
    baselineCount: 2,
    baselineSignatures: expect.any(Array),
    routeComparable: true,
  });
});

test('press @ref fails when Android tap escapes to launcher', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-escape';
  const session = makeAndroidSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Pay',
        rect: { x: 16, y: 40, width: 120, height: 48 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ pressed: true });
  mockGetAndroidAppState.mockResolvedValue({
    package: 'com.google.android.apps.nexuslauncher',
    activity: 'Launcher',
  });

  await expect(
    handleInteractionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'press',
        positionals: ['@e1'],
        flags: {},
      },
      sessionName,
      sessionStore,
      contextFromFlags,
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringContaining('tap likely escaped the app'),
  });
  expect(sessionStore.get(sessionName)?.actions).toEqual([]);
});

test('press @ref fails when Android tap escapes to Settings', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-settings-escape';
  const session = makeAndroidSession(sessionName);
  session.appBundleId = 'com.agentdevice.tester';
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Open Adam',
        rect: { x: 16, y: 40, width: 120, height: 48 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ pressed: true });
  mockGetAndroidAppState.mockResolvedValue({
    package: 'com.android.settings',
    activity: 'Settings',
  });

  await expect(
    handleInteractionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'press',
        positionals: ['@e1'],
        flags: {},
      },
      sessionName,
      sessionStore,
      contextFromFlags,
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringContaining('foregrounded com.android.settings'),
  });
});

test('press @ref promotes a non-hittable node to its hittable ancestor before tapping', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeCell',
        label: 'Settings row',
        rect: { x: 20, y: 100, width: 320, height: 72 },
        enabled: true,
        hittable: true,
      },
      {
        index: 1,
        parentIndex: 0,
        type: 'XCUIElementTypeStaticText',
        label: 'Settings',
        rect: { x: 44, y: 124, width: 84, height: 20 },
        enabled: false,
        hittable: false,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ pressed: true });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e2'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.ref).toBe('e2');
    expect(response.data?.x).toBe(180);
    expect(response.data?.y).toBe(136);
  }
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('press');
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['180', '136']);

  const stored = sessionStore.get(sessionName);
  const result = (stored?.actions[0]?.result ?? {}) as Record<string, unknown>;
  expect(result.ref).toBe('e2');
  expect(Array.isArray(result.selectorChain)).toBe(true);
});

test('press @ref does not promote to a full-screen hittable ancestor', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeWindow',
        rect: { x: 0, y: 0, width: 402, height: 874 },
        enabled: true,
        hittable: true,
      },
      {
        index: 1,
        parentIndex: 0,
        type: 'XCUIElementTypeCell',
        label: 'General',
        rect: { x: 16, y: 293, width: 370, height: 52 },
        enabled: true,
        hittable: false,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ pressed: true });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e2'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.x).toBe(201);
    expect(response.data?.y).toBe(319);
  }
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['201', '319']);
});

test('fill @ref preserves fallback coordinates for recording when platform result is sparse', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        identifier: 'auth_email',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  session.recording = {
    platform: 'ios',
    outPath: '/tmp/demo.mp4',
    startedAt: Date.now() - 1_000,
    showTouches: true,
    gestureEvents: [],
    child: { kill: () => {} } as any,
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ filled: true });
  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e1', 'hello@example.com'],
      flags: { delayMs: 55 },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.filled).toBe(true);
    expect(response.data?.x).toBeUndefined();
  }

  const stored = sessionStore.get(sessionName);
  expect(stored).toBeTruthy();
  const fillCalls = mockDispatch.mock.calls.filter((c) => c[1] === 'fill');
  expect(fillCalls.length).toBe(1);
  expect((fillCalls[0]?.[4] as Record<string, unknown> | undefined)?.delayMs).toBe(55);
  const result = (stored?.actions[0]?.result ?? {}) as Record<string, unknown>;
  expect(result.ref).toBe('e1');
  expect(result.x).toBe(60);
  expect(result.y).toBe(40);
  expect(Array.isArray(result.selectorChain)).toBe(true);

  const event = stored?.recording?.gestureEvents[0];
  expect(event?.kind).toBe('tap');
  expect(event?.x).toBe(60);
  expect(event?.y).toBe(40);
});

test('fill @ref keeps the original editable node when its parent is the hittable ancestor', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeCell',
        label: 'Email row',
        rect: { x: 20, y: 100, width: 320, height: 72 },
        enabled: true,
        hittable: true,
      },
      {
        index: 1,
        parentIndex: 0,
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        identifier: 'auth_email',
        rect: { x: 44, y: 120, width: 200, height: 32 },
        enabled: true,
        hittable: false,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ filled: true });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e2', 'hello@example.com'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  const fillCalls = mockDispatch.mock.calls.filter((c) => c[1] === 'fill');
  expect(fillCalls.length).toBe(1);
  expect(fillCalls[0]?.[2]).toEqual(['144', '136', 'hello@example.com']);

  const stored = sessionStore.get(sessionName);
  const result = (stored?.actions[0]?.result ?? {}) as Record<string, unknown>;
  expect(result.ref).toBe('e2');
});

test('click --button secondary on @ref dispatches a secondary press on macOS and records click', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.device = {
    platform: 'macos',
    id: 'macos-desktop',
    name: 'My Mac',
    kind: 'device',
    booted: true,
  };
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeCell',
        label: 'failed-step.json',
        rect: { x: 400, y: 500, width: 200, height: 20 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ button: 'secondary' });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['@e1'],
      flags: { clickButton: 'secondary' },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('press');
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['500', '510']);
  const context = mockDispatch.mock.calls[0]?.[4] as Record<string, unknown> | undefined;
  expect(context?.clickButton).toBe('secondary');
  if (response?.ok) {
    expect(response.data?.button).toBe('secondary');
    expect(response.data?.ref).toBe('e1');
  }

  const stored = sessionStore.get(sessionName);
  expect(stored).toBeTruthy();
  expect(stored?.actions[0]?.command).toBe('click');
  expect(stored?.actions[0]?.flags.clickButton).toBe('secondary');
});

test('click --button middle on macOS fails with an explicit unsupported-operation error', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.device = {
    platform: 'macos',
    id: 'macos-desktop',
    name: 'My Mac',
    kind: 'device',
    booted: true,
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockRejectedValue(
    new Error('dispatch should not be called for unsupported middle click'),
  );

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['100', '200'],
      flags: { clickButton: 'middle' },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/middle is not supported/i);
  }
});

test('press @ref refreshes snapshot when stored ref bounds are invalid', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.device = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel 8 Pro',
    kind: 'emulator',
    booted: true,
  };
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.TextView',
        label: 'My App',
        rect: { x: 20, y: 40, width: Number.NaN, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.set(sessionName, session);

  let snapshotCalls = 0;
  mockDispatch.mockImplementation(async (_device, command, _positionals) => {
    if (command === 'snapshot') {
      snapshotCalls += 1;
      return {
        nodes: [
          {
            index: 0,
            type: 'android.widget.TextView',
            label: 'My App',
            rect: { x: 20, y: 40, width: 100, height: 40 },
            enabled: true,
            hittable: true,
          },
        ],
        backend: 'android',
      };
    }
    return { pressed: true };
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e1'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(snapshotCalls).toBe(1);
  const pressCalls = mockDispatch.mock.calls.filter((c) => c[1] === 'press');
  expect(pressCalls.length).toBe(1);
  expect(pressCalls[0]?.[2]).toEqual(['70', '60']);
  if (response?.ok) {
    expect(response.data?.x).toBe(70);
    expect(response.data?.y).toBe(60);
    expect(response.data?.ref).toBe('e1');
  }
});

test('press @ref fails fast when the target is off-screen', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'press-offscreen-ref';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
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
        type: 'XCUIElementTypeButton',
        label: 'Far item',
        rect: { x: 20, y: 1200, width: 120, height: 44 },
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e2'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(mockDispatch).not.toHaveBeenCalled();
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/off-screen/i);
    expect(response.error.hint).toMatch(/scroll.*fresh snapshot/i);
    expect(response.error.details?.reason).toBe('offscreen_ref');
  }
});

test('press @ref fallback label is used after refresh when ref bounds remain invalid', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.device = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel 8 Pro',
    kind: 'emulator',
    booted: true,
  };
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.TextView',
        label: 'My App',
        rect: { x: 20, y: 40, width: Number.NaN, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') {
      return {
        nodes: [
          {
            index: 0,
            type: 'android.widget.TextView',
            label: 'Different',
            rect: { x: 20, y: 40, width: Number.NaN, height: 40 },
            enabled: true,
            hittable: true,
          },
          {
            index: 1,
            type: 'android.widget.TextView',
            label: 'My App',
            rect: { x: 100, y: 200, width: 80, height: 40 },
            enabled: true,
            hittable: true,
          },
        ],
        backend: 'android',
      };
    }
    return { pressed: true };
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e1', 'My App'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  const pressCalls = mockDispatch.mock.calls.filter((c) => c[1] === 'press');
  expect(pressCalls.length).toBe(1);
  expect(pressCalls[0]?.[2]).toEqual(['140', '220']);
  if (response?.ok) {
    expect(response.data?.x).toBe(140);
    expect(response.data?.y).toBe(220);
  }
});

test('fill @ref fails fast when the target is off-screen', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'fill-offscreen-ref';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
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
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        rect: { x: 20, y: 1180, width: 180, height: 44 },
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e2', 'hello@example.com'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(mockDispatch).not.toHaveBeenCalled();
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/off-screen/i);
    expect(response.error.hint).toMatch(/scroll.*fresh snapshot/i);
    expect(response.error.details?.reason).toBe('offscreen_ref');
  }
});

test('fill @ref refreshes snapshot when stored ref bounds are invalid', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.device = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel 8 Pro',
    kind: 'emulator',
    booted: true,
  };
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.EditText',
        label: 'Email',
        rect: { x: 20, y: 40, width: Number.NaN, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.set(sessionName, session);

  let snapshotCalls = 0;
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') {
      snapshotCalls += 1;
      return {
        nodes: [
          {
            index: 0,
            type: 'android.widget.EditText',
            label: 'Email',
            rect: { x: 20, y: 40, width: 100, height: 40 },
            enabled: true,
            hittable: true,
          },
        ],
        backend: 'android',
      };
    }
    return { filled: true };
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e1', 'hello@example.com'],
      flags: { delayMs: 25 },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(snapshotCalls).toBe(1);
  const fillCalls = mockDispatch.mock.calls.filter((c) => c[1] === 'fill');
  expect(fillCalls.length).toBe(1);
  expect(fillCalls[0]?.[2]).toEqual(['70', '60', 'hello@example.com']);
  expect((fillCalls[0]?.[4] as Record<string, unknown> | undefined)?.delayMs).toBe(25);

  const stored = sessionStore.get(sessionName);
  const result = (stored?.actions[0]?.result ?? {}) as Record<string, unknown>;
  expect(result.ref).toBe('e1');
  expect(result.x).toBe(70);
  expect(result.y).toBe(60);
});

test('press coordinates does not treat extra trailing args as selector', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  sessionStore.set(sessionName, makeSession(sessionName));

  mockDispatch.mockResolvedValue({ ok: true });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['100', '200', 'extra'],
      flags: { count: 2 },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('press');
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['100', '200']);
  expect(sessionStore.get(sessionName)?.actions.length).toBe(1);
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
  mockRunIosRunnerCommand.mockResolvedValue({
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
  expect(mockRunIosRunnerCommand).toHaveBeenCalledWith(
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
  mockRunIosRunnerCommand.mockResolvedValue({
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
  session.postGestureStabilization = { action: 'swipe', markedAt: Date.now() };
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
  expect(mockRunIosRunnerCommand).not.toHaveBeenCalled();
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
