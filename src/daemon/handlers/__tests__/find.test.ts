import { test, expect, vi, beforeEach } from 'vitest';
import { handleFindCommands } from '../find.ts';
import { handleInteractionCommands } from '../interaction.ts';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../types.ts';
import { buildSnapshotSignatures } from '../../android-snapshot-freshness.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import {
  makeIosSession as makeSession,
  makeAuthoringSession,
} from '../../../__tests__/test-utils/session-factories.ts';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async (_device: unknown, command: string) => {
      return command === 'snapshot' ? { nodes: [] } : {};
    }),
    resolveTargetDevice: actual.resolveTargetDevice,
  };
});

vi.mock('../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../__tests__/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});

import { dispatchCommand } from '../../../core/dispatch.ts';

const mockDispatch = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockImplementation(async (_device: unknown, command: string) => {
    return command === 'snapshot' ? { nodes: [] } : {};
  });
});

async function runFindClickScenario(options: {
  positionals: string[];
  nodes?: Array<Record<string, unknown>>;
  flags?: DaemonRequest['flags'];
  session?: SessionState;
  invoke?: (req: DaemonRequest) => Promise<Record<string, unknown>>;
}): Promise<{
  response: NonNullable<Awaited<ReturnType<typeof handleFindCommands>>>;
  invokeCalls: DaemonRequest[];
  session: SessionState;
}> {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = options.session ?? makeSession(sessionName);
  sessionStore.set(sessionName, session);

  if (options.nodes !== undefined) {
    mockDispatch.mockImplementation(async (_device, command) => {
      if (command === 'snapshot') {
        return { nodes: options.nodes };
      }
      return {};
    });
  }

  const invokeCalls: DaemonRequest[] = [];
  const response = await handleFindCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'find',
      positionals: options.positionals,
      flags: options.flags ?? {},
    },
    sessionName,
    logPath: '/tmp/test.log',
    sessionStore,
    invoke: async (req) => {
      invokeCalls.push(req);
      const data = options.invoke ? await options.invoke(req) : {};
      return { ok: true, data } as DaemonResponse;
    },
  });

  expect(response).toBeTruthy();
  return { response: response!, invokeCalls, session };
}

test('mutating find focus crosses the ADR 0014 side-effect seam and expires the ref frame', async () => {
  // find focus/type dispatch the device command directly (they do NOT re-enter
  // the interaction leaf like find click/fill), so the seam must live in find.
  const node = {
    index: 0,
    type: 'Button',
    label: 'Save',
    hittable: true,
    rect: { x: 10, y: 20, width: 100, height: 40 },
  };
  const { response, session } = await runFindClickScenario({
    positionals: ['Save', 'focus'],
    nodes: [node],
  });
  expect(response.ok).toBe(true);
  expect(session.refFrameState).toBe('expired');
});

test('handleFindCommands click returns deterministic metadata across locator variants', async () => {
  const hittableParentNoRect = { index: 0, type: 'View', hittable: true, depth: 0 };
  const nonHittableChildWithRect = {
    index: 1,
    type: 'StaticText',
    label: 'Increment',
    hittable: false,
    rect: { x: 50, y: 0, width: 100, height: 100 },
    depth: 1,
    parentIndex: 0,
  };

  const scenarios = [
    {
      label: 'falls back to deterministic key set when resolved node has no rect',
      positionals: ['Increment', 'click'],
      nodes: [hittableParentNoRect, nonHittableChildWithRect],
      invoke: async () => ({ platformSpecificRef: 'XCUIElementTypeView' }),
      // ADR 0014: a mutating find (click) omits refsGeneration — its ref is
      // diagnostic pre-action identity, never a pinnable issued ref.
      expectedKeys: ['locator', 'message', 'query', 'ref', 'x', 'y'],
      expectedLocator: 'any',
      expectedQuery: 'Increment',
      expectedCoordinates: { x: 100, y: 50 },
      expectedRef: '@e2',
    },
  ];

  for (const scenario of scenarios) {
    const { response, invokeCalls } = await runFindClickScenario(scenario);
    expect(response.ok, scenario.label).toBe(true);
    if (!response.ok) return;
    const data = response.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(scenario.expectedKeys);
    expect(data.ref).toBe(scenario.expectedRef);
    expect(data.locator).toBe(scenario.expectedLocator);
    expect(data.query).toBe(scenario.expectedQuery);

    if (scenario.expectedCoordinates) {
      expect(data.x).toBe(scenario.expectedCoordinates.x);
      expect(data.y).toBe(scenario.expectedCoordinates.y);
    } else {
      expect(Object.hasOwn(data, 'x')).toBe(false);
      expect(Object.hasOwn(data, 'y')).toBe(false);
    }

    expect(invokeCalls.length).toBe(1);
    expect(invokeCalls[0]!.positionals?.[0]).toBe(scenario.expectedRef);
  }
});

