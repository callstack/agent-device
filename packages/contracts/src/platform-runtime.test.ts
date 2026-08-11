import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
  runtimeOwnerKey,
  sameRuntimeOwner,
  type BoundDeviceRuntime,
  type DeviceBinding,
} from './platform-runtime.ts';
import { runtimeUse } from './platform-runtime-use.ts';

type TestOperations = {
  inspect: (input: Readonly<{ depth: number }>) => Promise<Readonly<{ nodes: number }>>;
  inspectFast: () => Promise<Readonly<{ nodes: number }>>;
  mutate: (input: Readonly<{ value: string }>) => Promise<void>;
};

const inspectUse = runtimeUse<TestOperations>()({
  required: ['inspect'],
  preferred: ['inspectFast'],
});

function compileTimeNarrowingProof(runtime: BoundDeviceRuntime<typeof inspectUse>): void {
  const required: TestOperations['inspect'] = runtime.operations.inspect;
  const preferred: TestOperations['inspectFast'] | undefined = runtime.operations.inspectFast;
  void required;
  void preferred;

  // @ts-expect-error An undeclared sibling operation cannot cross the selected projection.
  void runtime.operations.mutate;
  // @ts-expect-error The selected runtime is intentionally not disposable by a handler.
  void runtime[Symbol.asyncDispose];
}
void compileTimeNarrowingProof;

function compileTimeDisjointProof(): void {
  // @ts-expect-error Required and preferred keys are statically disjoint.
  runtimeUse<TestOperations>()({ required: ['inspect'], preferred: ['inspect'] });
}
void compileTimeDisjointProof;

test('runtime use freezes declarations and rejects dynamic overlap or duplicates', () => {
  assert.deepEqual(inspectUse, {
    required: ['inspect'],
    preferred: ['inspectFast'],
  });
  assert.ok(Object.isFrozen(inspectUse));
  assert.ok(Object.isFrozen(inspectUse.required));
  assert.ok(Object.isFrozen(inspectUse.preferred));

  const dynamic = runtimeUse<TestOperations>();
  assert.throws(
    () =>
      dynamic({
        required: ['inspect'],
        preferred: ['inspect'] as unknown as readonly ['inspectFast'],
      }),
    /both required and preferred/,
  );
  assert.throws(
    () =>
      dynamic({
        required: ['inspect', 'inspect'] as const,
      }),
    /duplicate required/,
  );
});

test('runtime owner keys distinguish local families and configured provider instances', () => {
  assert.equal(runtimeOwnerKey(localRuntimeOwner('apple')), 'local:apple');
  assert.notEqual(
    runtimeOwnerKey(providerRuntimeOwner('webdriver', 'tenant-a')),
    runtimeOwnerKey(providerRuntimeOwner('webdriver', 'tenant-b')),
  );
  assert.throws(() => providerRuntimeOwner('webdriver', '  '), /non-empty/);
  assert.notEqual(
    runtimeOwnerKey(providerRuntimeOwner('a:b', 'c')),
    runtimeOwnerKey(providerRuntimeOwner('a', 'b:c')),
  );
  assert.equal(
    sameRuntimeOwner(
      providerRuntimeOwner('webdriver', 'tenant-a'),
      providerRuntimeOwner('webdriver', 'tenant-a'),
    ),
    true,
  );
});

test('binding narrowing proves required operations and omits unavailable preferred operations', () => {
  const binding = testBinding({
    inspect: { available: true },
    inspectFast: { available: false, reason: 'owner-capability-missing' },
    mutate: { available: true },
  });
  const runtime = narrowDeviceBinding(binding, inspectUse);

  assert.equal(runtime.operations.inspect, binding.operations.inspect);
  assert.equal(runtime.operations.inspectFast, undefined);
  assert.deepEqual(runtime.facts.inspectFast, {
    available: false,
    reason: 'owner-capability-missing',
  });
  assert.equal('mutate' in runtime.operations, false);
});

test('binding narrowing fails closed on unsupported or falsely advertised required operations', () => {
  const unsupported = testBinding({
    inspect: { available: false, reason: 'unsupported-device-kind' },
    inspectFast: { available: false, reason: 'owner-capability-missing' },
    mutate: { available: true },
  });
  assert.throws(
    () => narrowDeviceBinding(unsupported, inspectUse),
    (error) => error instanceof AppError && error.code === 'UNSUPPORTED_OPERATION',
  );

  const missing = testBinding({
    inspect: { available: true },
    inspectFast: { available: false, reason: 'owner-capability-missing' },
    mutate: { available: true },
  });
  delete (missing.operations as Partial<TestOperations>).inspect;
  assert.throws(
    () => narrowDeviceBinding(missing, inspectUse),
    (error) => error instanceof AppError && error.details?.reason === 'runtime-contract-invalid',
  );
});

function testBinding(
  facts: DeviceBinding<TestOperations>['facts']['operations'],
): DeviceBinding<TestOperations> {
  return {
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    },
    owner: localRuntimeOwner('android'),
    facts: {
      device: { family: 'android', kind: 'emulator', providerMode: 'local' },
      operations: facts,
    },
    operations: {
      inspect: async () => ({ nodes: 1 }),
      inspectFast: async () => ({ nodes: 1 }),
      mutate: async () => undefined,
    },
    [Symbol.asyncDispose]: async () => undefined,
  };
}
