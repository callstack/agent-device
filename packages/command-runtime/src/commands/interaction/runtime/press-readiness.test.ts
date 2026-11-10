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
function tree(label = 'Continue') {
  return makeSnapshotState([
    { index: 0, type: 'Application', depth: 0, rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      index: 1,
      type: 'Button',
      label,
      depth: 1,
      parentIndex: 0,
      rect: { x: 40, y: 240, width: 100, height: 50 },
      hittable: true,
    },
  ]);
}

async function exercise(input: {
  kind?: 'selector' | 'ref' | 'point';
  states: NativePressReadiness[];
  timeoutMs?: number;
  changeTarget?: boolean;
  cancelInRead?: boolean;
  transportFailure?: boolean;
  expireInRead?: boolean;
}) {
  const events: string[] = [];
  const points: unknown[] = [];
  const requestId = `readiness:${Math.random()}`;
  const run = withRequestDeadline(requestId, input.timeoutMs ?? 2_000, async () => {
    let reads = 0;
    const device = createAgentDevice({
      backend: {
        platform: 'ios',
        captureSnapshot: async () => {
          events.push('capture');
          return { snapshot: tree(input.changeTarget && reads > 0 ? 'Replacement' : 'Continue') };
        },
        readPressReadiness: async () => {
          events.push('read');
          reads++;
          if (input.cancelInRead) markRequestCanceled(requestId);
          if (input.transportFailure) throw new Error('native query failed');
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
        { name: 'default', snapshot: tree(), refFrameSnapshot: tree() },
      ]),
      policy: localCommandPolicy(),
      signal: getRequestSignal(requestId),
    });
    await device.interactions.press(
      input.kind === 'point'
        ? { kind: 'point', x: 90, y: 265 }
        : input.kind === 'ref'
          ? ref('@e2')
          : selector('label="Continue"'),
      { requestId },
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
    await expect(run).rejects.toMatchObject({ details: { dispatched: 'no' } });
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
