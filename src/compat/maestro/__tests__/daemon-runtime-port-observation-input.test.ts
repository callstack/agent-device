import { expect, test } from 'vitest';
import type { DaemonRequest } from '../../../daemon/types.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import { makeBaseRequest, makeDependencies } from './daemon-runtime-port-fixtures.ts';

test.each([
  [{ kind: 'inputText', source: { line: 2 }, text: 'hello' }, 'hello'],
  [{ kind: 'eraseText', source: { line: 2 }, charactersToErase: 3 }, '\b\b\b'],
] as const)('waits for a stable snapshot after a Maestro $kind mutation', async (command, text) => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      snapshots += 1;
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
              type: 'TextField',
              value: snapshots === 1 ? 'pending' : 'committed',
              rect: { x: 20, y: 40, width: 120, height: 44 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'android',
  });

  await port.execute({ command, generation: 0, env: {}, invalidateObservation() {} });

  expect(requests.map((request) => request.command)).toEqual([
    'type',
    'snapshot',
    'snapshot',
    'snapshot',
  ]);
  expect(requests[0]?.positionals).toEqual([text]);
});

test('propagates input stabilization failures after dispatch', async () => {
  const requests: DaemonRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'snapshot') {
        return {
          ok: false,
          error: { code: 'COMMAND_FAILED', message: 'Snapshot helper is unavailable.' },
        };
      }
      return { ok: true, data: {} };
    },
    dependencies: makeDependencies(),
    platform: 'android',
  });

  await expect(
    port.execute({
      command: { kind: 'inputText', source: { line: 2 }, text: 'hello' },
      generation: 0,
      env: {},
      invalidateObservation() {},
    }),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED', message: 'Snapshot helper is unavailable.' });
  expect(requests.map(({ command }) => command)).toEqual(['type', 'snapshot']);
});

test('commits Maestro input text before dispatching an immediate tap', async () => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  let textCommitted = false;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'click') {
        if (!textCommitted) throw new Error('tap raced the text commit');
        return { ok: true, data: {} };
      }
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      snapshots += 1;
      textCommitted = snapshots >= 2;
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
              type: 'Button',
              identifier: 'navigate',
              rect: { x: 20, y: 40, width: 120, height: 44 },
            },
            {
              index: 2,
              parentIndex: 0,
              type: 'TextField',
              value: textCommitted ? 'hello' : '',
              rect: { x: 20, y: 100, width: 120, height: 44 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'android',
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
      target: { space: 'target', selector: { id: 'navigate' } },
    },
    generation: 1,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map((request) => request.command)).toEqual([
    'type',
    'snapshot',
    'snapshot',
    'snapshot',
    'click',
  ]);
});