test('handleFindCommands click reports the same success message as a direct press', async () => {
  const nodes = [
    { index: 0, type: 'View', hittable: true, depth: 0 },
    {
      index: 1,
      type: 'Button',
      label: 'Catalog',
      hittable: true,
      rect: { x: 50, y: 0, width: 100, height: 100 },
      depth: 1,
      parentIndex: 0,
    },
  ];

  // Default action (no explicit `click` token) must also confirm the tap.
  const synthesized = await runFindClickScenario({ positionals: ['Catalog'], nodes });
  expect(synthesized.response.ok).toBe(true);
  const synthesizedData = (synthesized.response as { data: Record<string, unknown> }).data;
  expect(synthesizedData.message).toBe('Tapped @e2 (100, 50)');

  // When the delegated click supplies its own success message, it is passed through.
  const delegated = await runFindClickScenario({
    positionals: ['Catalog', 'click'],
    nodes,
    invoke: async () => ({ message: 'Tapped @e2 (100, 50)', x: 100, y: 50 }),
  });
  expect(delegated.response.ok).toBe(true);
  const delegatedData = (delegated.response as { data: Record<string, unknown> }).data;
  expect(delegatedData.message).toBe('Tapped @e2 (100, 50)');
});

test('handleFindCommands click prefers on-screen duplicate text matches', async () => {
  const { response, invokeCalls } = await runFindClickScenario({
    positionals: ['Sign in', 'click'],
    nodes: [
      {
        index: 0,
        ref: 'e1',
        type: 'Application',
        hittable: true,
        rect: { x: 0, y: 0, width: 440, height: 956 },
      },
      {
        index: 1,
        ref: 'e2',
        type: 'Button',
        label: 'Sign in',
        hittable: false,
        rect: { x: -199, y: 186, width: 70, height: 33 },
        parentIndex: 0,
      },
      {
        index: 2,
        ref: 'e3',
        type: 'Button',
        label: 'Sign in',
        hittable: false,
        rect: { x: 40, y: 870, width: 360, height: 44 },
        parentIndex: 0,
      },
    ],
  });

  expect(response.ok).toBe(true);
  expect(invokeCalls[0]!.positionals?.[0]).toBe('@e3');
});

test('handleFindCommands click tries query-scoped full retry before failing sparse verdict', async () => {
  const session = makeSession('default');
  session.snapshot = {
    nodes: [
      {
        index: 0,
        ref: 'e1',
        type: 'Application',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      },
      {
        index: 1,
        ref: 'e2',
        type: 'Button',
        label: 'Previous Search',
        rect: { x: 80, y: 792, width: 78, height: 48 },
      },
    ],
    createdAt: Date.now(),
    backend: 'xctest',
  };
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command !== 'snapshot') return {};
    return {
      backend: 'xctest',
      quality: {
        state: 'sparse',
        backend: 'private-ax',
        reason: 'sparse tree',
        reasonCode: 'sparse-tree',
      },
      nodes: [
        {
          index: 0,
          type: 'Application',
          rect: { x: 0, y: 0, width: 0, height: 0 },
        },
      ],
    };
  });

  const previousSnapshot = session.snapshot;
  const { response, invokeCalls } = await runFindClickScenario({
    positionals: ['Search', 'click'],
    session,
  });

  expect(response.ok).toBe(false);
  expect(session.snapshot).toBe(previousSnapshot);
  expect(invokeCalls).toHaveLength(0);
  expect(!response.ok && response.error).toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'find could not read the current accessibility tree',
    details: {
      reason: 'sparse tree',
      hint: expect.stringContaining('snapshot quality verdict is sparse'),
    },
  });
  const snapshotCalls = mockDispatch.mock.calls.filter((call) => call[1] === 'snapshot');
  expect(snapshotCalls).toHaveLength(2);
  expect(snapshotCalls[0]![4]).toMatchObject({
    snapshotInteractiveOnly: true,
  });
  expect(snapshotCalls[1]![4]).toMatchObject({
    snapshotInteractiveOnly: false,
    snapshotScope: 'Search',
  });
});

