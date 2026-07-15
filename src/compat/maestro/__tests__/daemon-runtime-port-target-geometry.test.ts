import { expect, test } from 'vitest';
import type { DaemonRequest } from '../../../daemon/types.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import { makeBaseRequest, makeDependencies } from './daemon-runtime-port-fixtures.ts';

test('uses canonical iOS presentation only for atomic selector uniqueness', async () => {
  const requests: DaemonRequest[] = [];
  const duplicateRect = { x: 0, y: 298, width: 393, height: 48 };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      return {
        ok: true,
        data: {
          createdAt: 0,
          nodes: [
            {
              index: 0,
              depth: 0,
              type: 'Application',
              rect: { x: 0, y: 0, width: 393, height: 852 },
            },
            {
              index: 1,
              depth: 1,
              parentIndex: 0,
              type: 'Other',
              label: 'First',
              rect: duplicateRect,
            },
            {
              index: 2,
              depth: 2,
              parentIndex: 1,
              type: 'Button',
              label: 'First',
              rect: duplicateRect,
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  await port.execute({
    command: {
      kind: 'tapOn',
      source: { line: 2 },
      target: { space: 'target', selector: { text: 'First' } },
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'click']);
  expect(requests[0]?.flags?.snapshotInteractiveOnly).toBeUndefined();
  expect(requests[1]?.positionals).toEqual(['text="First"']);
});

test('uses resolved iOS geometry when canonical presentation changes target bounds', async () => {
  const requests: DaemonRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      return {
        ok: true,
        data: {
          createdAt: 0,
          nodes: [
            {
              index: 0,
              depth: 0,
              type: 'Application',
              rect: { x: 0, y: 0, width: 393, height: 852 },
            },
            {
              index: 1,
              depth: 1,
              parentIndex: 0,
              type: 'Other',
              label: 'Article',
              rect: { x: 0, y: 97, width: 393, height: 48 },
            },
            {
              index: 2,
              depth: 2,
              parentIndex: 1,
              type: 'ScrollView',
              label: 'Article',
              rect: { x: 0, y: 97, width: 393, height: 48 },
            },
            {
              index: 3,
              depth: 3,
              parentIndex: 2,
              type: 'Other',
              label: 'Article',
              rect: { x: -13.666, y: 97, width: 560, height: 48 },
            },
            {
              index: 4,
              depth: 4,
              parentIndex: 3,
              type: 'Other',
              label: 'Article',
              rect: { x: -3.666, y: 97, width: 120, height: 48 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  await port.execute({
    command: {
      kind: 'tapOn',
      source: { line: 2 },
      target: { space: 'target', selector: { text: 'Article' } },
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'click']);
  expect(
    requests.filter(({ command }) => command === 'click').map(({ positionals }) => positionals),
  ).toEqual([['56', '121']]);
});

test('uses the selected iOS node interactive bounds without changing raw target matching', async () => {
  const requests: DaemonRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      return {
        ok: true,
        data: {
          createdAt: 0,
          nodes: [
            {
              index: 0,
              depth: 0,
              type: 'Application',
              rect: { x: 0, y: 0, width: 393, height: 852 },
            },
            {
              index: 1,
              depth: 1,
              parentIndex: 0,
              type: 'Other',
              label: 'Log 1 of 1',
              rect: { x: 0, y: 0, width: 393, height: 852 },
            },
            {
              index: 2,
              depth: 2,
              parentIndex: 1,
              type: 'Other',
              label: 'Dismiss',
              hittable: false,
              rect: { x: 0, y: 770, width: 393, height: 82 },
            },
            {
              index: 3,
              depth: 3,
              parentIndex: 2,
              type: 'Other',
              label: 'Dismiss',
              hittable: false,
              rect: { x: 0, y: 770, width: 196.6667, height: 82 },
            },
            {
              index: 4,
              depth: 4,
              parentIndex: 3,
              type: 'Other',
              label: 'Dismiss',
              hittable: false,
              rect: { x: 0, y: 770, width: 196.6667, height: 48 },
            },
            {
              index: 5,
              depth: 3,
              parentIndex: 2,
              type: 'Other',
              label: 'Minimize',
              rect: { x: 196.6667, y: 770.25, width: 196.0833, height: 81.5 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  await port.execute({
    command: {
      kind: 'tapOn',
      source: { line: 2 },
      target: { space: 'target', selector: { text: 'Dismiss' } },
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'click']);
  expect(requests[1]?.positionals).toEqual(['98', '794']);
});

test('atomically dispatches canonical iOS geometry with the same tap point', async () => {
  const requests: DaemonRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      return {
        ok: true,
        data: {
          createdAt: 0,
          nodes: [
            {
              index: 0,
              depth: 0,
              type: 'Application',
              rect: { x: 0, y: 0, width: 393, height: 852 },
            },
            {
              index: 1,
              depth: 1,
              parentIndex: 0,
              type: 'ScrollView',
              label: 'Article',
              rect: { x: 0, y: 97, width: 393, height: 48 },
            },
            {
              index: 2,
              depth: 2,
              parentIndex: 1,
              type: 'Other',
              label: 'Article',
              rect: { x: -83.5, y: 97, width: 560, height: 48 },
            },
            {
              index: 3,
              depth: 3,
              parentIndex: 2,
              type: 'Other',
              label: 'Article',
              rect: { x: 136.5, y: 97, width: 120, height: 48 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  await port.execute({
    command: {
      kind: 'tapOn',
      source: { line: 2 },
      target: { space: 'target', selector: { text: 'Article' } },
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'click']);
  expect(requests[1]?.positionals).toEqual(['text="Article"']);
});

test('does not collapse distinct nested iOS controls with identical frames', async () => {
  const requests: DaemonRequest[] = [];
  const duplicateRect = { x: 16, y: 298, width: 180, height: 48 };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      return {
        ok: true,
        data: {
          createdAt: 0,
          nodes: [
            { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 393, height: 852 } },
            {
              index: 1,
              parentIndex: 0,
              type: 'Button',
              label: 'Save',
              identifier: 'save-row',
              rect: duplicateRect,
            },
            {
              index: 2,
              parentIndex: 1,
              type: 'Button',
              label: 'Save',
              identifier: 'save-action',
              rect: duplicateRect,
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  await port.execute({
    command: {
      kind: 'tapOn',
      source: { line: 2 },
      target: { space: 'target', selector: { text: 'Save' } },
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'click']);
  expect(
    requests.filter(({ command }) => command === 'click').map(({ positionals }) => positionals),
  ).toEqual([['106', '322']]);
});

test('does not atomically dispatch distinct iOS matches with identical frames', async () => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  const duplicateRect = { x: 16, y: 298, width: 180, height: 48 };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      snapshots += 1;
      return {
        ok: true,
        data: {
          createdAt: snapshots,
          nodes: [
            { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 393, height: 852 } },
            { index: 1, parentIndex: 0, type: 'Button', label: 'Save', rect: duplicateRect },
            { index: 2, parentIndex: 0, type: 'Button', label: 'Save', rect: duplicateRect },
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  await port.execute({
    command: {
      kind: 'tapOn',
      source: { line: 2 },
      target: { space: 'target', selector: { text: 'Save' } },
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'click']);
  expect(
    requests.filter(({ command }) => command === 'click').map(({ positionals }) => positionals),
  ).toEqual([['106', '322']]);
});
