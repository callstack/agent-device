import type { Point } from '@agent-device/kernel/snapshot';
import { presentIosSnapshotAcquisition } from '@agent-device/capture-kit/ios-snapshot-runtime';
import { presentIosRunnerSnapshot } from '@agent-device/capture-kit/ios-snapshot-engine';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import { attachSnapshotNativePressTargets } from '@agent-device/contracts/snapshot-private-evidence';
import { afterEach, expect, test, vi } from 'vitest';
import type { AgentDeviceBackend } from '@agent-device/contracts/backend';
import type { NativePressReadiness } from '@agent-device/contracts/selector-observation-runtime';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { createLocalArtifactAdapter } from '@agent-device/host-kit/local-artifact-adapter';
import {
  getRequestSignal,
  markRequestCanceled,
  withRequestDeadline,
} from '@agent-device/host-kit/request';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { createAgentDevice } from '../../../runtime.ts';
import { createMemorySessionStore } from '../../../command-runtime/runtime-factory.ts';
import { ref, selector } from './selector-read-utils.ts';

afterEach(() => vi.restoreAllMocks());

// Invariant: a geometrically unchanged, canonically authorized control can still be natively
// blocked. Removing the live guard makes the first tap arrive before `ready`; motion-only tests
// cannot detect that because their fake native owner exposes only geometry.
function tree(label = 'Continue', childPhase?: 'before' | 'after') {
  const snapshot = makeSnapshotState([
    { index: 0, type: 'Application', depth: 0, rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      index: 1,
      type: 'Button',
      label,
      depth: 1,
      parentIndex: 0,
      rect: childPhase
        ? { x: 20, y: 140, width: 300, height: 100 }
        : { x: 40, y: 240, width: 100, height: 50 },
      hittable: true,
    },
  ]);
  if (childPhase)
    snapshot.nodes.push({
      index: 2,
      ref: 'e3',
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Independent child',
      hittable: true,
      rect:
        childPhase === 'before'
          ? { x: 20, y: 220, width: 300, height: 20 }
          : { x: 20, y: 166, width: 300, height: 74 },
    });
  const node = snapshot.nodes[1]!;
  attachSnapshotNativePressTargets(
    snapshot.nodes,
    new Map([[node.index, { type: 'Button', label, rect: node.rect! }]]),
  );
  return snapshot;
}

async function exercise(input: {
  kind?: 'selector' | 'ref' | 'point';
  states: NativePressReadiness[];
  timeoutMs?: number;
  changeTarget?: boolean;
  cancelInRead?: boolean;
  transportFailure?: boolean;
  nativeBudgetAbort?: boolean;
  expireInRead?: boolean;
  missingSource?: boolean;
  movingChild?: boolean;
  options?: { count?: number; doubleTap?: boolean };
}) {
  const events: string[] = [];
  const points: Point[] = [];
  const requestId = `readiness:${Math.random()}`;
  const run = withRequestDeadline(requestId, input.timeoutMs ?? 2_000, async () => {
    let reads = 0;
    const device = createAgentDevice({
      backend: {
        platform: 'ios',
        captureSnapshot: async () => {
          events.push('capture');
          const snapshot = tree(
            input.changeTarget && reads > 0 ? 'Replacement' : 'Continue',
            input.movingChild ? (reads > 0 ? 'after' : 'before') : undefined,
          );
          if (input.missingSource) attachSnapshotNativePressTargets(snapshot.nodes, new Map());
          return { snapshot };
        },
        readPressReadiness: async (context) => {
          events.push('read');
          reads++;
          if (input.cancelInRead) markRequestCanceled(requestId);
          if (input.transportFailure) throw new Error('native query failed');
          if (input.nativeBudgetAbort && reads > 1) {
            context.signal!.throwIfAborted();
            await new Promise<void>((_resolve, reject) => {
              context.signal!.addEventListener('abort', () => reject(context.signal!.reason), {
                once: true,
              });
            });
          }
          const state = input.states[Math.min(reads - 1, input.states.length - 1)]!;
          events.push(state);
          if (input.expireInRead) {
            const realNow = Date.now;
            vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 10_000);
          }
          return state;
        },
        tap: async (_context, point) => {
          events.push('tap');
          points.push(point);
          return { ok: true };
        },
      } satisfies AgentDeviceBackend,
      artifacts: createLocalArtifactAdapter(),
      sessions: createMemorySessionStore([
        {
          name: 'default',
          snapshot: tree('Continue', input.movingChild ? 'before' : undefined),
          refFrameSnapshot: tree('Continue', input.movingChild ? 'before' : undefined),
        },
      ]),
      policy: localCommandPolicy(),
      signal: input.nativeBudgetAbort ? undefined : getRequestSignal(requestId),
    });
    await device.interactions.press(
      input.kind === 'point'
        ? { kind: 'point', x: 90, y: 265 }
        : input.kind === 'ref'
          ? ref('@e2')
          : selector('label="Continue"'),
      { requestId, ...input.options },
    );
    return { ok: true, data: {} };
  });
  return { run, events, points };
}