test('handleFindCommands click uses query-scoped full retry when sparse verdict recovers', async () => {
  const snapshotResponses = [
    {
      backend: 'xctest',
      quality: {
        state: 'sparse',
        backend: 'private-ax',
        reason: 'sparse tree',
        reasonCode: 'sparse-tree',
      },
      nodes: [
        {
          index: 0,
          type: 'Application',
          rect: { x: 0, y: 0, width: 0, height: 0 },
        },
      ],
    },
    {
      backend: 'xctest',
      quality: {
        state: 'healthy',
        backend: 'tree',
      },
      nodes: [
        {
          index: 0,
          type: 'Application',
          hittable: false,
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          index: 1,
          type: 'Button',
          label: 'Search',
          hittable: true,
          rect: { x: 80, y: 792, width: 78, height: 48 },
          parentIndex: 0,
        },
      ],
    },
  ];
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command !== 'snapshot') return {};
    return snapshotResponses.shift() ?? { nodes: [] };
  });

  const { response, invokeCalls } = await runFindClickScenario({
    positionals: ['Search', 'click'],
  });

  expect(response.ok).toBe(true);
  expect(invokeCalls[0]!.positionals?.[0]).toBe('@e1');
  expect(response.ok ? response.data : undefined).toMatchObject({ x: 119, y: 816 });
  const snapshotCalls = mockDispatch.mock.calls.filter((call) => call[1] === 'snapshot');
  expect(snapshotCalls).toHaveLength(2);
  expect(snapshotCalls[1]![4]).toMatchObject({
    snapshotInteractiveOnly: false,
    snapshotScope: 'Search',
  });
});

test('handleFindCommands click retries full snapshot for legacy iOS sparse shape without verdict', async () => {
  const snapshotResponses = [
    {
      backend: 'xctest',
      nodes: [
        {
          index: 0,
          type: 'Application',
          rect: { x: 0, y: 0, width: 0, height: 0 },
        },
      ],
    },
    {
      backend: 'xctest',
      nodes: [
        {
          index: 0,
          type: 'Application',
          hittable: false,
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          index: 1,
          type: 'Button',
          label: 'Search',
          hittable: true,
          rect: { x: 80, y: 792, width: 78, height: 48 },
          parentIndex: 0,
        },
      ],
    },
  ];
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') return snapshotResponses.shift() ?? { nodes: [] };
    return {};
  });

  const { response, invokeCalls } = await runFindClickScenario({
    positionals: ['Search', 'click'],
  });

  expect(response.ok).toBe(true);
  expect(invokeCalls[0]!.positionals?.[0]).toBe('@e2');
  const snapshotCalls = mockDispatch.mock.calls.filter((call) => call[1] === 'snapshot');
  expect(snapshotCalls).toHaveLength(2);
  expect(snapshotCalls[0]![4]).toMatchObject({
    snapshotInteractiveOnly: true,
  });
  expect(snapshotCalls[1]![4]).toMatchObject({
    snapshotInteractiveOnly: false,
  });
});

test('handleFindCommands click scopes full retry for legacy sparse shape when unscoped fallback fails', async () => {
  const snapshotResponses = [
    {
      backend: 'xctest',
      nodes: [
        {
          index: 0,
          type: 'Application',
          rect: { x: 0, y: 0, width: 0, height: 0 },
        },
      ],
    },
    new Error('unscoped snapshot failed'),
    {
      backend: 'xctest',
      nodes: [
        {
          index: 0,
          type: 'Application',
          hittable: false,
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          index: 1,
          type: 'Button',
          label: 'Search',
          hittable: true,
          rect: { x: 80, y: 792, width: 78, height: 48 },
          parentIndex: 0,
        },
      ],
    },
  ];
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command !== 'snapshot') return {};
    const response = snapshotResponses.shift();
    if (response instanceof Error) throw response;
    return response ?? { nodes: [] };
  });

  const { response, invokeCalls } = await runFindClickScenario({
    positionals: ['Search', 'click'],
  });

  expect(response.ok).toBe(true);
  expect(invokeCalls[0]!.positionals?.[0]).toBe('@e1');
  expect(response.ok ? response.data : undefined).toMatchObject({ x: 119, y: 816 });
  const snapshotCalls = mockDispatch.mock.calls.filter((call) => call[1] === 'snapshot');
  expect(snapshotCalls).toHaveLength(3);
  expect(snapshotCalls[2]![4]).toMatchObject({
    snapshotInteractiveOnly: false,
    snapshotScope: 'Search',
  });
});

