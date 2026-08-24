import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { TapPointInput } from '@agent-device/contracts/touch-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createInteractionRetryTap } from '../interaction-retry-tap.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { unavailableDeviceRuntimeGateway } from './test-device-runtime-gateway.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

/** One owner cell, parametrized on whether it can tap — the only fact this adapter reads. */
function bindings(
  canTap: boolean,
  taps: TapPointInput[],
): Readonly<{ inspectFacts: InspectDeviceRuntimeFacts; bindDevice: BindDeviceRuntime }> {
  const facts = async () => {
    const base = await unavailableDeviceRuntimeGateway.inspectFacts(device);
    return Object.freeze({
      device: base.device,
      operations: {
        ...base.operations,
        tapPoint: canTap
          ? ({ available: true } as const)
          : ({ available: false, reason: 'owner-capability-missing' } as const),
      },
    });
  };
  const inspectFacts: InspectDeviceRuntimeFacts = async () => await facts();
  const bindDevice: BindDeviceRuntime = (async (target: DeviceInfo, use) => {
    const binding: DeviceBinding<PlatformRuntimeOperations> = Object.freeze({
      device: target,
      owner: localRuntimeOwner('android'),
      facts: await facts(),
      operations: Object.freeze(
        canTap
          ? {
              tapPoint: async (input: TapPointInput) => {
                taps.push(input);
                return {};
              },
            }
          : {},
      ),
      [Symbol.asyncDispose]: async () => undefined,
    }) as DeviceBinding<PlatformRuntimeOperations>;
    return narrowDeviceBinding(binding, use);
  }) as BindDeviceRuntime;
  return { inspectFacts, bindDevice };
}

test('a capture route with no runtime bindings has no retry seam to hand the policy', () => {
  assert.equal(createInteractionRetryTap({}), undefined);
  assert.equal(createInteractionRetryTap({ inspectFacts: async () => ({}) as never }), undefined);
});

test('the seam re-fires the recorded point through the owner-bound tapPoint', async () => {
  const taps: TapPointInput[] = [];
  const retryTap = createInteractionRetryTap(bindings(true, taps));
  assert.ok(retryTap);

  const fired = await retryTap({
    device,
    point: { x: 100, y: 200 },
    context: { logPath: '/tmp/daemon.log', requestId: 'retry-1' },
  });

  assert.equal(fired, true);
  assert.equal(taps.length, 1);
  assert.deepEqual(taps[0]?.point, { x: 100, y: 200 });
});

// ADR 0019 §9 is one admission per handler, and the outcome policy calls this seam once per retry
// round. The binding underneath is request-cached, so what memoization saves is the repeated facts
// inspection — and what it pins is that the seam admits once, not once per round.
test('the seam admits once no matter how many rounds the policy runs', async () => {
  const taps: TapPointInput[] = [];
  const admission = bindings(true, taps);
  let inspections = 0;
  const retryTap = createInteractionRetryTap({
    inspectFacts: async (target) => {
      inspections += 1;
      return await admission.inspectFacts(target);
    },
    bindDevice: admission.bindDevice,
  });
  assert.ok(retryTap);

  const context = { logPath: '/tmp/daemon.log', requestId: 'retry-1' };
  await retryTap({ device, point: { x: 10, y: 20 }, context });
  await retryTap({ device, point: { x: 30, y: 40 }, context });

  assert.equal(inspections, 1);
  assert.equal(taps.length, 2);
  assert.deepEqual(
    taps.map((tap) => tap.point),
    [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ],
  );
});

// The policy spends an attempt only on a delivered tap, so a cell that cannot tap must answer
// `false` here rather than throwing out of the capture the retry was decorating.
test('an owner cell that cannot tap answers false instead of throwing', async () => {
  const taps: TapPointInput[] = [];
  const retryTap = createInteractionRetryTap(bindings(false, taps));
  assert.ok(retryTap);

  const fired = await retryTap({
    device,
    point: { x: 100, y: 200 },
    context: { logPath: '/tmp/daemon.log' },
  });

  assert.equal(fired, false);
  assert.equal(taps.length, 0);
});
