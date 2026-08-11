import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import type { SessionStore } from '../../session-store.ts';
import { handleInteractionCommands } from '../interaction.ts';
import {
  contextFromFlags,
  createEmulateCaptureSnapshotForSession,
  makeMacOsMenubarSession,
  makeSession,
  makeStaleRefSession,
} from './interaction-touch-fixtures.ts';

// How press/click/longpress targets are admitted and executed: surface and
// button policy, ref targeting and guards, and pre-resolved `find` dispatches.

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
import { captureSnapshotForSession } from '../interaction-snapshot.ts';
const mockCaptureSnapshotForSession = vi.mocked(captureSnapshotForSession);

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockCaptureSnapshotForSession.mockReset();
  mockCaptureSnapshotForSession.mockImplementation(
    createEmulateCaptureSnapshotForSession(mockDispatch),
  );
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
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('press');
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['1004', '17']);
  if (response?.ok) {
    expect(response.data?.selectorChain).toEqual(['role="menubaritem"']);
  }
});

test('press @ref fails closed when the authorized ref has no usable bounds (ADR 0014)', async () => {
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

  mockDispatch.mockRejectedValue(
    new Error('dispatch must not run: no positional recapture on missing frame evidence'),
  );

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

  // ADR 0014: the authorized frame's @e1 has no usable rect, so the ref FAILS
  // rather than recapturing and accepting the same index from a newer tree by
  // positional coincidence. No fresh capture, no dispatch.
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/not found or has no bounds/);
  }
  expect(mockDispatch).not.toHaveBeenCalled();
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
    // Promotion landed on a hittable ancestor, so there is nothing to flag.
    expect(response.data?.targetHittable).toBeUndefined();
    expect(response.data?.hint).toBeUndefined();
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
    // #1037: the press still proceeds against the non-hittable node (no stricter
    // resolution), but the daemon response flags it so agents can react instead
    // of assuming the tap had a visible effect.
    expect(response.data?.targetHittable).toBe(false);
    expect(typeof response.data?.hint).toBe('string');
    expect(response.data?.hint as string).toMatch(/hittable: false/);
  }
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['201', '319']);
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
    platform: 'apple',
    appleOs: 'macos',
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

test('press @ref fails closed when stored ref bounds are invalid (ADR 0014)', async () => {
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

  mockDispatch.mockRejectedValue(
    new Error('dispatch must not run: no positional recapture on unusable frame evidence'),
  );

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

  // ADR 0014: the authorized frame's @e1 has an unusable rect (NaN), so it FAILS
  // rather than recapturing and accepting the same index from a newer tree.
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/not found or has no bounds/);
  }
  expect(mockDispatch).not.toHaveBeenCalled();
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
    // #1366: the hint names the concrete scroll direction, steers to a
    // selector-based retry (a @ref would be rejected as expired after the scroll),
    // and prescribes bounded movement (a large fling scroll overshoots).
    expect(response.error.hint).toMatch(/scroll down/i);
    expect(response.error.hint).toMatch(/selector/i);
    expect(response.error.hint).toMatch(/small steps/i);
    expect(response.error.hint).toMatch(/gesture pan/i);
    expect(response.error.details?.reason).toBe('offscreen_ref');
    expect(response.error.details?.scrollDirection).toBe('down');
  }
});