test('handleFindCommands click prefers semantic controls over matching containers', async () => {
  const { response, invokeCalls } = await runFindClickScenario({
    positionals: ['Later', 'click'],
    flags: { findFirst: true },
    nodes: [
      {
        index: 0,
        ref: 'e1',
        type: 'Application',
        hittable: true,
        rect: { x: 0, y: 0, width: 440, height: 956 },
      },
      {
        index: 1,
        ref: 'e2',
        type: 'Element(5)',
        label: 'Dialog',
        hittable: true,
        rect: { x: 60, y: 356, width: 320, height: 272 },
        parentIndex: 0,
      },
      {
        index: 2,
        ref: 'e3',
        type: 'ScrollView',
        label: 'Later',
        hittable: false,
        rect: { x: 60, y: 548, width: 320, height: 80 },
        parentIndex: 1,
      },
      {
        index: 3,
        ref: 'e4',
        type: 'Other',
        label: 'Later',
        hittable: false,
        rect: { x: 76, y: 564, width: 288, height: 48 },
        parentIndex: 2,
      },
      {
        index: 4,
        ref: 'e5',
        type: 'Button',
        label: 'Later',
        hittable: false,
        rect: { x: 76, y: 564, width: 140, height: 48 },
        parentIndex: 3,
      },
    ],
  });

  expect(response.ok).toBe(true);
  expect(invokeCalls[0]!.positionals?.[0]).toBe('@e5');
});