for (const kind of ['selector', 'ref'] as const) {
  test(`${kind} press waits for native readiness and sends its original point once`, async () => {
    const { run, events, points } = await exercise({ kind, states: ['blocked', 'ready'] });
    await run;
    expect(events.indexOf('tap')).toBeGreaterThan(events.indexOf('ready'));
    expect(events.filter((event) => event === 'capture').length).toBeGreaterThanOrEqual(
      kind === 'ref' ? 1 : 2,
    );
    expect(points).toEqual([{ x: 90, y: 265 }]);
  });
}

for (const states of [['ambiguous'], ['missing']] as NativePressReadiness[][]) {
  test(`unconfirmed ${states[0]} target never sends input`, async () => {
    const { run, points } = await exercise({ states, timeoutMs: 100 });
    await expect(run).rejects.toMatchObject({ details: { dispatched: 'no' } });
    expect(points).toEqual([]);
  });
}

test('permanent native blocking reaches the existing request deadline without sending input', async () => {
  const { run, points } = await exercise({ states: ['blocked'], timeoutMs: 100 });
  await expect(run).rejects.toMatchObject({
    details: { reason: 'daemon_request_timeout', dispatched: 'no' },
  });
  expect(points).toEqual([]);
});

test('a native budget abort preserves the blocked state instead of reporting a read failure', async () => {
  const { run, points } = await exercise({
    states: ['blocked'],
    timeoutMs: 150,
    nativeBudgetAbort: true,
  });
  await expect(run).rejects.toMatchObject({
    details: { reason: 'daemon_request_timeout', readiness: 'blocked', dispatched: 'no' },
  });
  expect(points).toEqual([]);
});

test('a replaced canonical target is refused before another native query or tap', async () => {
  const { run, points, events } = await exercise({
    kind: 'ref',
    states: ['blocked', 'ready'],
    changeTarget: true,
  });
  await expect(run).rejects.toMatchObject({ details: { dispatched: 'no' } });
  expect(points).toEqual([]);
  expect(events).not.toContain('ready');
});

for (const failure of ['cancelInRead', 'transportFailure'] as const) {
  test(`${failure} cannot fall through to dispatch`, async () => {
    const { run, points } = await exercise({ states: ['ready'], [failure]: true });
    await expect(run).rejects.toMatchObject({
      details: {
        dispatched: 'no',
        ...(failure === 'cancelInRead'
          ? { reason: 'request_canceled' }
          : { reason: 'target_not_ready', readiness: 'native-read-failed' }),
      },
    });
    expect(points).toEqual([]);
  });
}

test('explicit coordinates preserve their existing dispatch semantics', async () => {
  const { run, events, points } = await exercise({ kind: 'point', states: ['blocked'] });
  await run;
  expect(events).not.toContain('read');
  expect(points).toEqual([{ x: 90, y: 265 }]);
});

// A timer callback may not have fired when the native promise resolves. Absolute time still wins.
test('a late native ready reply cannot send input before the deadline timer callback', async () => {
  const { run, points } = await exercise({ states: ['ready'], expireInRead: true });
  await expect(run).rejects.toMatchObject({ details: { dispatched: 'no' } });
  expect(points).toEqual([]);
});

test('a child moving into the old parent point uses the fresh canonically guarded point', async () => {
  const { run, points } = await exercise({ states: ['blocked', 'ready'], movingChild: true });
  await run;
  expect(points).toHaveLength(1);
  expect(points[0]!.x).toBe(170);
  expect(points[0]!.y).toBeGreaterThanOrEqual(140);
  expect(points[0]!.y).toBeLessThan(166);
});

