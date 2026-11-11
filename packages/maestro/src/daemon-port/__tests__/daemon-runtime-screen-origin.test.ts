import { expect, test } from 'vitest';
import { attachSnapshotViewportEvidence } from '@agent-device/contracts/capture';
import type { MaestroSelector } from '@agent-device/maestro';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import type { MaestroDaemonOperationRequest } from '../daemon-runtime-public-operation.ts';
import {
  makeDependencies,
  makeRuntimeEnvelope,
  makeSnapshot,
} from './daemon-runtime-port-fixtures.ts';

function geometrySnapshot(kind: 'reported' | 'derived') {
  const rect = { x: 0, y: 0, width: 551, height: 813 };
  const snapshot = makeSnapshot([
    { index: 0, type: 'Application', rect },
    { index: 1, parentIndex: 0, type: 'Other', identifier: 'container', rect },
    {
      index: 2,
      parentIndex: 1,
      type: 'Button',
      identifier: 'geometry-action',
      label: 'Geometry action',
      rect: { x: 240, y: 90, width: 220, height: 42 },
      hittable: true,
    },
  ]);
  attachSnapshotViewportEvidence(snapshot.nodes, { kind, rect });
  return snapshot;
}

const selectors: MaestroSelector[] = [
  { id: 'geometry-action', index: 0 },
  { id: 'geometry-action', text: 'Geometry action' },
  { id: 'geometry-action', childOf: { id: 'container' } },
];

test.each(selectors)(
  'selector-derived Maestro coordinates refuse unknown origin: %j',
  async (selector) => {
    const requests: MaestroDaemonOperationRequest[] = [];
    const snapshot = geometrySnapshot('derived');
    const port = createDaemonMaestroRuntimePort({
      ...makeRuntimeEnvelope({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
      platform: 'ios',
      dependencies: makeDependencies(),
      invoke: async (request) => {
        requests.push(request);
        return { ok: true, data: request.command === 'snapshot' ? snapshot : {} };
      },
    });
    await expect(
      port.execute({
        command: { kind: 'tapOn', source: { line: 2 }, target: { space: 'target', selector } },
        generation: 0,
        env: {},
        invalidateObservation() {},
      }),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: {
        reason: 'window-origin-unknown',
        dispatched: 'no',
      },
    });
    expect(requests.map(({ command }) => command)).toEqual(['snapshot']);
  },
);

test.each(selectors)(
  'the same Maestro selector activates reported screen geometry: %j',
  async (selector) => {
    const requests: MaestroDaemonOperationRequest[] = [];
    const snapshot = geometrySnapshot('reported');
    const port = createDaemonMaestroRuntimePort({
      ...makeRuntimeEnvelope({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
      platform: 'ios',
      dependencies: makeDependencies(),
      invoke: async (request) => {
        requests.push(request);
        return { ok: true, data: request.command === 'snapshot' ? snapshot : {} };
      },
    });
    await port.execute({
      command: { kind: 'tapOn', source: { line: 2 }, target: { space: 'target', selector } },
      generation: 0,
      env: {},
      invalidateObservation() {},
    });
    expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'click']);
    expect(requests[1]?.positionals).toEqual(['350', '111']);
  },
);

test('an atomic selector miss cannot fall back to coordinates from a newly unanchored capture', async () => {
  const requests: MaestroDaemonOperationRequest[] = [];
  let captures = 0;
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    platform: 'ios',
    dependencies: makeDependencies(),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'snapshot') {
        return { ok: true, data: geometrySnapshot(++captures === 1 ? 'reported' : 'derived') };
      }
      return { ok: false, error: { code: 'ELEMENT_NOT_FOUND', message: 'native selector miss' } };
    },
  });
  await expect(
    port.execute({
      command: {
        kind: 'tapOn',
        source: { line: 2 },
        target: { space: 'target', selector: { id: 'geometry-action' } },
      },
      generation: 0,
      env: {},
      invalidateObservation() {},
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      reason: 'window-origin-unknown',
      dispatched: 'no',
    },
  });
  expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'click', 'snapshot']);
  expect(requests[1]?.positionals).toEqual(['id="geometry-action"']);
});

test('Maestro read-only observation of unanchored nodes remains available', async () => {
  const snapshot = geometrySnapshot('derived');
  const requests: MaestroDaemonOperationRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    platform: 'ios',
    dependencies: makeDependencies(),
    invoke: async (request) => {
      requests.push(request);
      return { ok: true, data: snapshot };
    },
  });
  await expect(
    port.observe({
      condition: { kind: 'visible', selector: { id: 'geometry-action' } },
      timeoutMs: 0,
      generation: 0,
      env: {},
    }),
  ).resolves.toMatchObject({ matched: true });
  expect(requests.map(({ command }) => command)).toEqual(['snapshot']);
});

test('Maestro authored absolute points do not consume snapshot geometry', async () => {
  const requests: MaestroDaemonOperationRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    platform: 'ios',
    dependencies: makeDependencies(),
    invoke: async (request) => {
      requests.push(request);
      return { ok: true, data: {} };
    },
  });
  await port.execute({
    command: { kind: 'tapOn', source: { line: 2 }, target: { space: 'absolute', x: 591, y: 335 } },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });
  expect(requests.map(({ command }) => command)).toEqual(['click']);
  expect(requests[0]?.positionals).toEqual(['591', '335']);
});

test('Maestro scrollUntilVisible refuses a gesture derived from an unanchored container', async () => {
  const snapshot = geometrySnapshot('derived');
  snapshot.nodes[1] = { ...snapshot.nodes[1]!, type: 'ScrollView' };
  const requests: MaestroDaemonOperationRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    platform: 'ios',
    dependencies: makeDependencies(),
    invoke: async (request) => {
      requests.push(request);
      return { ok: true, data: snapshot };
    },
  });
  await expect(
    port.execute({
      command: {
        kind: 'scrollUntilVisible',
        source: { line: 2 },
        element: { id: 'not-visible-yet' },
        direction: 'down',
        timeout: 2_000,
      },
      generation: 0,
      env: {},
      invalidateObservation() {},
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      reason: 'window-origin-unknown',
      dispatched: 'no',
    },
  });
  expect(requests.map(({ command }) => command)).toEqual(['snapshot']);
});