// #1597: an ambiguous find must let the agent act on the right @ref straight
// from the error, so the response carries snapshot-line-rendered candidates
// (ref, role, label) instead of a bare "matched N elements" message. Capped
// at AMBIGUOUS_MATCH_CANDIDATE_LIMIT (5); the true total keeps riding
// `matches` so a "+N more" marker can be computed at render time.
test('handleFindCommands ambiguous match lists snapshot-line candidates capped at 5', async () => {
  const followButton = (ref: string, index: number, x: number) => ({
    index,
    ref,
    type: 'Button',
    label: 'Follow',
    hittable: true,
    rect: { x, y: 100, width: 80, height: 40 },
    parentIndex: 0,
  });

  const { response } = await runFindClickScenario({
    positionals: ['Follow', 'click'],
    nodes: [
      { index: 0, ref: 'e1', type: 'Application', rect: { x: 0, y: 0, width: 800, height: 1200 } },
      followButton('e2', 1, 0),
      followButton('e3', 2, 90),
      followButton('e4', 3, 180),
      followButton('e5', 4, 270),
      followButton('e6', 5, 360),
      followButton('e7', 6, 450),
    ],
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('AMBIGUOUS_MATCH');
  // The old bare message ("find matched 6 elements ... Use a more specific
  // locator or selector.") gave the agent nothing to act on directly — this
  // proves the fix red against that shape: `candidates` must exist, be
  // snapshot-line rendered, and be capped below the true match count.
  expect(response.error.details?.matches).toBe(6);
  const candidates = response.error.details?.candidates;
  expect(Array.isArray(candidates)).toBe(true);
  expect(candidates).toHaveLength(5);
  expect(candidates).toEqual([
    '@e2 [button] "Follow"',
    '@e3 [button] "Follow"',
    '@e4 [button] "Follow"',
    '@e5 [button] "Follow"',
    '@e6 [button] "Follow"',
  ]);
});

test('handleFindCommands ambiguous match with few candidates lists them all uncapped', async () => {
  const { response } = await runFindClickScenario({
    positionals: ['Follow', 'click'],
    nodes: [
      { index: 0, ref: 'e1', type: 'Application', rect: { x: 0, y: 0, width: 800, height: 1200 } },
      {
        index: 1,
        ref: 'e2',
        type: 'Button',
        label: 'Follow',
        hittable: true,
        rect: { x: 0, y: 100, width: 80, height: 40 },
        parentIndex: 0,
      },
      {
        index: 2,
        ref: 'e3',
        type: 'Button',
        // No label — exact-matches "Follow" via its identifier instead, so
        // this candidate exercises the label/identifier fallback.
        identifier: 'FOLLOW',
        hittable: true,
        rect: { x: 90, y: 100, width: 80, height: 40 },
        parentIndex: 0,
      },
    ],
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('AMBIGUOUS_MATCH');
  expect(response.error.details?.matches).toBe(2);
  // No label on e3, so the candidate line falls back to its identifier —
  // "label/identifier" per #1597, same as any other snapshot line.
  expect(response.error.details?.candidates).toEqual([
    '@e2 [button] "Follow"',
    '@e3 [button] "FOLLOW"',
  ]);
});

// #1625 decision 1: `find <q> list` is the read-only inspection surface the
// recovery hint points at — every match with its ref, unique match included,
// and never a tap (the old hint's "run bare find to list" clicked a unique
// match and navigated).
test('handleFindCommands list returns every match without acting', async () => {
  const follow = (ref: string, index: number, x: number) => ({
    index,
    ref,
    type: 'Button',
    label: 'Follow',
    hittable: true,
    rect: { x, y: 100, width: 80, height: 40 },
    parentIndex: 0,
  });

  const { response, invokeCalls, session } = await runFindClickScenario({
    positionals: ['text', 'Follow', 'list'],
    nodes: [
      { index: 0, ref: 'e1', type: 'Application', rect: { x: 0, y: 0, width: 800, height: 1200 } },
      follow('e2', 1, 0),
      follow('e3', 2, 90),
      follow('e4', 3, 180),
    ],
  });

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  const matches = response.data?.matches as Array<{ ref: string }>;
  expect(matches.map((match) => match.ref)).toEqual(['@e2', '@e3', '@e4']);
  // Inspection only: nothing was clicked, focused, or filled.
  expect(invokeCalls).toHaveLength(0);
  // Ref-issuing: the response carries the generation and the partial frame
  // authorizes EVERY listed body, so any `@eN~sG` from the list can drive the
  // next command (a plain `@eN` still requires a complete frame by design —
  // the MCP/CLI layers pin from `matches` + `refsGeneration`).
  expect(typeof response.data?.refsGeneration).toBe('number');
  expect(session.refFrameState).toBe('active');
  expect([...(session.refFrameScope ?? [])].sort()).toEqual(['e2', 'e3', 'e4']);
});

test('handleFindCommands list on a unique match still lists instead of tapping', async () => {
  const { response, invokeCalls } = await runFindClickScenario({
    positionals: ['Dictionary', 'list'],
    nodes: [
      { index: 0, ref: 'e1', type: 'Application', rect: { x: 0, y: 0, width: 800, height: 1200 } },
      {
        index: 1,
        ref: 'e2',
        type: 'Cell',
        label: 'Dictionary',
        hittable: true,
        rect: { x: 0, y: 100, width: 800, height: 44 },
        parentIndex: 0,
      },
    ],
  });

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  const matches = response.data?.matches as Array<{ ref: string }>;
  expect(matches).toHaveLength(1);
  expect(matches[0]?.ref).toBe('@e2');
  expect(invokeCalls).toHaveLength(0);
});

// #1625 decision 2: selector-shaped and text-shaped queries share one
// ambiguity contract. Selectors used to take the first match silently — the
// exact mis-binding path the AMBIGUOUS_MATCH recovery advice pointed at.
test('handleFindCommands selector-shaped find rejects multiple matches with candidates', async () => {
  const button = (ref: string, index: number, label: string, x: number) => ({
    index,
    ref,
    type: 'Button',
    label,
    hittable: true,
    rect: { x, y: 100, width: 80, height: 40 },
    parentIndex: 0,
  });

  const { response, invokeCalls } = await runFindClickScenario({
    positionals: ['role=button', 'click'],
    nodes: [
      { index: 0, ref: 'e1', type: 'Application', rect: { x: 0, y: 0, width: 800, height: 1200 } },
      button('e2', 1, 'Follow', 0),
      button('e3', 2, 'Share', 90),
      button('e4', 3, 'Reply', 180),
    ],
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('AMBIGUOUS_MATCH');
  expect(response.error.details?.matches).toBe(3);
  expect(Array.isArray(response.error.details?.candidates)).toBe(true);
  expect(invokeCalls).toHaveLength(0);
});

test('handleFindCommands selector-shaped find honors the explicit --first opt-out', async () => {
  const button = (ref: string, index: number, label: string, x: number) => ({
    index,
    ref,
    type: 'Button',
    label,
    hittable: true,
    rect: { x, y: 100, width: 80, height: 40 },
    parentIndex: 0,
  });

  const { response, invokeCalls } = await runFindClickScenario({
    positionals: ['role=button', 'click'],
    flags: { findFirst: true },
    nodes: [
      { index: 0, ref: 'e1', type: 'Application', rect: { x: 0, y: 0, width: 800, height: 1200 } },
      button('e2', 1, 'Follow', 0),
      button('e3', 2, 'Share', 90),
    ],
  });

  expect(response.ok).toBe(true);
  expect(invokeCalls[0]?.positionals?.[0]).toBe('@e2');
});

test('handleFindCommands focus uses the promoted actionable node center', async () => {
  const { response } = await runFindClickScenario({
    positionals: ['Account', 'focus'],
    nodes: [
      {
        index: 0,
        ref: 'e1',
        type: 'Application',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      },
      {
        index: 1,
        ref: 'e2',
        type: 'Cell',
        label: 'Account row',
        hittable: true,
        rect: { x: 16, y: 100, width: 320, height: 64 },
        parentIndex: 0,
      },
      {
        index: 2,
        ref: 'e3',
        type: 'StaticText',
        label: 'Account',
        hittable: false,
        rect: { x: 32, y: 116, width: 80, height: 24 },
        parentIndex: 1,
      },
    ],
  });

  expect(response.ok).toBe(true);
  expect(mockDispatch).toHaveBeenLastCalledWith(
    expect.anything(),
    'focus',
    ['176', '132'],
    undefined,
    expect.anything(),
  );
});

test('handleFindCommands focus rejects covered matches before dispatching coordinates', async () => {
  const { response } = await runFindClickScenario({
    positionals: ['Save draft', 'focus'],
    nodes: [
      {
        index: 0,
        ref: 'e1',
        type: 'Application',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      },
      {
        index: 1,
        ref: 'e2',
        type: 'Button',
        label: 'Save draft',
        hittable: false,
        interactionBlocked: 'covered',
        presentationHints: ['covered'],
        rect: { x: 16, y: 790, width: 140, height: 44 },
        parentIndex: 0,
      },
      {
        index: 2,
        ref: 'e3',
        type: 'TabBar',
        hittable: true,
        rect: { x: 0, y: 760, width: 390, height: 84 },
        parentIndex: 0,
      },
    ],
  });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.message).toContain('is covered by another visible element');
    expect(response.error.details?.interactionBlocked).toBe('covered');
  }
  expect(mockDispatch.mock.calls.filter((call) => call[1] === 'focus')).toEqual([]);
});

test('handleFindCommands forwards internal interaction outcome flags only to delegated click', async () => {
  const { response, invokeCalls, session } = await runFindClickScenario({
    positionals: ['Continue', 'click'],
    flags: {
      findFirst: true,
      interactionOutcome: { retryOnNoChange: true },
    },
    nodes: [
      {
        index: 0,
        ref: 'e1',
        type: 'Application',
        rect: { x: 0, y: 0, width: 440, height: 956 },
      },
      {
        index: 1,
        ref: 'e2',
        type: 'Button',
        label: 'Continue',
        rect: { x: 40, y: 870, width: 360, height: 44 },
        parentIndex: 0,
      },
    ],
  });

  expect(response.ok).toBe(true);
  expect(invokeCalls[0]!.flags?.interactionOutcome).toEqual({ retryOnNoChange: true });
  expect(session.actions.at(-1)?.flags).toEqual({});
});

test('handleFindCommands wait bypasses snapshot cache while Android freshness recovery is active', async () => {
  const sessionName = 'android-find-wait';
  const session: SessionState = {
    name: sessionName,
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel 9 Pro XL',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    },
    createdAt: Date.now(),
    actions: [],
  };
  const baselineNodes = Array.from({ length: 16 }, (_, index) => ({
    ref: `e${index + 1}`,
    index,
    depth: 0,
    type: 'android.widget.TextView',
    label: `Inbox row ${index + 1}`,
  }));
  session.snapshot = {
    nodes: baselineNodes,
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: baselineNodes.length,
    baselineSignatures: buildSnapshotSignatures(baselineNodes),
    routeComparable: true,
  };

  mockDispatch
    .mockResolvedValueOnce({
      nodes: Array.from({ length: 16 }, (_, index) => ({
        index,
        depth: 0,
        type: 'android.widget.TextView',
        label: `Inbox row ${index + 1}`,
      })),
      truncated: false,
      backend: 'android',
      analysis: { rawNodeCount: 16, maxDepth: 1 },
    })
    .mockResolvedValueOnce({
      nodes: [
        { index: 0, depth: 0, type: 'android.widget.TextView', label: 'Create document' },
        { index: 1, depth: 0, type: 'android.widget.Button', label: 'Submit', hittable: true },
      ],
      truncated: false,
      backend: 'android',
      analysis: { rawNodeCount: 2, maxDepth: 1 },
    });

  const { response } = await runFindClickScenario({
    positionals: ['text', 'Create document', 'wait', '700'],
    session,
  });

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data?.found).toBe(true);
  }
  expect(mockDispatch).toHaveBeenCalledTimes(2);
});

test('handleFindCommands wait reports sparse verdict through selector runtime route', async () => {
  const session = makeSession('default');
  session.snapshot = {
    nodes: [
      {
        index: 0,
        ref: 'e1',
        type: 'Button',
        label: 'Previous screen action',
        rect: { x: 24, y: 600, width: 180, height: 52 },
      },
    ],
    createdAt: Date.now(),
    backend: 'xctest',
  };
  const previousSnapshot = session.snapshot;
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command !== 'snapshot') return {};
    return {
      backend: 'xctest',
      quality: {
        state: 'sparse',
        backend: 'private-ax',
        reason: 'sparse tree',
        reasonCode: 'sparse-tree',
      },
      nodes: [
        {
          index: 0,
          type: 'Application',
        },
      ],
    };
  });

  const { response } = await runFindClickScenario({
    positionals: ['text', 'Never appears', 'wait', '350'],
    session,
  });

  expect(response.ok).toBe(false);
  expect(session.snapshot).toBe(previousSnapshot);
  expect(!response.ok && response.error).toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'find could not read the current accessibility tree',
    details: {
      reason: 'sparse tree',
      hint: expect.stringContaining('snapshot quality verdict is sparse'),
    },
  });
});

