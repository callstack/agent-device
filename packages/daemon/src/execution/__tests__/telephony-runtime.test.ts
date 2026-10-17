import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { expect, test, vi } from 'vitest';

import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type RuntimeFacts,
  type RuntimeOperationFact,
} from '@agent-device/contracts/platform-runtime';
import {
  telephonyRuntimeUse,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import { makeSession } from '../../__tests__/support/session-factories.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../core/request-runtime-binding.ts';
import type { GenericPlatformExecutionParams } from '../../core/generic-leaf-execution.ts';
import { resolveBoundTelephonyRuntime } from '../telephony-runtime.ts';
import { expectRefusesUnavailableExactOwnerFact } from '../../__tests__/support/runtime-binding-conformance.ts';

// File-scoped id: this owner binding's `local-family` kind reaches the real on-disk device-claim
// admission, so a shared id risks a cross-file claim collision under parallel execution.
const testDevice = {
  id: 'telephony-runtime-device',
  name: 'Pixel',
  platform: 'android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
} as const satisfies DeviceInfo;
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind' as const,
});

function telephonyExecutionParams(positionals: string[]): GenericPlatformExecutionParams {
  const session = makeSession('telephony-runtime', { device: testDevice });
  return {
    session,
    sessionName: session.name,
    logPath: '/tmp/daemon.log',
    command: 'telephony',
    request: { command: 'telephony', positionals, token: 't', session: session.name },
    positionals,
    out: undefined,
    dispatchContext: {},
  };
}

function runtimeHarness(fact: RuntimeOperationFact = available) {
  const sendTelephonyEvent = vi.fn(async () => {});
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(testDevice), providerMode: 'local' },
    operations: {
      sendTelephonyEvent: fact,
    } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device: testDevice,
    owner: localRuntimeOwner('android'),
    facts,
    operations: { sendTelephonyEvent },
    [Symbol.asyncDispose]: async () => {},
  } satisfies DeviceBinding<PlatformRuntimeOperations>;
  const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async () => facts);
  const bindDevice = vi.fn(async (_device, use) =>
    narrowDeviceBinding(binding, use),
  ) as unknown as BindDeviceRuntime;
  return { sendTelephonyEvent, inspectFacts, bindDevice };
}

async function runTelephony(positionals: string[], harness = runtimeHarness()) {
  const resolved = await resolveBoundTelephonyRuntime({
    platformServices: daemonPlatformServicesFixture(),
    device: testDevice,
    positionals,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  if (!resolved.ok) throw new Error('telephony was not admitted');
  return await resolved.execute(telephonyExecutionParams(positionals));
}

test.each([
  [['call', '5551234'], { action: 'call', number: '5551234' }, 'Simulated an incoming call'],
  [['accept', '5551234'], { action: 'accept', number: '5551234' }, 'Accepted the call'],
  [['cancel', '5551234'], { action: 'cancel', number: '5551234' }, 'Ended the call'],
] as const)('%o sends %o to the admitted owner', async (positionals, input, message) => {
  const harness = runtimeHarness();
  expect(await runTelephony([...positionals], harness)).toEqual({
    ...input,
    message: `${message} from 5551234`,
  });
  expect(harness.bindDevice).toHaveBeenCalledWith(testDevice, telephonyRuntimeUse);
  expect(harness.sendTelephonyEvent).toHaveBeenCalledExactlyOnceWith(input);
});

test('sms joins the words after the number into one message and reports its length', async () => {
  const harness = runtimeHarness();
  expect(await runTelephony(['sms', '+15551234567', 'Your', 'code', 'is 42'], harness)).toEqual({
    action: 'sms',
    number: '+15551234567',
    textLength: 'Your code is 42'.length,
    message: 'Simulated an incoming SMS from +15551234567',
  });
  expect(harness.sendTelephonyEvent).toHaveBeenCalledWith({
    action: 'sms',
    number: '+15551234567',
    text: 'Your code is 42',
  });
});

test.each([
  [[], 'telephony requires an action'],
  [['ring', '5551234'], 'Invalid telephony action'],
  [['call'], 'telephony call requires a phone number'],
  [['call', '555-1234'], 'Invalid phone number'],
  [['call', '5551234', 'extra'], 'takes only a phone number'],
  [['sms', '5551234'], 'telephony sms requires message text'],
  [['sms', '5551234', 'tab\there'], 'must not contain control characters'],
])('refuses %o before inspection or binding', async (positionals, message) => {
  const harness = runtimeHarness();
  await expect(
    resolveBoundTelephonyRuntime({
      platformServices: daemonPlatformServicesFixture(),
      device: testDevice,
      positionals,
      inspectFacts: harness.inspectFacts,
      bindDevice: harness.bindDevice,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining(message) });
  expect(harness.inspectFacts).not.toHaveBeenCalled();
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

test('rejects an unavailable exact-owner fact before binding', async () => {
  await expectRefusesUnavailableExactOwnerFact({
    command: 'telephony',
    device: testDevice,
    unavailable,
  });
});
