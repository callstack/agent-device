import { INTERACTION_ERROR_REASONS } from '@agent-device/contracts/interaction';
import type { DaemonError } from '@agent-device/kernel/errors';
import { expect, test } from 'vitest';
import type { DaemonRequest } from '../../../types.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import { makeBaseRequest, makeDependencies } from './daemon-runtime-port-fixtures.ts';

function makeSelectorDispatchPort(firstClickError: DaemonError) {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  let clicks = 0;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'click') {
        clicks += 1;
        return clicks === 1 ? { ok: false, error: firstClickError } : { ok: true, data: {} };
      }
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
              type: 'Button',
              identifier: 'profile-button',
              rect: { x: snapshots === 1 ? 20 : 160, y: 100, width: 120, height: 44 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'ios',
  });
  return { port, requests };
}

async function tapProfileButton(port: ReturnType<typeof makeSelectorDispatchPort>['port']) {
  await port.execute({
    command: {
      kind: 'tapOn',
      source: { line: 2 },
      target: { space: 'target', selector: { id: 'profile-button' } },
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });
}

test('falls back to fresh Maestro resolution when nested selector resolution misses transiently', async () => {
  const { port, requests } = makeSelectorDispatchPort({
    code: 'COMMAND_FAILED',
    message: 'Selector did not match: id="profile-button"',
    details: { reason: INTERACTION_ERROR_REASONS.selectorNotFound },
  });

  await tapProfileButton(port);

  expect(requests.map((request) => request.command)).toEqual([
    'snapshot',
    'click',
    'snapshot',
    'click',
  ]);
  expect(requests.filter(({ command }) => command === 'click').at(-1)?.positionals).toEqual([
    '220',
    '122',
  ]);
});

test('does not fall back for an unrelated COMMAND_FAILED response', async () => {
  const { port, requests } = makeSelectorDispatchPort({
    code: 'COMMAND_FAILED',
    message: 'Keyboard dispatch timed out.',
  });

  await expect(tapProfileButton(port)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Keyboard dispatch timed out.',
  });
  expect(requests.map((request) => request.command)).toEqual(['snapshot', 'click']);
});