test('handleFindCommands wait captures fresh snapshots while polling', async () => {
  const { response } = await runFindClickScenario({
    positionals: ['text', 'Never appears', 'wait', '350'],
    nodes: [{ index: 0, depth: 0, type: 'StaticText', label: 'Other text' }],
  });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.message).toContain('find wait timed out');
  }
  // What this test guards is that every poll re-captures instead of reusing the first tree.
  // The exact poll count is a timing artifact and is not assertable: the loop's last sleep
  // consumes whatever remains of the budget, so it lands on `remainingMs() === 0`, and a
  // sleep that returns a millisecond early admits one more poll. Pinning this to 2 made the
  // test fail under CI load on unrelated PRs. Assert the property, not the artifact.
  expect(mockDispatch.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(mockDispatch.mock.calls.every(([, command]) => command === 'snapshot')).toBe(true);
});

test('handleFindCommands click omits refsGeneration — a mutating find never issues a pinnable ref (ADR 0014)', async () => {
  const sessionName = 'default';
  const session = makeSession(sessionName);
  // Two earlier tree replacements happened in this session.
  session.snapshotGeneration = 2;

  const { response, session: storedSession } = await runFindClickScenario({
    positionals: ['Increment', 'click'],
    nodes: [
      {
        index: 0,
        type: 'Button',
        label: 'Increment',
        hittable: true,
        rect: { x: 50, y: 0, width: 100, height: 100 },
        depth: 0,
      },
    ],
    session,
  });

  expect(response.ok).toBe(true);
  // The find capture still replaced the stored tree (generation 3)…
  expect(storedSession.snapshotGeneration).toBe(3);
  if (response.ok) {
    // …but a mutating find must NOT report refsGeneration: its acted ref is
    // diagnostic pre-action identity, so MCP cannot pin and reuse it after the
    // action.
    expect((response.data as Record<string, unknown>).refsGeneration).toBeUndefined();
  }
});

