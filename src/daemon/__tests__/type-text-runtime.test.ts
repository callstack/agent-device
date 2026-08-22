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
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { resolveBoundTypeTextRuntime } from '../type-text-runtime.ts';

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
    device: appleDevice,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledWith(appleDevice, typeTextRuntimeUse);
  const result = await resolved.typeText(['hello world'], {
    delayMs: 25,
    appBundleId: 'com.example.app',
    requestId: 'type-context',
    logPath: '/tmp/session.log',
  });

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
    device: appleDevice,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  const result = await resolved.typeText(['hi'], {});

  expect('textEntryRoute' in result).toBe(false);
  expect(result).toEqual({ text: 'hi', delayMs: 0, message: 'Typed 2 chars' });
});

test('parses exactly as the retired leaf did: refs rejected, spaces joined, delay bounded', async () => {
  const harness = runtimeHarness();
  const resolved = await resolveBoundTypeTextRuntime({
    device: appleDevice,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;

  // A leading target ref is a mistargeted fill, with the same hint text the leaf raised.
  await expect(resolved.typeText(['@e5', 'hello'], {})).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    message: 'type does not accept a target ref like "@e5"',
    details: {
      hint: 'Use fill @e5 "text" to target that field, or press @e5 then type "text" to append.',
    },
  });
  // Empty text is refused after the ref check, not before.
  await expect(resolved.typeText([], {})).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    message: 'type requires text',
  });
  // The 0-10000 delay bound survives the migration.
  await expect(resolved.typeText(['hi'], { delayMs: 10_001 })).rejects.toMatchObject({
    code: 'INVALID_ARGS',
  });
  // Multiple positionals join with spaces — the wire shape find's leg and batch both rely on.
  await resolved.typeText(['hello', 'world'], {});
  expect(harness.typeText).toHaveBeenLastCalledWith(
    expect.objectContaining({ text: 'hello world' }),
  );
});

test('rejects an unavailable exact-owner fact before binding, with the owner hint', async () => {
  const harness = runtimeHarness(unavailable);

  const resolved = await resolveBoundTypeTextRuntime({
    device: appleDevice,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved).toEqual({
    ok: false,
    response: {
      ok: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'type is not supported on this device',
        hint: unavailable.hint,
      },
    },
  });
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).not.toHaveBeenCalled();
});
