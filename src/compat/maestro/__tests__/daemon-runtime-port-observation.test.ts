import { expect, test } from 'vitest';
import type { DaemonInvokeFn, DaemonRequest } from '../../../daemon/types.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import { makeBaseRequest, makeDependencies } from './daemon-runtime-port-fixtures.ts';

test('does not pair an observation with a later same-generation snapshot', async () => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      snapshots += 1;
      const targetX = snapshots >= 4 ? 40 : 200;
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

  const observation = await port.observe({
    condition: { kind: 'visible', selector: { id: 'ready' } },
    timeoutMs: 0,
    generation: 0,
    env: {},
  });
  await port.execute({
    command: { kind: 'waitForAnimationToEnd', source: { line: 2 }, timeout: 500 },
    generation: 0,
    cachedObservation: observation,
    env: {},
  });
  await port.execute({
    command: {
      kind: 'tapOn',
      source: { line: 3 },
      target: { space: 'target', selector: { id: 'continue' } },
    },
    generation: 0,
    cachedObservation: observation,
    env: {},
  });

  expect(requests.map((request) => request.command)).toEqual([
    'snapshot',
    'snapshot',
    'snapshot',
    'snapshot',
    'click',
  ]);
  expect(requests.at(-1)?.positionals).toEqual(['100', '122']);
});

test('fails scrollUntilVisible when the target stays absent', async () => {
  const invoke: DaemonInvokeFn = async (request) =>
    request.command === 'snapshot'
      ? {
          ok: true,
          data: {
            createdAt: 0,
            nodes: [
              {
                index: 0,
                type: 'Application',
                rect: { x: 0, y: 0, width: 402, height: 874 },
              },
            ],
          },
        }
      : { ok: true, data: {} };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke,
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  await expect(
    port.execute({
      command: {
        kind: 'scrollUntilVisible',
        source: { line: 2 },
        element: { text: 'Discover' },
        direction: 'up',
        timeout: 500,
      },
      generation: 0,
      env: {},
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Maestro scrollUntilVisible target did not become visible.',
  });
});