// #1271 stage 2: `find`'s observe-vs-mutate split is a positional, so unlike
// snapshot/get/is it cannot be settled by the CLI grammar's per-command
// `allowedFlags`. A mutating find always records, so `--record` on one is
// meaningless — refuse it loudly rather than accept and ignore it. Enforced
// daemon-side so every surface (CLI/Node/MCP) inherits the same refusal.
test('find rejects --record on a mutating action before any device work', async () => {
  const { response, invokeCalls } = await runFindClickScenario({
    positionals: ['label', 'Apps', 'click'],
    flags: { record: true },
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toMatch(/--record only applies to a read-only find/);
  // Refused before the action dispatched.
  expect(invokeCalls).toHaveLength(0);
});

test('read-only find while recording is intentionally deferred from target-v1 evidence (#1349)', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeAuthoringSession(sessionName);
  sessionStore.set(sessionName, session);
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') {
      return {
        nodes: [
          {
            index: 0,
            depth: 0,
            type: 'Button',
            label: 'Save',
            rect: { x: 10, y: 10, width: 40, height: 20 },
            enabled: true,
            hittable: true,
          },
        ],
      };
    }
    return {};
  });

  const response = await handleFindCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'find',
      positionals: ['text', 'Save', 'exists'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/test.log',
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response?.ok).toBe(true);
  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.command).toBe('find');
  // The fuzzy-locator resolution has no selector-chain identity token for
  // replay verification, so read-only find records NO annotation in v1 —
  // an explicit deferral, not an accident.
  expect(recordedAction?.targetEvidence).toBeUndefined();
});

// --- #1654: the production route, find handler through the real interaction leaf ---
//
// The tests above stub `invoke`, so they prove what find SENDS. These drive the
// real `handleInteractionCommands` on the other end, so they prove what the
// action actually acts on — and they fail if either producer (click or fill)
// stops attaching the channel, which a hand-built request cannot catch.

const findRouteContextFromFlags = (flags: CommandFlags | undefined) => ({
  count: flags?.count,
  intervalMs: flags?.intervalMs,
  delayMs: flags?.delayMs,
  holdMs: flags?.holdMs,
  jitterPx: flags?.jitterPx,
  doubleTap: flags?.doubleTap,
  clickButton: flags?.clickButton,
});

