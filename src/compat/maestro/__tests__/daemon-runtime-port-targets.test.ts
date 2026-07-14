import { expect, test } from 'vitest';
import type { DaemonInvokeFn, DaemonRequest } from '../../../daemon/types.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import { makeBaseRequest, makeDependencies } from './daemon-runtime-port-fixtures.ts';

test('waits for a delayed input target using fresh snapshots', async () => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  const invoke: DaemonInvokeFn = async (request) => {
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
          ...(snapshots < 3
            ? []
            : [
                {
                  index: 1,
                  parentIndex: 0,
                  type: 'Button',
                  identifier: 'delayedButton',
                  rect: { x: 20, y: 40, width: 120, height: 44 },
                },
              ]),
        ],
      },
    };
  };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke,
    dependencies: makeDependencies(),
    platform: 'android',
  });

  await expect(
    port.execute({
      command: {
        kind: 'tapOn',
        source: { line: 2 },
        target: { space: 'target', selector: { id: 'delayedButton' } },
      },
      generation: 0,
      env: {},
      invalidateObservation() {},
    }),
  ).resolves.toEqual({});
  expect(requests.map((request) => request.command)).toEqual([
    'snapshot',
    'snapshot',
    'snapshot',
    'click',
  ]);
  expect(requests.at(-1)?.positionals).toEqual(['80', '62']);
});

test('atomically dispatches a unique exact iOS target from same-generation evidence', async () => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  const invoke: DaemonInvokeFn = async (request) => {
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
            type: 'Text',
            identifier: 'ready',
            rect: { x: 20, y: 40, width: 120, height: 44 },
          },
          {
            index: 2,
            parentIndex: 0,
            type: 'Button',
            identifier: 'continue',
            rect: { x: snapshots === 1 ? 20 : 160, y: 100, width: 120, height: 44 },
          },
        ],
      },
    };
  };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke,
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  const observation = await port.observe({
    condition: { kind: 'visible', selector: { id: 'ready' } },
    timeoutMs: 0,
    generation: 0,
    env: {},
  });
  await expect(
    port.execute({
      command: {
        kind: 'tapOn',
        source: { line: 2 },
        target: { space: 'target', selector: { id: 'continue' } },
      },
      generation: 0,
      cachedObservation: { ...observation },
      env: {},
      invalidateObservation() {},
    }),
  ).resolves.toEqual({});

  expect(requests.map((request) => request.command)).toEqual(['snapshot', 'click']);
  expect(observation.identity).toBeDefined();
  expect(requests.at(-1)?.positionals).toEqual(['id="continue"']);
  expect(requests.at(-1)?.flags?.maestro).toBeUndefined();
});

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
  expect(requests[1]?.positionals).toEqual(['106', '322']);
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
  expect(requests[1]?.positionals).toEqual(['106', '322']);
});

test('falls back to fresh Maestro geometry when atomic iOS dispatch resolves off-screen', async () => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  let clicks = 0;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'click') {
        clicks += 1;
        return clicks === 1
          ? {
              ok: false,
              error: {
                code: 'ELEMENT_OFFSCREEN',
                message: 'element resolved off-screen during dispatch',
              },
            }
          : { ok: true, data: {} };
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
              type: 'Text',
              identifier: 'ready',
              rect: { x: 20, y: 40, width: 120, height: 44 },
            },
            {
              index: 2,
              parentIndex: 0,
              type: 'Button',
              identifier: 'continue',
              rect: { x: snapshots === 1 ? 20 : 160, y: 100, width: 120, height: 44 },
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
    command: {
      kind: 'tapOn',
      source: { line: 2 },
      target: { space: 'target', selector: { id: 'continue' } },
    },
    generation: 0,
    cachedObservation: observation,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map((request) => request.command)).toEqual([
    'snapshot',
    'click',
    'snapshot',
    'click',
  ]);
  expect(requests.at(-1)?.positionals).toEqual(['220', '122']);
});

test.each(['ios', 'android'] as const)(
  'refreshes filtered %s target geometry instead of reusing an observation rectangle',
  async (platform) => {
    const requests: DaemonRequest[] = [];
    let snapshots = 0;
    const port = createDaemonMaestroRuntimePort({
      baseReq: makeBaseRequest({ flags: { platform, replayBackend: 'maestro' } }),
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
                type: 'Text',
                identifier: 'ready',
                rect: { x: 20, y: 40, width: 120, height: 44 },
              },
              {
                index: 2,
                parentIndex: 0,
                type: 'Button',
                identifier: 'continue',
                enabled: true,
                rect: { x: snapshots === 1 ? 20 : 160, y: 100, width: 120, height: 44 },
              },
            ],
          },
        };
      },
      dependencies: makeDependencies(),
      platform,
    });

    const observation = await port.observe({
      condition: { kind: 'visible', selector: { id: 'ready' } },
      timeoutMs: 0,
      generation: 0,
      env: {},
    });
    await port.execute({
      command: {
        kind: 'tapOn',
        source: { line: 2 },
        target: { space: 'target', selector: { id: 'continue', enabled: true } },
      },
      generation: 0,
      cachedObservation: observation,
      env: {},
      invalidateObservation() {},
    });

    expect(requests.map((request) => request.command)).toEqual(['snapshot', 'snapshot', 'click']);
    expect(requests.at(-1)?.positionals).toEqual(['220', '122']);
  },
);

test('captures fresh target state immediately after a same-generation observation', async () => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  const invoke: DaemonInvokeFn = async (request) => {
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
            type: 'Text',
            identifier: 'ready',
            rect: { x: 20, y: 40, width: 120, height: 44 },
          },
          ...(snapshots === 1
            ? []
            : [
                {
                  index: 2,
                  parentIndex: 0,
                  type: 'Button',
                  identifier: 'continue',
                  rect: { x: 20, y: 100, width: 120, height: 44 },
                },
              ]),
        ],
      },
    };
  };
  const now = { value: 0 };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke,
    dependencies: makeDependencies(now),
    platform: 'ios',
  });

  const observation = await port.observe({
    condition: { kind: 'visible', selector: { id: 'ready' } },
    timeoutMs: 0,
    generation: 0,
    env: {},
  });
  await port.execute({
    command: {
      kind: 'tapOn',
      source: { line: 2 },
      target: { space: 'target', selector: { id: 'continue' } },
    },
    generation: 0,
    cachedObservation: observation,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map((request) => request.command)).toEqual(['snapshot', 'snapshot', 'click']);
  expect(now.value).toBe(0);
});
