import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  decodeManagedBindingFence,
  localRuntimeOwner,
  managedBindingFence,
  managedLocalRuntimeOwner,
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
  inspectConditional: () => Promise<Readonly<{ nodes: number }>>;
  mutate: (input: Readonly<{ value: string }>) => Promise<void>;
};

const inspectUse = runtimeUse<TestOperations>()({
  required: ['inspect'],
  preferred: ['inspectFast'],
  conditional: ['inspectConditional'],
});

function compileTimeNarrowingProof(runtime: BoundDeviceRuntime<typeof inspectUse>): void {
  const required: TestOperations['inspect'] = runtime.operations.inspect;
  const preferred: TestOperations['inspectFast'] | undefined = runtime.operations.inspectFast;
  const conditional: TestOperations['inspectConditional'] | undefined =
    runtime.operations.inspectConditional;
  void required;
  void preferred;
  void conditional;

  // @ts-expect-error An undeclared sibling operation cannot cross the selected projection.
  void runtime.operations.mutate;
  // @ts-expect-error The selected runtime is intentionally not disposable by a handler.
  void runtime[Symbol.asyncDispose];
}
void compileTimeNarrowingProof;

function compileTimeDisjointProof(): void {
  // @ts-expect-error Required and preferred keys are statically disjoint.
  runtimeUse<TestOperations>()({ required: ['inspect'], preferred: ['inspect'] });
  runtimeUse<TestOperations>()({
    required: ['inspect'],
    preferred: ['inspectFast'],
    // @ts-expect-error Preferred and conditional keys are statically disjoint.
    conditional: ['inspectFast'],
  });
}
void compileTimeDisjointProof;

test('runtime use omits an empty conditional category from shipped declarations', () => {
  const captureUse = runtimeUse<TestOperations>()({ required: ['inspect'] });

  assert.deepEqual(captureUse, { required: ['inspect'], preferred: [] });
  assert.equal('conditional' in captureUse, false);
});

test('runtime use freezes declarations and rejects dynamic overlap or duplicates', () => {
  assert.deepEqual(inspectUse, {
    required: ['inspect'],
    preferred: ['inspectFast'],
    conditional: ['inspectConditional'],
  });
  assert.ok(Object.isFrozen(inspectUse));
  assert.ok(Object.isFrozen(inspectUse.required));
  assert.ok(Object.isFrozen(inspectUse.preferred));
  assert.ok(Object.isFrozen(inspectUse.conditional));

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
  assert.throws(
    () =>
      dynamic({
        required: ['inspect'],
        preferred: ['inspectFast'],
        conditional: ['inspectFast'] as unknown as readonly ['inspectConditional'],
      }),
    /both preferred and conditional/,
  );
});

