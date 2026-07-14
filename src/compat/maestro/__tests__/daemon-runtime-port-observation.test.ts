import { expect, test } from 'vitest';
import type { DaemonRequest } from '../../../daemon/types.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import {
  MAESTRO_OBSERVATION_POLL_MS,
  resolveTypedMaestroTarget,
  waitForTypedSnapshotStability,
} from '../daemon-runtime-port-observation.ts';
import { makeBaseRequest, makeDependencies, makeSnapshot } from './daemon-runtime-port-fixtures.ts';

test('replaces pre-mutation evidence with the stable post-mutation snapshot', async () => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      snapshots += 1;
      const targetX = snapshots >= 2 ? 40 : 200;
      return {
        ok: true,
        data: {
          createdAt: snapshots,
          nodes: [
            {
              index: 0,
              type: 'Application',
              rect: { x: 0, y: 0, width: 402, height: 874 },
            },
            {
              index: 1,
              parentIndex: 0,
              type: 'Text',
              identifier: 'ready',
              rect: { x: 20, y: 40, width: 120, height: 44 },
            },
            {
              index: 2,
              parentIndex: 0,
              type: 'Button',
              identifier: 'continue',
              rect: { x: targetX, y: 100, width: 120, height: 44 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  await port.observe({
    condition: { kind: 'visible', selector: { id: 'ready' } },
    timeoutMs: 0,
    generation: 0,
    env: {},
  });
  await port.execute({
    command: { kind: 'inputText', source: { line: 2 }, text: 'hello' },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });
  await port.execute({
    command: {
      kind: 'tapOn',
      source: { line: 3 },
      target: { space: 'target', selector: { id: 'continue' } },
    },
    generation: 1,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map((request) => request.command)).toEqual([
    'snapshot',
    'type',
    'snapshot',
    'snapshot',
    'click',
  ]);
  expect(requests.at(-1)?.positionals).toEqual(['id="continue"']);
  expect(requests.at(-1)?.flags?.maestro?.expectedTapPoint).toEqual({ x: 100, y: 122 });
});

test('computes expensive target evidence only for the command policies that consume it', () => {
  const snapshot = makeSnapshot([
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'continue',
      hittable: true,
      rect: { x: 20, y: 40, width: 120, height: 44 },
    },
  ]);
  const base = {
    context: { generation: 0, env: {} },
    snapshot,
    platform: 'ios' as const,
  };

  const ordinary = resolveTypedMaestroTarget({
    ...base,
    query: { selector: { id: 'continue' }, purpose: 'tap', timeoutMs: 0 },
  });
  const atomicRetry = resolveTypedMaestroTarget({
    ...base,
    query: {
      selector: { id: 'continue' },
      purpose: 'tap',
      timeoutMs: 0,
      allowAtomicSelectorDispatch: true,
      includeSurfaceSignature: true,
    },
  });

  expect(ordinary).not.toHaveProperty('surfaceSignature');
  expect(ordinary).not.toHaveProperty('dispatchSelector');
  expect(atomicRetry.surfaceSignature).toMatch(/^[a-f0-9]{64}$/);
  expect(atomicRetry.dispatchSelector).toEqual({ key: 'id', value: 'continue' });
});

test('compares snapshots before sleeping and captures once beyond a zero settle budget', async () => {
  const clock = { value: 0 };
  const captures = [
    { createdAt: 1, nodes: [{ ref: '@e1', index: 0, type: 'Text', value: 'moving' }] },
    { createdAt: 2, nodes: [{ ref: '@e1', index: 0, type: 'Text', value: 'settled' }] },
  ];
  let captureIndex = 0;

  const result = await waitForTypedSnapshotStability({
    timeoutMs: 0,
    context: { generation: 0, env: {} },
    snapshot: async () => captures[Math.min(captureIndex++, captures.length - 1)]!,
    dependencies: {
      now: () => clock.value,
      sleep: async () => {
        throw new Error('zero-budget settling must not sleep');
      },
    },
  });

  expect(captureIndex).toBe(2);
  expect(result.nodes[0]?.value).toBe('settled');
});

test('confirms an unchanged hierarchy across one polling interval', async () => {
  const clock = { value: 0 };
  let captures = 0;

  await waitForTypedSnapshotStability({
    timeoutMs: 1_000,
    context: { generation: 0, env: {} },
    snapshot: async () => {
      captures += 1;
      return makeSnapshot([{ index: 0, type: 'Text', value: 'stable' }]);
    },
    dependencies: makeDependencies(clock),
  });

  expect(captures).toBe(2);
  expect(clock.value).toBe(MAESTRO_OBSERVATION_POLL_MS);
});
