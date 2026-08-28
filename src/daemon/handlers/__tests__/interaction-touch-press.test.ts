import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../interaction.ts';
import {
  getRuntimeBindings,
  mockTapPoint,
  resetGetRuntimeFixture,
} from './interaction-get-runtime-fixture.ts';
import {
  contextFromFlags,
  findResolvedTarget,
  makeFindPreresolvedTree,
  makeMacOsMenubarSession,
  makeSession,
  makeStaleRefSession,
  readPressPoint,
  runFindInternalClick,
} from './interaction-touch-fixtures.ts';

// Which node an admitted press/click acts on: hittable-ancestor promotion, the
// macOS menubar wrapper, button projection, and a mutating find's pre-resolved
// node (#1654).

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    getAndroidScreenSize: vi.fn(async () => ({ width: 1344, height: 2992 })),
    getAndroidAppState: vi.fn(async () => ({})),
    getAndroidBlockingDialogObservation: vi.fn(async () => ({ status: 'clear' }) as const),
  };
});

vi.mock('../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

vi.mock('@agent-device/platform-apple', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-apple')>();
  return { ...actual, runAppleRunnerCommand: mockRunAppleRunnerCommand };
});

import {
  getAndroidAppState,
  getAndroidBlockingDialogObservation,
  getAndroidScreenSize,
} from '@agent-device/platform-android/mechanics';
import { captureSnapshotWithInteractor } from '../snapshot-interactor-capture.ts';
const mockGetAndroidAppState = vi.mocked(getAndroidAppState);
const mockGetAndroidBlockingDialogObservation = vi.mocked(getAndroidBlockingDialogObservation);
const mockGetAndroidScreenSize = vi.mocked(getAndroidScreenSize);
const mockCaptureSnapshotForSession = vi.mocked(captureSnapshotWithInteractor);

beforeEach(() => {
  resetGetRuntimeFixture();
  mockGetAndroidAppState.mockReset();
  mockGetAndroidAppState.mockResolvedValue({});
  mockGetAndroidBlockingDialogObservation.mockReset();
  mockGetAndroidBlockingDialogObservation.mockResolvedValue({ status: 'clear' });
  mockGetAndroidScreenSize.mockReset();
  mockGetAndroidScreenSize.mockResolvedValue({ width: 1344, height: 2992 });
  mockCaptureSnapshotForSession.mockReset();
  mockRunAppleRunnerCommand.mockReset();
  mockRunAppleRunnerCommand.mockResolvedValue({});
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
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(readPressPoint(mockTapPoint)).toEqual(['1004', '17']);
  if (response?.ok) {
    expect(response.data?.selectorChain).toEqual(['role="menubaritem"']);
  }
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

  mockTapPoint.mockResolvedValue({ pressed: true });

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
    ...getRuntimeBindings(),
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.ref).toBe('e2');
    expect(response.data?.x).toBe(180);
    expect(response.data?.y).toBe(136);
    // Promotion landed on a hittable ancestor, so there is nothing to flag.
    expect(response.data?.targetHittable).toBeUndefined();
    expect(response.data?.hint).toBeUndefined();
  }
  expect(readPressPoint(mockTapPoint)).toEqual(['180', '136']);

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

  mockTapPoint.mockResolvedValue({ pressed: true });

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
    ...getRuntimeBindings(),
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.x).toBe(201);
    expect(response.data?.y).toBe(319);
    // #1037: the press still proceeds against the non-hittable node (no stricter
    // resolution), but the daemon response flags it so agents can react instead
    // of assuming the tap had a visible effect.
    expect(response.data?.targetHittable).toBe(false);
    expect(typeof response.data?.hint).toBe('string');
    expect(response.data?.hint as string).toMatch(/hittable: false/);
  }
  expect(readPressPoint(mockTapPoint)).toEqual(['201', '319']);
});

test('click --button secondary on @ref dispatches a secondary press on macOS and records click', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.device = {
    platform: 'apple',
    appleOs: 'macos',
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

  mockTapPoint.mockResolvedValue({ button: 'secondary' });

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
    ...getRuntimeBindings(),
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(readPressPoint(mockTapPoint)).toEqual(['500', '510']);
  expect(mockTapPoint.mock.calls[0]?.[0].options.button).toBe('secondary');
  if (response?.ok) {
    expect(response.data?.button).toBe('secondary');
    expect(response.data?.ref).toBe('e1');
  }

  const stored = sessionStore.get(sessionName);
  expect(stored).toBeTruthy();
  expect(stored?.actions[0]?.command).toBe('click');
  expect(stored?.actions[0]?.flags.clickButton).toBe('secondary');
});

test('#1654: a mutating find click acts on the node find resolved, not a re-resolved @ref', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'find-preresolved-click';
  sessionStore.set(sessionName, makeStaleRefSession(sessionName));
  const preresolved = makeFindPreresolvedTree();

  const response = await runFindInternalClick(sessionStore, sessionName, {
    findResolvedTarget: findResolvedTarget(preresolved),
  });

  expect(response?.ok).toBe(true);
  // find's node — (300,500,20,20) → (310, 510). A second resolution would read
  // @e2 out of the SESSION frame tree instead and tap (60, 40).
  expect(readPressPoint(mockTapPoint)).toEqual(['310', '510']);
});

test('#1654 control: without the resolved-target payload the same click still resolves @ref from the session tree', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'find-preresolved-control';
  sessionStore.set(sessionName, makeStaleRefSession(sessionName));

  const response = await runFindInternalClick(sessionStore, sessionName, {});

  // The ordinary ref path is untouched: @e1 is "Continue" at (10,20,100,40).
  expect(response?.ok).toBe(true);
  expect(readPressPoint(mockTapPoint)).toEqual(['60', '40']);
});

test('#1654: the leaf performs no ref lookup at all — a session that could not resolve @e2 still acts', async () => {
  // Defensive proof of the structural contract: this synthetic session has no
  // stored snapshot, so any second resolution necessarily fails ("Ref @e2 not
  // found or has no bounds"). Production find normally stores its capture;
  // this test proves lookup absence without claiming that missing state occurs.
  const sessionStore = makeSessionStore();
  const sessionName = 'find-preresolved-no-session-tree';
  const session = makeSession(sessionName);
  session.snapshot = undefined;
  sessionStore.set(sessionName, session);
  const preresolved = makeFindPreresolvedTree();

  const withoutPreresolution = await runFindInternalClick(sessionStore, sessionName, {});
  expect(withoutPreresolution?.ok).toBe(false);

  const response = await runFindInternalClick(sessionStore, sessionName, {
    findResolvedTarget: findResolvedTarget(preresolved),
  });

  expect(response?.ok).toBe(true);
  expect(readPressPoint(mockTapPoint)).toEqual(['310', '510']);
});

test('#1654: the shared guards still run on the pre-resolved node', async () => {
  // The pre-resolution replaces the lookup, not the guarantees: an occluded
  // node is still refused, at the same ADR 0011 `runtime-ref` occlusion cell.
  const sessionStore = makeSessionStore();
  const sessionName = 'find-preresolved-occluded';
  sessionStore.set(sessionName, makeStaleRefSession(sessionName));
  const preresolved = makeFindPreresolvedTree();
  const blocked = {
    ...preresolved.node,
    interactionBlocked: { by: 'overlay', reason: 'covered' as const },
  };

  const response = await runFindInternalClick(sessionStore, sessionName, {
    findResolvedTarget: { ref: '@e2', node: blocked, nodes: [preresolved.nodes[0]!, blocked] },
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toContain('covered by another visible element');
  }
  expect(readPressPoint(mockTapPoint)).toBeUndefined();
});