test('runtime owner keys distinguish local families, managed local owners, and configured provider instances', () => {
  assert.equal(runtimeOwnerKey(localRuntimeOwner('apple')), 'local:apple');
  assert.equal(runtimeOwnerKey(managedLocalRuntimeOwner('sim-a')), 'managed:["sim-a"]');
  // One string names three different owners as a family, an allocator instance, and a provider.
  assert.notEqual(
    runtimeOwnerKey(managedLocalRuntimeOwner('apple')),
    runtimeOwnerKey(localRuntimeOwner('apple')),
  );
  assert.notEqual(
    runtimeOwnerKey(managedLocalRuntimeOwner('limrun')),
    runtimeOwnerKey(providerRuntimeOwner('limrun', 'limrun')),
  );
  assert.notEqual(
    runtimeOwnerKey(managedLocalRuntimeOwner('a"]')),
    runtimeOwnerKey(managedLocalRuntimeOwner('a')),
  );
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

test('managed local owner is keyed by one trimmed allocator instance', () => {
  const owner = managedLocalRuntimeOwner(' sim-a ');
  assert.deepEqual(owner, { kind: 'managed-local', instance: 'sim-a' });
  assert.ok(Object.isFrozen(owner));
  assert.throws(() => managedLocalRuntimeOwner('  '), /non-empty/);
  assert.equal(sameRuntimeOwner(owner, managedLocalRuntimeOwner('sim-a')), true);
  assert.equal(sameRuntimeOwner(owner, managedLocalRuntimeOwner('sim-b')), false);
});

test('managed binding fence separates requesters that share one identity incarnation', () => {
  const requesterA = managedBindingFence({
    requesterId: 'requester-a',
    requestGeneration: 1,
    identityIncarnationId: 'incarnation-1',
  });
  const requesterB = managedBindingFence({
    requesterId: 'requester-b',
    requestGeneration: 1,
    identityIncarnationId: 'incarnation-1',
  });
  assert.notDeepEqual(requesterA, requesterB);
  assert.equal(requesterA.generation, 1);
  assert.ok(Object.isFrozen(requesterA));
  // The allocator owns the form of its ids: a padded id is a different id, fenced verbatim.
  const padded = managedBindingFence({
    requesterId: ' requester-a ',
    requestGeneration: 1,
    identityIncarnationId: 'incarnation-1',
  });
  assert.notDeepEqual(requesterA, padded);
  assert.deepEqual(decodeManagedBindingFence(padded), {
    requesterId: ' requester-a ',
    requestGeneration: 1,
    identityIncarnationId: 'incarnation-1',
  });
  // Canonical JSON, not a separator: requester and incarnation can never re-split.
  assert.notEqual(
    managedBindingFence({ requesterId: 'a:b', requestGeneration: 1, identityIncarnationId: 'c' })
      .token,
    managedBindingFence({ requesterId: 'a', requestGeneration: 1, identityIncarnationId: 'b:c' })
      .token,
  );
  assert.throws(
    () =>
      managedBindingFence({ requesterId: '  ', requestGeneration: 1, identityIncarnationId: 'x' }),
    TypeError,
  );
  assert.throws(
    () =>
      managedBindingFence({ requesterId: 'a', requestGeneration: 1.5, identityIncarnationId: 'x' }),
    TypeError,
  );
});

test('managed binding fence decodes only what managedBindingFence encoded', () => {
  const identity = {
    requesterId: 'requester-a',
    requestGeneration: 3,
    identityIncarnationId: 'incarnation-1',
  };
  const decoded = decodeManagedBindingFence(managedBindingFence(identity));
  assert.deepEqual(decoded, identity);
  assert.ok(decoded && Object.isFrozen(decoded));
  // A durable-capture fence token is an opaque UUID, never a managed binding.
  assert.equal(decodeManagedBindingFence({ token: crypto.randomUUID(), generation: 1 }), null);
  for (const token of [
    JSON.stringify(['a', 'b', 'c']),
    JSON.stringify(['a', 7]),
    JSON.stringify(['', 'b']),
    JSON.stringify([' ', 'b']),
    // Non-canonical encoding of a well-formed pair: it re-encodes to a different token.
    '["a", "b"]',
  ]) {
    assert.equal(decodeManagedBindingFence({ token, generation: 1 }), null, token);
  }
  assert.equal(
    decodeManagedBindingFence({ token: JSON.stringify(['a', 'b']), generation: -1 }),
    null,
  );
});

test('binding narrowing proves required operations and omits unavailable preferred operations', () => {
  const binding = testBinding({
    inspect: { available: true },
    inspectFast: { available: false, reason: 'owner-capability-missing' },
    inspectConditional: { available: false, reason: 'owner-capability-missing' },
    mutate: { available: true },
  });
  const runtime = narrowDeviceBinding(binding, inspectUse);

  assert.equal(runtime.operations.inspect, binding.operations.inspect);
  assert.equal(runtime.operations.inspectFast, undefined);
  assert.equal(runtime.operations.inspectConditional, undefined);
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
    inspectConditional: { available: false, reason: 'owner-capability-missing' },
    mutate: { available: true },
  });
  assert.throws(
    () => narrowDeviceBinding(unsupported, inspectUse),
    (error) => error instanceof AppError && error.code === 'UNSUPPORTED_OPERATION',
  );

  const missing = testBinding({
    inspect: { available: true },
    inspectFast: { available: false, reason: 'owner-capability-missing' },
    inspectConditional: { available: false, reason: 'owner-capability-missing' },
    mutate: { available: true },
  });
  delete (missing.operations as Partial<TestOperations>).inspect;
  assert.throws(
    () => narrowDeviceBinding(missing, inspectUse),
    (error) => error instanceof AppError && error.details?.reason === 'runtime-contract-invalid',
  );
});

test('binding narrowing requires every conditionally available operation implementation', () => {
  const binding = testBinding({
    inspect: { available: true },
    inspectFast: { available: false, reason: 'owner-capability-missing' },
    inspectConditional: { available: true },
    mutate: { available: true },
  });
  assert.equal(
    narrowDeviceBinding(binding, inspectUse).operations.inspectConditional,
    binding.operations.inspectConditional,
  );

  delete (binding.operations as Partial<TestOperations>).inspectConditional;
  assert.throws(
    () => narrowDeviceBinding(binding, inspectUse),
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
      inspectConditional: async () => ({ nodes: 1 }),
      mutate: async () => undefined,
    },
    [Symbol.asyncDispose]: async () => undefined,
  };
}
