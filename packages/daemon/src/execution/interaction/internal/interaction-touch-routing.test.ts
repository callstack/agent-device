import { test, expect, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { WEB_DESKTOP_DEVICE } from '@agent-device/test-kit';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import {
  installInteractorSnapshotResolution,
  mockInteractorSnapshot,
} from '../../../__tests__/support/interactor-resolution-fixture.ts';
import { touchCreateCommandSurface } from '../../../__tests__/support/touch-command-surface-fake.ts';
import {
  getRuntimeBindings,
  mockHoverPoint,
  mockHoverRef,
  mockLongPressPoint,
  mockTapPoint,
  mockTypeText,
  resetGetRuntimeFixture,
  runtimeBindingSpies,
} from '../../__tests__/interaction-get-runtime-fixture.ts';
import {
  contextFromFlags,
  makeMacOsDesktopSession,
  makeMacOsMenubarSession,
  makeSession,
} from './__tests__/interaction-touch-fixtures.ts';
import { handleInteractionCommands } from '../index.ts';

// Router ownership: one representative per touch command proves
// handleInteractionCommands claims press/click/longpress/hover/fill.

beforeEach(() => {
  resetGetRuntimeFixture();
  installInteractorSnapshotResolution();
  mockInteractorSnapshot.mockReset();
});

test('press coordinates dispatches press and records as press', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const storedSession = makeSession(sessionName);
  sessionStore.publish(sessionName, storedSession);

  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
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
    ...getRuntimeBindings(),
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockTapPoint).toHaveBeenCalledOnce();
  expect(mockTapPoint.mock.calls[0]?.[0]).toMatchObject({
    point: { x: 100, y: 200 },
    options: { count: 3, intervalMs: 1, doubleTap: true },
  });

  const session = sessionStore.get(sessionName);
  expect(session).toBeTruthy();
  expect(session?.actions.length).toBe(1);
  expect(session?.actions[0]?.command).toBe('press');
  expect(session?.actions[0]?.positionals).toEqual(['100', '200']);
});

test.each([
  ['click', ['100', '200'], false],
  ['press', ['100', '200'], false],
  ['longpress', ['100', '200', '800'], false],
  ['hover', ['100', '200'], true],
  ['fill', ['100', '200', 'hello'], false],
] as const)('%s inspects once and binds once', async (command, positionals, web) => {
  const sessionStore = makeSessionStore();
  const sessionName = `single-bind-${command}`;
  const session = makeSession(sessionName);
  if (web) session.device = WEB_DESKTOP_DEVICE;
  sessionStore.publish(sessionName, session);

  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: { token: 't', session: sessionName, command, positionals: [...positionals], flags: {} },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(runtimeBindingSpies().inspectFacts).toHaveBeenCalledOnce();
  expect(runtimeBindingSpies().bindDevice).toHaveBeenCalledOnce();
});

test('click rejects macOS desktop surface interactions until helper routing exists', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-desktop-click';
  sessionStore.publish(sessionName, makeMacOsDesktopSession(sessionName));

  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
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
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/macOS desktop sessions/);
  }
});

test('fill rejects macOS menubar surface interactions until helper routing exists', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-menubar-fill';
  sessionStore.publish(sessionName, makeMacOsMenubarSession(sessionName));

  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
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
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/macOS menubar sessions/);
  }
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
  sessionStore.publish(sessionName, session);

  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
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
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.x).toBe(60);
    expect(response.data?.y).toBe(40);
    expect(response.data?.durationMs).toBe(800);
    expect(response.data?.message).toMatch(/Long pressed @e1/);
  }
  expect(mockLongPressPoint).toHaveBeenCalledWith(
    expect.objectContaining({ point: { x: 60, y: 40 }, durationMs: 800 }),
  );
  expect(sessionStore.get(sessionName)?.actions[0]?.command).toBe('longpress');
});

