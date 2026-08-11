import { expect, test, vi } from 'vitest';
import {
  appLogAdmissionUse,
  localRuntimeOwner,
  networkDumpUse,
  resolveLogsRuntimePlan,
  screenRecordingRecoveryUse,
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { acquireDurableCaptureRecoveryAuthorityBeforeDeadline } from '../durable-capture-recovery-authority.ts';
import { createRequestRuntimeBindings } from '../request-runtime-binding.ts';

const inspectPlan = resolveLogsRuntimePlan({ action: 'path' });
const doctorPlan = resolveLogsRuntimePlan({ action: 'doctor' });
if (inspectPlan.kind !== 'path' || doctorPlan.kind !== 'doctor') {
  throw new TypeError('Expected inspect and doctor app-log plans');
}
const appLogInspectUse = inspectPlan.use;
const appLogDoctorUse = doctorPlan.use;

const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

test('request runtime binding caches one broad owner and projects each declared use', async () => {
  const runtime = makeGateway();
  const bindings = createRequestRuntimeBindings({ gateway: runtime.gateway, scope });

  const admission = await bindings.bindDevice(device('one'), appLogAdmissionUse);
  const inspect = await bindings.bindDevice(device('one'), appLogInspectUse);
  const doctor = await bindings.bindDevice(device('one'), appLogDoctorUse);
  const network = await bindings.bindDevice(device('one'), networkDumpUse);

  expect(runtime.bind).toHaveBeenCalledOnce();
  expect(admission.operations.appLogInspect).toBe(runtime.operations.appLogInspect);
  expect(Object.keys(inspect.operations)).toEqual(['appLogInspect']);
  expect(Object.keys(doctor.operations)).toEqual(['appLogInspect', 'appLogDoctor']);
  expect(Object.keys(network.operations)).toEqual(['networkDump']);
  expect(Symbol.asyncDispose in doctor).toBe(false);
  await bindings[Symbol.asyncDispose]();
  expect(runtime.disposals).toEqual(['one']);
});

test('request binding disposes multiple owners in reverse adoption order', async () => {
  const runtime = makeGateway();
  const bindings = createRequestRuntimeBindings({ gateway: runtime.gateway, scope });
  await bindings.bindDevice(device('one'), appLogInspectUse);
  await bindings.bindDevice(device('two'), appLogInspectUse);
  await bindings[Symbol.asyncDispose]();
  expect(runtime.disposals).toEqual(['two', 'one']);
});

test('concurrent uses share one in-flight broad binding for the device', async () => {
  const runtime = makeGateway();
  const bindings = createRequestRuntimeBindings({ gateway: runtime.gateway, scope });
  const selected = device('one');

  await Promise.all([
    bindings.bindDevice(selected, appLogInspectUse),
    bindings.bindDevice(selected, appLogDoctorUse),
    bindings.bindDevice(selected, networkDumpUse),
  ]);

  expect(runtime.bind).toHaveBeenCalledOnce();
  await bindings[Symbol.asyncDispose]();
  expect(runtime.disposals).toEqual(['one']);
});

test('preferred absence is visible without failing while required absence fails typed', async () => {
  const runtime = makeGateway({ inspectAvailable: false });
  const bindings = createRequestRuntimeBindings({ gateway: runtime.gateway, scope });
  const admission = await bindings.bindDevice(device('one'), appLogAdmissionUse);
  expect(admission.facts.appLogInspect).toMatchObject({ available: false });
  expect(admission.operations.appLogInspect).toBeUndefined();
  await expect(bindings.bindDevice(device('one'), appLogInspectUse)).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
  });
  await bindings[Symbol.asyncDispose]();
});

test('exact-owner recovery binds the persisted owner and fence without ordinary arbitration', async () => {
  const runtime = makeGateway();
  const bindings = createRequestRuntimeBindings({ gateway: runtime.gateway, scope });
  const selected = device('one');
  const owner = localRuntimeOwner('android');
  const fence = { token: 'recording-fence', generation: 4 } as const;
  const recoveryScope = {
    signal: new AbortController().signal,
    diagnostics: { emit: vi.fn() },
    progress: { report: vi.fn() },
  };

  const recovered = await bindings.bindExactDevice(
    selected,
    owner,
    fence,
    screenRecordingRecoveryUse,
    recoveryScope,
  );

  expect(recovered.operations.screenRecordingReattach).toBe(
    runtime.operations.screenRecordingReattach,
  );
  expect(runtime.bind).toHaveBeenCalledWith({
    device: selected,
    intent: { kind: 'exact-owner', owner, fence },
    scope: recoveryScope,
  });
  await bindings[Symbol.asyncDispose]();
  expect(runtime.disposals).toEqual(['one']);
});

