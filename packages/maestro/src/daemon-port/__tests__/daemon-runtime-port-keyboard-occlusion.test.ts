import { expect, test } from 'vitest';
import {
  executeMaestroFlow,
  inspectMaestroFlow,
  type MaestroSelector,
} from '@agent-device/maestro';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import type { MaestroDaemonOperationRequest } from '../daemon-runtime-public-operation.ts';
import {
  makeDependencies,
  makeRuntimeEnvelope,
  makeSnapshot,
  noMaestroIncludeSources,
} from './daemon-runtime-port-fixtures.ts';

const keyboardFrame = { x: 0, y: 590, width: 402, height: 284 };
const pickup = { id: 'shipping-pickup' };
const returnKey = { id: 'Return' };

function checkoutSnapshot(targetY: number, keyboardOwned: boolean) {
  const snapshot = makeSnapshot([
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: keyboardOwned ? returnKey.id : pickup.id,
      enabled: true,
      rect: { x: 110, y: targetY, width: 108, height: 44 },
      ...(keyboardOwned ? { keyboardOwned } : {}),
    },
  ]);
  snapshot.keyboard = { kind: 'visible', frame: keyboardFrame };
  return snapshot;
}

function checkoutTap(selector: MaestroSelector, targetPositions: number[], keyboardOwned = false) {
  const requests: MaestroDaemonOperationRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    platform: 'ios',
    dependencies: makeDependencies(),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'snapshot') {
        return { ok: true, data: checkoutSnapshot(targetPositions.shift()!, keyboardOwned) };
      }
      if (targetPositions.length > 0) {
        return { ok: false, error: { code: 'ELEMENT_NOT_FOUND', message: 'native selector miss' } };
      }
      return { ok: true, data: {} };
    },
  });
  return {
    requests,
    runFlow: (source: string) =>
      executeMaestroFlow(inspectMaestroFlow(source, '/flows/checkout.yaml'), port, {
        readSource: noMaestroIncludeSources,
      }),
    tap: () =>
      port.execute({
        command: { kind: 'tapOn', source: { line: 2 }, target: { space: 'target', selector } },
        generation: 0,
        env: {},
        invalidateObservation() {},
      }),
  };
}

const keyboardRefusal = {
  code: 'COMMAND_FAILED',
  details: { reason: 'tap_keyboard_occludes_target', dispatched: 'no', keyboardFrame },
};

test.each([pickup, { ...pickup, enabled: true }])(
  'refuses a keyboard-covered iOS tapOn before selector or point dispatch: %j',
  async (selector) => {
    const { requests, tap } = checkoutTap(selector, [629]);
    await expect(tap()).rejects.toMatchObject(keyboardRefusal);
    expect(requests.map(({ command }) => command)).toEqual(['snapshot']);
  },
);

test('taps iOS Pickup when its point is above the keyboard', async () => {
  const { requests, tap } = checkoutTap(pickup, [550]);
  await tap();
  expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'click']);
  expect(requests[1]?.positionals).toEqual(['id="shipping-pickup"']);
});

test('an atomic selector miss cannot fall back to a newly keyboard-covered point', async () => {
  const { requests, tap } = checkoutTap(pickup, [550, 629]);
  await expect(tap()).rejects.toMatchObject(keyboardRefusal);
  expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'click', 'snapshot']);
});

test('an optional keyboard-covered tapOn warns and continues to the next tap', async () => {
  const { requests, runFlow } = checkoutTap(pickup, [629, 550]);
  const result = await runFlow(
    '---\n- tapOn: {id: shipping-pickup, optional: true}\n- tapOn: {id: shipping-pickup}\n',
  );
  expect(result).toMatchObject({
    ok: true,
    warnings: [
      expect.stringMatching(/Optional Maestro tapOn skipped.*tap_keyboard_occludes_target/),
    ],
  });
  expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'snapshot', 'click']);
});

test('a required keyboard-covered tapOn fails the flow with the typed refusal', async () => {
  const { requests, runFlow } = checkoutTap(pickup, [629, 550]);
  const result = await runFlow(
    '---\n- tapOn: {id: shipping-pickup}\n- tapOn: {id: shipping-pickup}\n',
  );

  expect(result).toMatchObject({ ok: false, error: keyboardRefusal });
  expect(requests.map(({ command }) => command)).toEqual(['snapshot']);
});

test('assertVisible then tapOn refuses a covered point from the reused observation', async () => {
  const { requests, runFlow } = checkoutTap(pickup, [629]);
  const result = await runFlow(
    '---\n- assertVisible: {id: shipping-pickup}\n- tapOn: {id: shipping-pickup}\n',
  );

  expect(result).toMatchObject({
    ok: false,
    error: keyboardRefusal,
    failure: { action: 'tapOn', source: { line: 3 } },
  });
  expect(requests.map(({ command }) => command)).toEqual(['snapshot']);
});

test('tapOn can dispatch to a keyboard-owned control inside the keyboard frame', async () => {
  const { requests, tap } = checkoutTap(returnKey, [629], true);
  await tap();

  expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'click']);
  expect(requests[1]?.positionals).toEqual(['id="Return"']);
});

test('an explicit retry can resolve a fresh target after a keyboard refusal', async () => {
  const { requests, runFlow } = checkoutTap(pickup, [629, 550]);
  const result = await runFlow(
    '---\n- retry:\n    maxRetries: 1\n    commands:\n      - tapOn: {id: shipping-pickup}\n',
  );

  expect(result).toMatchObject({ ok: true });
  expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'snapshot', 'click']);
});
