import { test, expect, vi, beforeEach } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { IOS_SIMULATOR } from '@agent-device/test-kit';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import {
  installInteractorSnapshotResolution,
  mockInteractorSnapshot,
} from '../../../__tests__/support/interactor-resolution-fixture.ts';
import {
  touchCreateCommandSurface,
  createTouchCommandSurface,
} from '../../../__tests__/support/touch-command-surface-fake.ts';
import {
  getRuntimeBindings,
  mockTapPoint,
  mockTypeText,
  resetGetRuntimeFixture,
} from '../../__tests__/interaction-get-runtime-fixture.ts';
import { contextFromFlags, makeSession } from './__tests__/interaction-touch-fixtures.ts';
import { handleInteractionCommands } from '../index.ts';
import { activateCompleteRefFrame } from '../../../core/ref-frame.ts';

// `type <target> <text>` composes two device effects in one command: the press admission stack
// focuses the target (resolution, AMBIGUOUS_MATCH, motion and keyboard guards), then the bound
// text-entry operation appends. A `type` without a target keeps the focused-input semantics.

const { mockCaptureSnapshotWithInteractor } = vi.hoisted(() => ({
  mockCaptureSnapshotWithInteractor: vi.fn(),
}));

vi.mock('../../../core/snapshot-interactor-capture.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../core/snapshot-interactor-capture.ts')>();
  return { ...actual, captureSnapshotWithInteractor: mockCaptureSnapshotWithInteractor };
});

beforeEach(() => {
  resetGetRuntimeFixture();
  installInteractorSnapshotResolution();
  mockInteractorSnapshot.mockReset();
  mockCaptureSnapshotWithInteractor.mockReset();
});

function publishTextboxSession(sessionName: string, label = 'Name') {
  const sessionStore = makeSessionStore();
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeTextField',
        label,
        rect: { x: 10, y: 20, width: 200, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  activateCompleteRefFrame(session);
  sessionStore.publish(sessionName, session);
  return sessionStore;
}

test('type @ref focuses the field with the press stack, then appends the text', async () => {
  const sessionStore = publishTextboxSession('type-ref-target');
  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: 'type-ref-target',
      command: 'type',
      positionals: ['@e1', 'hello'],
      flags: {},
    },
    sessionName: 'type-ref-target',
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data).toMatchObject({ ref: 'e1', targetKind: 'ref', text: 'hello' });
  }
  // The focus tap preceded the text entry, in that order.
  expect(mockTapPoint).toHaveBeenCalledOnce();
  expect(mockTypeText).toHaveBeenCalledOnce();
  expect(mockTypeText.mock.calls[0]?.[0]).toMatchObject({ text: 'hello' });
  // Two recorded steps, so a replay taps once and then types: the type step carries the
  // text-only positionals, never the target again.
  const actions = sessionStore.get('type-ref-target')?.actions ?? [];
  expect(actions.map((action) => action.command)).toEqual(['press', 'type']);
  expect(actions[1]?.positionals).toEqual(['hello']);
});

test('a type point target taps the coordinates and appends the text', async () => {
  const sessionStore = makeSessionStore();
  const session = makeSession('type-point-target');
  sessionStore.publish('type-point-target', session);

  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: 'type-point-target',
      command: 'type',
      positionals: ['100', '200', 'hello'],
      flags: {},
    },
    sessionName: 'type-point-target',
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockTapPoint).toHaveBeenCalledWith(expect.objectContaining({ point: { x: 100, y: 200 } }));
  expect(mockTypeText).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello' }));
});

test('a type selector refused as AMBIGUOUS_MATCH never reaches the text operation', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'type-ambiguous-selector';
  const session = makeSession(sessionName);
  session.device = IOS_SIMULATOR;
  sessionStore.publish(sessionName, session);

  // Two same-label buttons in distinct branches: the press resolution refuses to choose.
  mockCaptureSnapshotWithInteractor.mockResolvedValue({
    nodes: [
      { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
      {
        index: 1,
        parentIndex: 0,
        type: 'XCUIElementTypeButton',
        label: 'Deploy',
        rect: { x: 300, y: 300, width: 20, height: 20 },
        enabled: true,
        hittable: true,
      },
      {
        index: 2,
        parentIndex: 0,
        type: 'XCUIElementTypeButton',
        label: 'Deploy',
        rect: { x: 500, y: 500, width: 20, height: 20 },
        enabled: true,
        hittable: true,
      },
    ],
    backend: 'xctest',
    producer: 'apple-runner',
  });
  const ambiguous = () =>
    new AppError('AMBIGUOUS_MATCH', 'Selector matched 2 elements', {
      matches: 2,
      candidates: ['@e2 [button] "Deploy"', '@e3 [button] "Deploy"'],
    });
  const ambiguousSurface = createTouchCommandSurface({
    matchSelector: () => {
      throw ambiguous();
    },
  });

  const response = await handleInteractionCommands({
    createCommandSurface: ambiguousSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'type',
      positionals: ['label="Deploy"', 'hello'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('AMBIGUOUS_MATCH');
  }
  // The refusal is the focus tap's, so nothing was typed.
  expect(mockTapPoint).not.toHaveBeenCalled();
  expect(mockTypeText).not.toHaveBeenCalled();
});

test('type keeps lookalike ref words and numeric pairs as pure text with no focus tap', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'type-lookalikes';
  sessionStore.publish(sessionName, makeSession(sessionName));

  for (const positionals of [
    ['@elena', 'hi'],
    ['100', '200'],
  ] as const) {
    const response = await handleInteractionCommands({
      createCommandSurface: touchCreateCommandSurface,
      req: {
        token: 't',
        session: sessionName,
        command: 'type',
        positionals: [...positionals],
        flags: {},
      },
      sessionName,
      sessionStore,
      contextFromFlags,
      ...getRuntimeBindings(),
    });

    expect(response?.ok, positionals.join(' ')).toBe(true);
    expect(mockTapPoint, positionals.join(' ')).not.toHaveBeenCalled();
    expect(mockTypeText).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: positionals.join(' ') }),
    );
  }
});