test('late exact-owner binding is rolled back when request cleanup already began', async () => {
  const runtime = makeGateway();
  const selected = device('late');
  const owner = localRuntimeOwner('android');
  const fence = { token: 'recording-fence', generation: 4 } as const;
  const published = await runtime.gateway.bind({
    device: selected,
    intent: { kind: 'exact-owner', owner, fence },
    scope,
  });
  const disposePublished = vi.fn(async () => {});
  const lateBinding = { ...published, [Symbol.asyncDispose]: disposePublished };
  let publish: (binding: DeviceBinding<PlatformRuntimeOperations>) => void = () => {};
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    bind: vi.fn(
      async () =>
        await new Promise<DeviceBinding<PlatformRuntimeOperations>>((resolve) => {
          publish = resolve;
        }),
    ),
    shutdown: async () => {},
  };
  const bindings = createRequestRuntimeBindings({ gateway, scope });
  const binding = bindings.bindExactDevice(
    selected,
    owner,
    fence,
    screenRecordingRecoveryUse,
    scope,
  );
  await bindings[Symbol.asyncDispose]();
  publish(lateBinding);

  await expect(binding).rejects.toThrow('Cannot register cleanup after disposal has begun');
  expect(disposePublished).toHaveBeenCalledOnce();
});

test('late exact-owner rollback failure is secondary diagnostic evidence', async () => {
  const runtime = makeGateway();
  const selected = device('late-cleanup-failure');
  const owner = localRuntimeOwner('android');
  const fence = { token: 'recording-fence', generation: 4 } as const;
  const published = await runtime.gateway.bind({
    device: selected,
    intent: { kind: 'exact-owner', owner, fence },
    scope,
  });
  const lateBinding = {
    ...published,
    [Symbol.asyncDispose]: vi.fn(async () => {
      throw new Error('rollback failed');
    }),
  };
  let publish: (binding: DeviceBinding<PlatformRuntimeOperations>) => void = () => {};
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    bind: vi.fn(
      async () =>
        await new Promise<DeviceBinding<PlatformRuntimeOperations>>((resolve) => {
          publish = resolve;
        }),
    ),
    shutdown: async () => {},
  };
  const emit = vi.fn();
  const recoveryScope = {
    signal: new AbortController().signal,
    diagnostics: { emit },
    progress: { report: () => {} },
  };
  const bindings = createRequestRuntimeBindings({ gateway, scope });
  const binding = bindings.bindExactDevice(
    selected,
    owner,
    fence,
    screenRecordingRecoveryUse,
    recoveryScope,
  );
  await bindings[Symbol.asyncDispose]();
  publish(lateBinding);

  await expect(binding).rejects.toThrow('Cannot register cleanup after disposal has begun');
  expect(emit).toHaveBeenCalledWith({
    level: 'error',
    phase: 'request_runtime_late_binding_cleanup_failed',
    data: {
      error: 'rollback failed',
      primaryError: 'Cannot register cleanup after disposal has begun',
    },
  });
});