/** The tree find's capture returns: "Save" sits at a distinctive point. */
function freshFindTree() {
  return [
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Save',
      rect: { x: 300, y: 500, width: 20, height: 20 },
      enabled: true,
      hittable: true,
    },
  ];
}

/**
 * A defensive tree in which the same ref body names a different element. No
 * reachable production path is currently known to advance `session.snapshot`
 * in this interval; forcing it here pins the one-resolution contract itself.
 */
function divergedSessionTree() {
  return {
    nodes: [
      { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 }, ref: 'e1' },
      {
        index: 1,
        parentIndex: 0,
        type: 'XCUIElementTypeButton',
        label: 'Delete',
        rect: { x: 10, y: 700, width: 100, height: 40 },
        enabled: true,
        hittable: true,
        ref: 'e2',
      },
    ],
    createdAt: Date.now(),
    backend: 'xctest' as const,
  };
}

async function runFindThroughLeaf(options: {
  positionals: string[];
  divergeBeforeDispatch: boolean;
}): Promise<{ response: DaemonResponse | null; invokeCalls: DaemonRequest[] }> {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  sessionStore.set(sessionName, session);

  mockDispatch.mockImplementation(async (_device, command) =>
    command === 'snapshot' ? { nodes: freshFindTree(), backend: 'xctest' } : {},
  );

  const invokeCalls: DaemonRequest[] = [];
  const response = await handleFindCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'find',
      positionals: options.positionals,
      flags: {},
    },
    sessionName,
    logPath: '/tmp/test.log',
    sessionStore,
    invoke: async (req) => {
      invokeCalls.push(req);
      if (options.divergeBeforeDispatch) {
        const current = sessionStore.get(sessionName);
        if (current) {
          current.snapshot = divergedSessionTree();
          sessionStore.set(sessionName, current);
        }
      }
      // The real leaf, not a stub.
      return (
        (await handleInteractionCommands({
          req,
          sessionName,
          sessionStore,
          contextFromFlags: findRouteContextFromFlags,
        })) ?? { ok: false, error: { code: 'COMMAND_FAILED', message: 'no interaction handler' } }
      );
    },
  });
  return { response, invokeCalls };
}

function dispatchedPoint(command: 'press' | 'fill'): string[] | undefined {
  const call = mockDispatch.mock.calls.find((entry) => entry[1] === command);
  return call?.[2] as string[] | undefined;
}

test('#1654 production route: find click carries its resolved node into the real interaction leaf', async () => {
  const { response, invokeCalls } = await runFindThroughLeaf({
    positionals: ['text', 'Save', 'click'],
    divergeBeforeDispatch: false,
  });

  expect(response?.ok).toBe(true);
  // The producer attaches the channel — fails if handleFindClick stops doing so.
  expect(invokeCalls[0]?.internal?.findResolvedTarget?.node?.label).toBe('Save');
  expect(invokeCalls[0]?.internal?.findResolvedTarget?.ref).toBe('@e2');
  expect(dispatchedPoint('press')).toEqual(['310', '510']);
});

test('#1654 production route: find fill carries its resolved node into the real interaction leaf', async () => {
  const { response, invokeCalls } = await runFindThroughLeaf({
    positionals: ['text', 'Save', 'fill', 'hello'],
    divergeBeforeDispatch: false,
  });

  expect(response?.ok).toBe(true);
  // Fill has its own producer and its own forwarding hop; assert it separately.
  expect(invokeCalls[0]?.internal?.findResolvedTarget?.node?.label).toBe('Save');
  expect(invokeCalls[0]?.internal?.findResolvedTarget?.ref).toBe('@e2');
  expect(dispatchedPoint('fill')).toEqual(['310', '510', 'hello']);
});

test('#1654 defensive invariant: a tree that advances mid-dispatch cannot retarget find click', async () => {
  // This deliberately forces an otherwise-unreached state: a second lookup of
  // `@e2` would find "Delete" at (60, 720), while the resolved handoff must keep
  // find's selected "Save" node at (310, 510).
  const { response } = await runFindThroughLeaf({
    positionals: ['text', 'Save', 'click'],
    divergeBeforeDispatch: true,
  });

  expect(response?.ok).toBe(true);
  expect(dispatchedPoint('press')).toEqual(['310', '510']);
});

test('#1654 defensive invariant: a tree that advances mid-dispatch cannot retarget find fill', async () => {
  const { response } = await runFindThroughLeaf({
    positionals: ['text', 'Save', 'fill', 'hello'],
    divergeBeforeDispatch: true,
  });

  expect(response?.ok).toBe(true);
  expect(dispatchedPoint('fill')).toEqual(['310', '510', 'hello']);
});
