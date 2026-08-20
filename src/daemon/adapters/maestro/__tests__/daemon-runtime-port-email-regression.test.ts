import { expect, test } from 'vitest';
import type { DaemonRequest } from '../../../types.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import { makeBaseRequest, makeDependencies } from './daemon-runtime-port-fixtures.ts';

test('resolves the Email input below its caption through the runtime port', async () => {
  const requests: DaemonRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      return request.command === 'snapshot'
        ? {
            ok: true,
            data: {
              createdAt: requests.length,
              nodes: [
                { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
                {
                  index: 1,
                  parentIndex: 0,
                  type: 'StaticText',
                  label: 'Email',
                  rect: { x: 20, y: 100, width: 160, height: 30 },
                },
                {
                  index: 2,
                  parentIndex: 0,
                  type: 'TextField',
                  label: 'Email',
                  identifier: 'field-email',
                  rect: { x: 20, y: 180, width: 240, height: 44 },
                },
              ],
            },
          }
        : { ok: true, data: {} };
    },
    dependencies: makeDependencies(),
    platform: 'android',
  });

  await port.execute({
    command: {
      kind: 'tapOn',
      source: { line: 2 },
      target: { space: 'target', selector: { below: { text: 'Email' } } },
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });
  await port.execute({
    command: { kind: 'inputText', source: { line: 3 }, text: 'qa@example.com' },
    generation: 1,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.find((request) => request.command === 'click')?.positionals).toEqual([
    '140',
    '202',
  ]);
  expect(requests.find((request) => request.command === 'type')?.positionals).toEqual([
    'qa@example.com',
  ]);
});