test('request cancellation aborts deferred exact recovery and late publication is disposed', async () => {
  const runtime = makeGateway();
  const selected = device('canceled-recovery');
  const owner = localRuntimeOwner('android');
  const fence = { token: 'recording-fence', generation: 4 } as const;
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'screen-recording',
    sessionId: 'session',
    device: { id: selected.id, family: 'android', kind: 'emulator' },
    owner,
    fence,
    lifecycle: 'open',
    descriptor: { version: 1, body: {} },
  });
  const published = await runtime.gateway.bind({
    device: selected,
    intent: { kind: 'exact-owner', owner, fence },
    scope,
  });
  const disposePublished = vi.fn(async () => {});
  const lateBinding = { ...published, [Symbol.asyncDispose]: disposePublished };
  let publish: (binding: DeviceBinding<PlatformRuntimeOperations>) => void = () => {};
  let observedScope: typeof scope | undefined;
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    bind: vi.fn(
      async (request) =>
        await new Promise<DeviceBinding<PlatformRuntimeOperations>>((resolve) => {
          observedScope = request.scope;
          publish = resolve;
        }),
    ),
    shutdown: async () => {},
  };
  const controller = new AbortController();
  const cancellation = new Error('request canceled during exact bind');
  const requestScope = {
    signal: controller.signal,
    diagnostics: { emit: vi.fn() },
    progress: { report: () => {} },
  };
  const bindings = createRequestRuntimeBindings({ gateway, scope: requestScope });
  const acquisition = acquireDurableCaptureRecoveryAuthorityBeforeDeadline({
    displayName: 'screen recording',
    envelope,
    scope: requestScope,
    deadlineMs: 10_000,
    acquireControl: async (_candidate, recoveryScope) => {
      const bound = await bindings.bindExactDevice(
        selected,
        owner,
        fence,
        screenRecordingRecoveryUse,
        recoveryScope,
      );
      return {
        reattach: async () => await bound.operations.screenRecordingReattach({ envelope }),
        cleanup: async () => await bound.operations.screenRecordingCleanup({ envelope }),
        [Symbol.asyncDispose]: async () => {},
      };
    },
    onLateCleanupFailure: () => {},
  });
  await vi.waitFor(() => expect(gateway.bind).toHaveBeenCalledOnce());
  controller.abort(cancellation);

  await expect(acquisition).rejects.toBe(cancellation);
  expect(observedScope?.signal.aborted).toBe(true);
  expect(observedScope?.signal.reason).toBe(cancellation);
  await bindings[Symbol.asyncDispose]();
  publish(lateBinding);
  await vi.waitFor(() => expect(disposePublished).toHaveBeenCalledOnce());
});

function makeGateway(options: { inspectAvailable?: boolean } = {}) {
  const disposals: string[] = [];
  const operations: PlatformRuntimeOperations = {
    appLogInspect: vi.fn(async () => ({ backend: 'android' as const })),
    appLogDoctor: vi.fn(async () => ({ backend: 'android' as const, checks: {}, notes: [] })),
    appLogStart: vi.fn(async () => {
      throw new Error('not used');
    }),
    appLogReattach: vi.fn(async () => ({ status: 'missing' as const })),
    appLogCleanup: vi.fn(async () => ({ status: 'already-missing' as const })),
    networkDump: vi.fn(async () => ({
      source: 'app-log' as const,
      backend: 'android' as const,
      dump: {
        path: '/tmp/app.log',
        exists: false,
        scannedLines: 0,
        matchedLines: 0,
        entries: [],
        include: 'summary' as const,
        limits: { maxEntries: 25, maxPayloadChars: 2048, maxScanLines: 4000 },
      },
      notes: [],
    })),
    screenRecordingStart: vi.fn(async () => {
      throw new Error('not used');
    }),
    screenRecordingReattach: vi.fn(async () => ({ status: 'missing' as const })),
    screenRecordingCleanup: vi.fn(async () => ({ status: 'already-missing' as const })),
  };
  const bind = vi.fn(
    async ({ device: selected }): Promise<DeviceBinding<PlatformRuntimeOperations>> => ({
      device: selected,
      owner: localRuntimeOwner('android'),
      facts: {
        device: { family: 'android', kind: 'emulator', providerMode: 'local' },
        operations: {
          appLogInspect:
            options.inspectAvailable === false
              ? { available: false, reason: 'owner-capability-missing' }
              : { available: true },
          appLogDoctor: { available: true },
          appLogStart: { available: true },
          appLogReattach: { available: true },
          appLogCleanup: { available: true },
          networkDump: { available: true },
          screenRecordingStart: { available: true },
          screenRecordingReattach: { available: true },
          screenRecordingCleanup: { available: true },
        },
      },
      operations:
        options.inspectAvailable === false
          ? {
              appLogDoctor: operations.appLogDoctor,
              appLogStart: operations.appLogStart,
              appLogReattach: operations.appLogReattach,
              appLogCleanup: operations.appLogCleanup,
              networkDump: operations.networkDump,
              screenRecordingStart: operations.screenRecordingStart,
              screenRecordingReattach: operations.screenRecordingReattach,
              screenRecordingCleanup: operations.screenRecordingCleanup,
            }
          : operations,
      [Symbol.asyncDispose]: async () => {
        disposals.push(selected.id);
      },
    }),
  );
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    bind,
    shutdown: async () => {},
  };
  return { gateway, bind, operations, disposals };
}

function device(id: string): DeviceInfo {
  return { platform: 'android', id, name: id, kind: 'emulator' };
}
