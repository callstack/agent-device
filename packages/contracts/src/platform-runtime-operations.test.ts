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
  READABLE_SETTINGS,
  bootTargetHeadlessUse,
  bootTargetUse,
  captureSnapshotUse,
  resolveDeviceReadinessRuntimePlan,
  resolveSettingsRuntimePlan,
  resolveSnapshotRuntimePlan,
  settingReadUse,
  settingsRuntimeUse,
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
  // The two declarations above are the assertion: a drifted vocabulary makes `true`
  // non-assignable to the `never` they are annotated with. After erasure this pair is
  // `true && true`, which no production change can contradict.
  void noOperationIsMissingFromTheList;
  void noListedNameIsUnknown;
  assert.equal(new Set(RUNTIME_OPERATION_NAMES).size, RUNTIME_OPERATION_NAMES.length);
  assert.equal(isRuntimeOperationName('captureSnapshot'), true);
  assert.equal(isRuntimeOperationName('notAnOperation'), false);
});

test('the settings leg rule names the read leg only for a lone readable setting', () => {
  const read = resolveSettingsRuntimePlan(['text-size']);
  assert.equal(read.kind, 'read');
  assert.equal(read.use, settingReadUse);
  if (read.kind === 'read') assert.equal(read.setting, 'text-size');

  // Normalization is the shared rule's, not each consumer's: the daemon lowercases its positionals
  // and the CLI does not.
  assert.equal(resolveSettingsRuntimePlan([' Text-Size ']).use, settingReadUse);
  // A category is the write leg even for a readable name, and an unreadable name never reads.
  assert.equal(resolveSettingsRuntimePlan(['text-size', 'large']).use, settingsRuntimeUse);
  assert.equal(resolveSettingsRuntimePlan(['wifi']).use, settingsRuntimeUse);
  assert.equal(resolveSettingsRuntimePlan(undefined).use, settingsRuntimeUse);
  assert.equal(resolveSettingsRuntimePlan([]).use, settingsRuntimeUse);
});

test('every readable setting is answered by the read use', () => {
  // The list is what both the descriptor's classification and the daemon's admitted operation are
  // built from, so a name that joins it without an owner answering it is caught where it is declared.
  assert.deepEqual([...READABLE_SETTINGS], ['text-size']);
  for (const setting of READABLE_SETTINGS) {
    assert.equal(resolveSettingsRuntimePlan([setting]).use, settingReadUse);
  }
});
