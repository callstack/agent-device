import { test, expect, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeIosSession } from '../../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import {
  installInteractorSnapshotResolution,
  mockInteractorSnapshot,
} from '../../../__tests__/support/interactor-resolution-fixture.ts';
import { touchCreateCommandSurface } from '../../../__tests__/support/touch-command-surface-fake.ts';
import { runFindInternalClick } from '../../../__tests__/support/touch-interaction-runner.ts';
import {
  getRuntimeBindings,
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../__tests__/interaction-get-runtime-fixture.ts';
import {
  contextFromFlags,
  findResolvedTarget,
  makeFindPreresolvedTree,
  makeSession,
  makeStaleRefSession,
  readPressPoint,
} from './__tests__/interaction-touch-fixtures.ts';
import { handleInteractionCommands } from '../index.ts';

// How an admitted press/click reaches the device: the button projection onto the bound tap, a
// mutating find's pre-resolved node (#1654) handed to the command surface, and the capture a read
// takes after a press.

beforeEach(() => {
  resetGetRuntimeFixture();
  installInteractorSnapshotResolution();
  mockInteractorSnapshot.mockReset();
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
  sessionStore.publish(sessionName, session);

  mockTapPoint.mockResolvedValue({ button: 'secondary' });

  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
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
  sessionStore.publish(sessionName, makeStaleRefSession(sessionName));
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
  sessionStore.publish(sessionName, makeStaleRefSession(sessionName));

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
  sessionStore.publish(sessionName, session);
  const preresolved = makeFindPreresolvedTree();

  const withoutPreresolution = await runFindInternalClick(sessionStore, sessionName, {});
  expect(withoutPreresolution?.ok).toBe(false);

  const response = await runFindInternalClick(sessionStore, sessionName, {
    findResolvedTarget: findResolvedTarget(preresolved),
  });

  expect(response?.ok).toBe(true);
  expect(readPressPoint(mockTapPoint)).toEqual(['310', '510']);
});

test('a read right after a press captures the post-tap screen instead of reusing the pre-tap tree', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'read-after-press';
  sessionStore.publish(
    sessionName,
    makeIosSession(sessionName, { appBundleId: 'com.example.app' }),
  );
  const screen = (step: string) => ({
    backend: 'xctest' as const,
    producer: 'apple-runner' as const,
    nodes: [
      { index: 0, depth: 0, type: 'Application', rect: { x: 0, y: 0, width: 393, height: 852 } },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'Button',
        label: 'Next',
        rect: { x: 24, y: 120, width: 120, height: 44 },
        enabled: true,
        hittable: true,
      },
      {
        index: 2,
        depth: 1,
        parentIndex: 0,
        type: 'StaticText',
        label: step,
        identifier: 'step',
        rect: { x: 24, y: 220, width: 320, height: 24 },
      },
    ],
  });
  mockInteractorSnapshot
    .mockResolvedValueOnce(screen('Step 1'))
    .mockResolvedValue(screen('Step 2'));
  const run = async (command: string, positionals: string[]) =>
    await handleInteractionCommands({
      createCommandSurface: touchCreateCommandSurface,
      req: { token: 't', session: sessionName, command, positionals, flags: {} },
      sessionName,
      sessionStore,
      contextFromFlags,
      ...getRuntimeBindings(),
    });

  expect(await run('is', ['visible', 'label=Next'])).toMatchObject({ ok: true });
  expect(await run('press', ['84', '142'])).toMatchObject({ ok: true });
  expect(mockInteractorSnapshot).toHaveBeenCalledTimes(1);

  const read = await run('get', ['text', 'id="step"']);

  expect(read).toMatchObject({ ok: true, data: { text: 'Step 2' } });
  expect(mockInteractorSnapshot).toHaveBeenCalledTimes(2);
});