for (const options of [{ count: 1 }, { doubleTap: false }]) {
  test(`explicit ordinary tap defaults still await readiness: ${JSON.stringify(options)}`, async () => {
    const { run, events, points } = await exercise({ states: ['blocked', 'ready'], options });
    await run;
    expect(events.indexOf('tap')).toBeGreaterThan(events.indexOf('ready'));
    expect(points).toHaveLength(1);
  });
}

for (const producer of ['simulator-ax-bridge', 'apple-runner'] as const) {
  test(`${producer} capture stored and read through the session retains raw native row binding privately`, async () => {
    const screen = { x: 0, y: 0, width: 400, height: 800 };
    const full = { x: 20, y: 100, width: 300, height: 100 };
    const rawNodes = [
      { index: 0, depth: 0, type: 'Application', rect: screen },
      {
        index: 1,
        parentIndex: 0,
        depth: 1,
        type: 'ScrollView',
        rect: { x: 0, y: 150, width: 400, height: 100 },
      },
      { index: 2, parentIndex: 1, depth: 2, type: 'Cell', label: 'General', rect: full },
      {
        index: 3,
        parentIndex: 2,
        depth: 3,
        type: 'Button',
        label: 'General',
        identifier: 'settings-general',
        rect: full,
      },
    ];
    const request = {
      projection: 'regular',
      interactiveOnly: true,
      depth: null,
      scope: null,
      customActions: false,
      acquisitionIntent: 'full',
    } as const;
    const snapshot =
      producer === 'simulator-ax-bridge'
        ? buildSnapshotState(
            presentIosSnapshotAcquisition(
              {
                stage: 'acquired',
                acquisition: {
                  producer,
                  intent: 'full',
                  nodes: rawNodes,
                  truncated: false,
                  viewport: { kind: 'reported', rect: screen },
                  lineage: {},
                  residue: [],
                },
              },
              { interactiveOnly: true },
            ),
            { snapshotInteractiveOnly: true },
          )
        : buildSnapshotState(
            {
              ...presentIosRunnerSnapshot(
                {
                  stage: 'presented',
                  presentation: {
                    producer,
                    intent: 'full',
                    payload: {
                      nodes: rawNodes.map((node) => ({
                        ...node,
                        rect: node.index > 1 ? { ...full, y: 150, height: 50 } : node.rect,
                        nativePressTarget: {
                          type: node.type,
                          label: 'label' in node ? node.label : undefined,
                          identifier: 'identifier' in node ? node.identifier : undefined,
                          rect: node.rect,
                        },
                      })),
                      truncated: false,
                    },
                  },
                  validation: {
                    presentationKey: request,
                    viewport: { kind: 'reported', rect: screen },
                    hittability: { kind: 'available' },
                    lineage: {},
                    residue: [],
                  },
                },
                request,
              ),
              backend: 'xctest',
              producer,
            },
            { snapshotInteractiveOnly: true },
          );
    const points: Point[] = [];
    const device = createAgentDevice({
      backend: {
        platform: 'ios',
        captureSnapshot: async () => ({ snapshot }),
        // Independent native facts: the real Cell has no promoted child id and is not clipped.
        readPressReadiness: async (_context, target) =>
          target.type === 'Cell' &&
          !target.identifier &&
          target.rect.y === 100 &&
          target.rect.height === 100
            ? 'ready'
            : 'missing',
        tap: async (_context, point) => {
          points.push(point);
          return { ok: true };
        },
      },
      artifacts: createLocalArtifactAdapter(),
      policy: localCommandPolicy(),
      sessions: createMemorySessionStore([{ name: 'default' }]),
    });
    const captured = await device.capture.snapshot({ interactiveOnly: true });
    const cell = captured.nodes.find((node) => node.type === 'Cell')!;
    expect(cell.identifier).toBe('settings-general');
    expect(JSON.stringify(captured)).not.toContain('nativePressTarget');
    expect(JSON.stringify(await device.sessions.get('default'))).not.toContain('nativePressTarget');
    await device.interactions.press(ref('@' + cell.ref));
    expect(points).toHaveLength(1);
  });
}

test('an admitted native owner without capture source provenance refuses before query or input', async () => {
  const { run, events, points } = await exercise({ states: ['ready'], missingSource: true });
  await expect(run).rejects.toMatchObject({
    details: { readiness: 'missing-source-binding', dispatched: 'no' },
  });
  expect(events).not.toContain('read');
  expect(points).toEqual([]);
});
