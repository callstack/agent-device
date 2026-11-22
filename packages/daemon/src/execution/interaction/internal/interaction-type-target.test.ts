import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import {
  installInteractorSnapshotResolution,
  mockInteractorSnapshot,
} from '../../../__tests__/support/interactor-resolution-fixture.ts';
import { touchCreateCommandSurface } from '../../../__tests__/support/touch-command-surface-fake.ts';
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

test('base text vocabulary types whole with no focus tap', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'type-lookalikes';
  sessionStore.publish(sessionName, makeSession(sessionName));

  for (const positionals of [
    ['@elena', 'hi'],
    ['100', '200'],
    ['1', '2', '3'],
    ['selected', 'items', 'here'],
    ['visible', 'soon'],
    ['text="Sign in"', 'hello'],
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

test.for([
  { name: 'numeric text', slug: 'numeric', text: ['1', '2', '3'], joined: '1 2 3' },
  {
    name: 'selector-key text',
    slug: 'selector-key',
    text: ['text="Sign in"'],
    joined: 'text="Sign in"',
  },
] as const)(
  'a recorded targeted type with $name records one joined positional that replays without a second tap',
  async ({ slug, text, joined }) => {
    // The record run focuses @e1, then appends. The type step carries the text as ONE positional
    // so a replay cannot re-split it into a target (#4870 review).
    const recordName = `type-record-${slug}`;
    const recordStore = publishTextboxSession(recordName);
    const record = await runType(recordName, recordStore, ['@e1', ...text]);
    expect(record?.ok).toBe(true);
    const actions = recordStore.get(recordName)?.actions ?? [];
    expect(actions.map((action) => action.command)).toEqual(['press', 'type']);
    expect(actions[1]?.positionals).toEqual([joined]);

    // The replay runs the recorded steps in a fresh session: the press taps once, and the type
    // appends the whole text with no tap of its own — never a second tap at (1, 2).
    const replayName = `${recordName}-replay`;
    const replayStore = publishTextboxSession(replayName);
    mockTapPoint.mockClear();
    mockTypeText.mockClear();
    for (const action of actions) {
      const response = await runType(
        replayName,
        replayStore,
        action.positionals ?? [],
        action.command,
      );
      expect(response?.ok, action.command).toBe(true);
    }
    expect(mockTapPoint).toHaveBeenCalledOnce();
    expect(mockTypeText).toHaveBeenCalledOnce();
    expect(mockTypeText.mock.calls[0]?.[0]).toMatchObject({ text: joined });
  },
);

test('a targetless type records its original positionals', async () => {
  // `type " " @e2` types a literal two-space `@e2`. The record must keep the two positionals:
  // folding them into one `["  @e2"]` trims into a ref that replay refuses (#4870).
  const recordName = 'type-record-targetless';
  const recordStore = publishTextboxSession(recordName);
  const record = await runType(recordName, recordStore, [' ', '@e2']);
  expect(record?.ok).toBe(true);
  const actions = recordStore.get(recordName)?.actions ?? [];
  expect(actions.map((action) => action.command)).toEqual(['type']);
  expect(actions[0]?.positionals).toEqual([' ', '@e2']);
});

test('a recorded targetless type replays the whole text with no focus tap and no INVALID_ARGS', async () => {
  // The prove-the-fix round trip: record `type " " @e2`, then replay the recorded step in a fresh
  // session. The mistargeted-ref replay check reads only the first positional, so the leading
  // blank passes, the joined text reaches the device whole, and a targetless type taps nothing.
  const recordName = 'type-record-targetless-replay';
  const recordStore = publishTextboxSession(recordName);
  const record = await runType(recordName, recordStore, [' ', '@e2']);
  expect(record?.ok).toBe(true);
  const actions = recordStore.get(recordName)?.actions ?? [];

  const replayName = `${recordName}-replay`;
  const replayStore = publishTextboxSession(replayName);
  mockTapPoint.mockClear();
  mockTypeText.mockClear();
  for (const action of actions) {
    const response = await runType(
      replayName,
      replayStore,
      action.positionals ?? [],
      action.command,
    );
    expect(response?.ok, action.command).toBe(true);
  }
  expect(mockTapPoint).not.toHaveBeenCalled();
  expect(mockTypeText).toHaveBeenCalledOnce();
  expect(mockTypeText.mock.calls[0]?.[0]).toMatchObject({ text: '  @e2' });
});

test('a targeted type whose text reads as a ref records folded and replays refused', async () => {
  // Characterization of a known boundary (#4870 open question): folding keeps ordinary text from
  // re-splitting on replay, but a payload that itself reads as a minted ref lands as a bare
  // structural token, and replay decodes it as a target with no text to append.
  const recordName = 'type-record-ref-shaped-text';
  const recordStore = publishTextboxSession(recordName);
  const record = await runType(recordName, recordStore, ['@e1', '@e2']);
  expect(record?.ok).toBe(true);
  const actions = recordStore.get(recordName)?.actions ?? [];
  expect(actions.map((action) => action.command)).toEqual(['press', 'type']);
  expect(actions[1]?.positionals).toEqual(['@e2']);

  const replayName = `${recordName}-replay`;
  const replayStore = publishTextboxSession(replayName);
  mockTapPoint.mockClear();
  mockTypeText.mockClear();
  expect((await runType(replayName, replayStore, ['@e1'], 'press'))?.ok).toBe(true);
  expect(await runType(replayName, replayStore, ['@e2'])).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS', message: 'type @e2 requires text to append' },
  });
  // The refusal happens before dispatch: only the press tap reached the device.
  expect(mockTapPoint).toHaveBeenCalledOnce();
  expect(mockTypeText).not.toHaveBeenCalled();
});

async function runType(
  sessionName: string,
  sessionStore: ReturnType<typeof makeSessionStore>,
  positionals: string[],
  command = 'type',
) {
  return await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command,
      positionals,
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
}
