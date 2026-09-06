import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import {
  localRuntimeOwner,
  providerRuntimeOwner,
  type RuntimeOperationKey,
} from './platform-runtime.ts';
import {
  RUNTIME_OPERATION_NAMES,
  isRuntimeOperationName,
  type RuntimeOperationName,
} from './runtime-operation-names.ts';
import {
  type PlatformRuntimeOperations,
  type PlatformRuntimeProviderModule,
  bootTargetHeadlessUse,
  bootTargetUse,
  captureSnapshotUse,
  resolveDeviceReadinessRuntimePlan,
  resolveSnapshotRuntimePlan,
} from './platform-runtime-operations.ts';

function compileTimeProviderModuleProof(): void {
  const invalid: PlatformRuntimeProviderModule = {
    // @ts-expect-error Provider modules cannot advertise a local-family owner.
    owner: localRuntimeOwner('apple'),
    loadRuntime: async () => {
      throw new Error('not loaded');
    },
  };
  void invalid;
}
void compileTimeProviderModuleProof;

test('provider module exposes inert exact-owner metadata without loading mechanics', () => {
  const loadRuntime = vi.fn(async () => {
    throw new Error('not loaded');
  });
  const module: PlatformRuntimeProviderModule = {
    owner: providerRuntimeOwner('limrun', 'tenant-a'),
    loadRuntime,
  };

  assert.deepEqual(module.owner, {
    kind: 'provider-runtime',
    provider: 'limrun',
    instance: 'tenant-a',
  });
  assert.equal(loadRuntime.mock.calls.length, 0);
});

test.each([
  [false, 'boot-target', 'bootTarget', bootTargetUse],
  [true, 'boot-target-headless', 'bootTargetHeadless', bootTargetHeadlessUse],
] as const)(
  'normalizes headless=%s into the literal readiness plan %s',
  (headless, kind, operation, use) => {
    assert.deepEqual(resolveDeviceReadinessRuntimePlan({ headless }), {
      kind,
      operation,
      use,
    });
  },
);

test.each([
  [false, true, 'active-app', 'captureSnapshot', captureSnapshotUse],
  [
    true,
    true,
    'custom-actions-active-app',
    'captureSnapshotWithCustomActions',
    {
      required: ['captureSnapshot', 'captureSnapshotWithCustomActions'],
      preferred: [],
    },
  ],
  [
    false,
    false,
    'without-active-app',
    'captureSnapshotWithoutActiveApp',
    {
      required: ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
      preferred: [],
    },
  ],
  [
    true,
    false,
    'custom-actions-without-active-app',
    'captureSnapshotWithCustomActions',
    {
      required: [
        'captureSnapshot',
        'captureSnapshotWithCustomActions',
        'captureSnapshotWithoutActiveApp',
      ],
      preferred: [],
    },
  ],
] as const)(
  'normalizes snapshot customActions=%s activeApp=%s into %s',
  (customActions, hasActiveApp, kind, operation, use) => {
    assert.deepEqual(resolveSnapshotRuntimePlan({ customActions, hasActiveApp }), {
      kind,
      operation,
      use,
    });
  },
);

// The value-level vocabulary must name exactly the operations union: a name missing from the list
// or an extra name both collapse these assignments to a compile error.
type OperationKey = RuntimeOperationKey<PlatformRuntimeOperations>;
type MissingFromList = Exclude<OperationKey, RuntimeOperationName>;
type ExtraInList = Exclude<RuntimeOperationName, OperationKey>;
const noOperationIsMissingFromTheList: [MissingFromList] extends [never] ? true : never = true;
const noListedNameIsUnknown: [ExtraInList] extends [never] ? true : never = true;

test('the runtime operation vocabulary is the operations union, with no duplicates', () => {
  assert.equal(noOperationIsMissingFromTheList && noListedNameIsUnknown, true);
  assert.equal(new Set(RUNTIME_OPERATION_NAMES).size, RUNTIME_OPERATION_NAMES.length);
  assert.equal(isRuntimeOperationName('captureSnapshot'), true);
  assert.equal(isRuntimeOperationName('notAnOperation'), false);
});