test('press @ref with a trailing label recovers within the authorized frame (no positional recapture)', async () => {
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
  // @e1's rect is unusable, but the SAME frame tree carries another node with
  // the trailing label at usable bounds. ADR 0014 label recovery resolves within
  // the authorized frame — never by recapturing a fresh tree.
  session.snapshot = {
    nodes: attachRefs([
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
    ]),
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') throw new Error('no positional recapture: recovery stays in-frame');
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
    expect(response.data?.resolution).toEqual({
      source: 'ref',
      phase: 'pre-action',
      kind: 'label-fallback',
    });
  }
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

// #1654: the tree a mutating `find` matched against, deliberately NOT the tree
// stored on the session. `@e2` names the "Continue" button in both trees, but
// at a distinctive point here and at (60, 40) in the session frame tree — so
// the tap coordinates say which tree the leaf actually resolved against.
function makeFindPreresolvedTree() {
  const nodes = attachRefs([
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Continue',
      rect: { x: 300, y: 500, width: 20, height: 20 },
      enabled: true,
      hittable: true,
    },
  ] as never);
  return { nodes, node: nodes[1] as NonNullable<(typeof nodes)[number]> };
}

function findResolvedTarget(preresolved: ReturnType<typeof makeFindPreresolvedTree>, ref = '@e2') {
  return { ref, node: preresolved.node, nodes: preresolved.nodes };
}

async function runFindInternalClick(
  sessionStore: SessionStore,
  sessionName: string,
  internal: Record<string, unknown>,
) {
  return await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['@e2'],
      flags: { noRecord: true },
      internal,
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });
}

function readPressPoint(): string[] | undefined {
  const call = mockDispatch.mock.calls.find((entry) => entry[1] === 'press');
  return call?.[2] as string[] | undefined;
}

test('#1654: a mutating find click acts on the node find resolved, not a re-resolved @ref', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'find-preresolved-click';
  sessionStore.set(sessionName, makeStaleRefSession(sessionName));
  mockDispatch.mockResolvedValue({});
  const preresolved = makeFindPreresolvedTree();

  const response = await runFindInternalClick(sessionStore, sessionName, {
    findResolvedTarget: findResolvedTarget(preresolved),
  });

  expect(response?.ok).toBe(true);
  // find's node — (300,500,20,20) → (310, 510). A second resolution would read
  // @e2 out of the SESSION frame tree instead and tap (60, 40).
  expect(readPressPoint()).toEqual(['310', '510']);
});

test('#1654 control: without the resolved-target payload the same click still resolves @ref from the session tree', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'find-preresolved-control';
  sessionStore.set(sessionName, makeStaleRefSession(sessionName));
  mockDispatch.mockResolvedValue({});

  const response = await runFindInternalClick(sessionStore, sessionName, {});

  // The ordinary ref path is untouched: @e1 is "Continue" at (10,20,100,40).
  expect(response?.ok).toBe(true);
  expect(readPressPoint()).toEqual(['60', '40']);
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
  mockDispatch.mockResolvedValue({});
  const preresolved = makeFindPreresolvedTree();

  const withoutPreresolution = await runFindInternalClick(sessionStore, sessionName, {});
  expect(withoutPreresolution?.ok).toBe(false);

  const response = await runFindInternalClick(sessionStore, sessionName, {
    findResolvedTarget: findResolvedTarget(preresolved),
  });

  expect(response?.ok).toBe(true);
  expect(readPressPoint()).toEqual(['310', '510']);
});

test('#1654: the shared guards still run on the pre-resolved node', async () => {
  // The pre-resolution replaces the lookup, not the guarantees: an occluded
  // node is still refused, at the same ADR 0011 `runtime-ref` occlusion cell.
  const sessionStore = makeSessionStore();
  const sessionName = 'find-preresolved-occluded';
  sessionStore.set(sessionName, makeStaleRefSession(sessionName));
  mockDispatch.mockResolvedValue({});
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
  expect(readPressPoint()).toBeUndefined();
});

test('#1654: the resolved-target payload fails closed when its ref provenance disagrees', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'find-preresolved-mismatched-ref';
  sessionStore.set(sessionName, makeStaleRefSession(sessionName));
  mockDispatch.mockResolvedValue({});
  const preresolved = makeFindPreresolvedTree();

  const response = await runFindInternalClick(sessionStore, sessionName, {
    findResolvedTarget: findResolvedTarget(preresolved, '@e9'),
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toContain('provenance does not match');
  }
  expect(readPressPoint()).toBeUndefined();
});