// #1783: hover is the pointer-only member of the targeted-touch family. It rides
// the same admission path as press/longpress, and only web admits it. On web
// the session's ref frame is minted WITHOUT rects (snapshot -i does not fetch
// boxes), so `hover @ref` cannot resolve to coordinates: like `click @ref` it
// must take the provider-native route (`hoverRef`, ADR 0011 native-ref path).
// This test therefore stores a rect-less web frame and a scoped provider — the
// production shape — and asserts no coordinate dispatch happens.
test('hover @ref on web dispatches through the provider hoverRef route, not coordinates', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'hover-ref';
  const session = makeSession(sessionName);
  session.device = WEB_DESKTOP_DEVICE;
  session.snapshot = {
    nodes: attachRefs([{ index: 0, role: 'link', label: 'Second message', enabled: true }]),
    createdAt: Date.now(),
    backend: 'web',
  };
  sessionStore.publish(sessionName, session);
  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'hover',
      positionals: ['@e1'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response).toMatchObject({
    ok: true,
    data: { ref: 'e1', gesture: 'hover', message: expect.stringMatching(/Hovered @e1/) },
  });
  expect(mockHoverRef).toHaveBeenCalledWith(expect.objectContaining({ ref: '@e1' }));
  expect(mockHoverPoint).not.toHaveBeenCalled();
  const hoverAction = sessionStore.get(sessionName)?.actions[0];
  expect(hoverAction?.command).toBe('hover');
  expect(hoverAction?.result).toMatchObject({ ref: 'e1', gesture: 'hover' });
  expect(hoverAction?.result).not.toHaveProperty('x');
  expect(hoverAction?.result).not.toHaveProperty('y');

  const typeResponse = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'type',
      positionals: [' ok'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(typeResponse?.ok).toBe(true);
  expect(mockTypeText).toHaveBeenCalledOnce();
  expect(sessionStore.get(sessionName)?.actions.at(-1)).toMatchObject({
    command: 'type',
    positionals: [' ok'],
  });
});

test('click @ref on web records the ref result without fabricated coordinates', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'click-ref';
  const session = makeSession(sessionName);
  session.device = WEB_DESKTOP_DEVICE;
  session.snapshot = {
    nodes: attachRefs([{ index: 0, role: 'link', label: 'Second message', enabled: true }]),
    createdAt: Date.now(),
    backend: 'web',
  };
  sessionStore.publish(sessionName, session);

  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['@e1'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response).toMatchObject({ ok: true, data: { ref: 'e1' } });
  const action = sessionStore.get(sessionName)?.actions[0];
  expect(action?.command).toBe('click');
  expect(action?.positionals).toEqual(['@e1']);
  expect(action?.result).toMatchObject({ ref: 'e1' });
  expect(action?.result).not.toHaveProperty('x');
  expect(action?.result).not.toHaveProperty('y');
});

test('hover selector on web resolves the target and dispatches coordinate hover', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'hover-selector';
  const session = makeSession(sessionName);
  session.device = WEB_DESKTOP_DEVICE;
  sessionStore.publish(sessionName, session);
  mockInteractorSnapshot.mockResolvedValue({
    nodes: attachRefs([
      {
        index: 0,
        role: 'link',
        label: 'Second message',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    backend: 'web',
    producer: 'agent-browser',
  });

  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'hover',
      positionals: ['label="Second message"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response).toMatchObject({
    ok: true,
    data: { x: 60, y: 40, gesture: 'hover', message: expect.stringMatching(/Hovered label/) },
  });
  expect(mockHoverPoint).toHaveBeenCalledWith(expect.objectContaining({ point: { x: 60, y: 40 } }));
});

test('hover is refused by capability on touch platforms before any dispatch', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'hover-ios';
  sessionStore.publish(sessionName, makeSession(sessionName));

  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'hover',
      positionals: ['100', '200'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: 'hover is not supported on this device',
      hint: 'hover raises pointer hover state and is available on web targets only. On touch platforms use longpress for hold gestures.',
    },
  });
});
