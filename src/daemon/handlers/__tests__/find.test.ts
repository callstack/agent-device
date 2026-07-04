import { test, expect, vi, beforeEach } from 'vitest';
import { handleFindCommands } from '../find.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../types.ts';
import { buildSnapshotSignatures } from '../../android-snapshot-freshness.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { makeIosSession as makeSession } from '../../../__tests__/test-utils/session-factories.ts';

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
  expect(mockDispatch).toHaveBeenCalledTimes(2);
});
