import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { expect, test, vi } from 'vitest';
import {
  type DeviceBinding,
  type RuntimeFacts,
  type RuntimeOperationFact,
  localRuntimeOwner,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import {
  type PlatformRuntimeOperations,
  typeTextRuntimeUse,
} from '@agent-device/contracts/platform-runtime-operations';
import {
  type TypeTextInput,
  typeTextRuntimeOperationFacts,
} from '@agent-device/contracts/type-text-runtime';
import { deviceShape } from '@agent-device/kernel/device';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../core/request-runtime-binding.ts';
import { parseTypeTextRequest, resolveBoundTypeTextRuntime } from '../type-text-runtime.ts';
import { expectRefusesUnavailableExactOwnerFact } from '../../__tests__/support/runtime-binding-conformance.ts';

const appleDevice = {
  id: 'ios-simulator',
  name: 'iPhone',
  platform: 'apple',
  appleOs: 'ios',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
} as const;
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind' as const,
  hint: 'type is supported on Apple simulators and physical devices.',
});

function runtimeHarness(fact: RuntimeOperationFact = available) {
  const typeText = vi.fn(
    async (_input: TypeTextInput) => ({ textEntryRoute: 'synthesized-first-responder' }) as const,
  );
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(appleDevice), providerMode: 'local' },
    operations: { typeText: fact } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device: appleDevice,
    owner: localRuntimeOwner('apple'),
    facts,
    operations: { typeText },
    [Symbol.asyncDispose]: async () => {},
  } satisfies DeviceBinding<PlatformRuntimeOperations>;
  const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async () => facts);
  const bindDevice = vi.fn(async (_device, use) =>
    narrowDeviceBinding(binding, use),
  ) as unknown as BindDeviceRuntime;
  return { typeText, inspectFacts, bindDevice };
}

test('resolves one admitted binding and reproduces the retired leaf result exactly', async () => {
  const harness = runtimeHarness(typeTextRuntimeOperationFacts({ type: available }).typeText);

  const resolved = await resolveBoundTypeTextRuntime({
    platformServices: daemonPlatformServicesFixture(),
    device: appleDevice,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledWith(appleDevice, typeTextRuntimeUse);
  const result = await resolved.typeText(
    { text: 'hello world', delayMs: 25 },
    {
      appBundleId: 'com.example.app',
      requestId: 'type-context',
      logPath: '/tmp/session.log',
    },
  );

  // The retired leaf's exact composition: route evidence, text, delay, and the char-count
  // message — nothing else from the owner's result survives.
  expect(result).toEqual({
    textEntryRoute: 'synthesized-first-responder',
    text: 'hello world',
    delayMs: 25,
    message: 'Typed 11 chars',
  });
  expect(harness.typeText).toHaveBeenCalledWith(
    expect.objectContaining({
      text: 'hello world',
      delayMs: 25,
      options: { appBundleId: 'com.example.app' },
      execution: expect.objectContaining({
        requestId: 'type-context',
        logPath: '/tmp/session.log',
      }),
    }),
  );
});

test('omits textEntryRoute when the owner types blind, exactly as the leaf did', async () => {
  const harness = runtimeHarness();
  harness.typeText.mockResolvedValueOnce(undefined as never);

  const resolved = await resolveBoundTypeTextRuntime({
    platformServices: daemonPlatformServicesFixture(),
    device: appleDevice,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  const result = await resolved.typeText({ text: 'hi', delayMs: 0 }, {});

  expect('textEntryRoute' in result).toBe(false);
  expect(result).toEqual({ text: 'hi', delayMs: 0, message: 'Typed 2 chars' });
});

test('parse rejects a leading snapshot ref, empty text, and an out-of-range delay', () => {
  const rejectRef = { rejectRefTarget: true };
  // A leading target ref is a mistargeted fill; the hint names the ref to fill instead.
  for (const ref of ['@e5', '@e5~s2']) {
    expect(() => parseTypeTextRequest([ref, 'hello'], {}, rejectRef)).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        message: `type does not accept a target ref like "${ref}"`,
        details: {
          hint: `Use fill ${ref} "text" to target that field, or press ${ref} then type "text" to append.`,
        },
      }),
    );
  }
  expect(() => parseTypeTextRequest([], {}, rejectRef)).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'type requires text' }),
  );
  expect(() => parseTypeTextRequest(['hi'], { delayMs: 10_001 }, rejectRef)).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS' }),
  );
});

test('parse types handles and words that only resemble a ref', () => {
  const rejectRef = { rejectRefTarget: true };
  for (const text of ['@elena hi', '@eleven', '@nodejs', '@refund', '@john99', '@e', '@e5x']) {
    expect(parseTypeTextRequest([text], {}, rejectRef)).toEqual({ text, delayMs: 0 });
  }
  // find's type leg always carries text, so even a real ref token is typed verbatim.
  expect(parseTypeTextRequest(['@e5 hi'], {}, { rejectRefTarget: false })).toEqual({
    text: '@e5 hi',
    delayMs: 0,
  });
  // Multiple positionals join with spaces: the wire shape find's leg and batch both rely on.
  expect(parseTypeTextRequest(['hello', 'world'], {}, rejectRef).text).toBe('hello world');
});

test('rejects an unavailable exact-owner fact before binding, with the owner hint', async () => {
  await expectRefusesUnavailableExactOwnerFact({
    command: 'type',
    device: appleDevice,
    unavailable,
  });
});
