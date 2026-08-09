import { expect, test, vi } from 'vitest';
import {
  appLogAdmissionUse,
  localRuntimeOwner,
  resolveLogsRuntimePlan,
  type AppLogRuntimeOperations,
  type DeviceBinding,
  type DeviceRuntimeGateway,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
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

  expect(runtime.bind).toHaveBeenCalledOnce();
  expect(admission.operations.appLogInspect).toBe(runtime.operations.appLogInspect);
  expect(Object.keys(inspect.operations)).toEqual(['appLogInspect']);
  expect(Object.keys(doctor.operations)).toEqual(['appLogInspect', 'appLogDoctor']);
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

function makeGateway(options: { inspectAvailable?: boolean } = {}) {
  const disposals: string[] = [];
  const operations: AppLogRuntimeOperations = {
    appLogInspect: vi.fn(async () => ({ backend: 'android' as const })),
    appLogDoctor: vi.fn(async () => ({ backend: 'android' as const, checks: {}, notes: [] })),
    appLogStart: vi.fn(async () => {
      throw new Error('not used');
    }),
    appLogReattach: vi.fn(async () => ({ status: 'missing' as const })),
    appLogCleanup: vi.fn(async () => ({ status: 'already-missing' as const })),
  };
  const bind = vi.fn(
    async ({ device: selected }): Promise<DeviceBinding<AppLogRuntimeOperations>> => ({
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
        },
      },
      operations:
        options.inspectAvailable === false
          ? {
              appLogDoctor: operations.appLogDoctor,
              appLogStart: operations.appLogStart,
              appLogReattach: operations.appLogReattach,
              appLogCleanup: operations.appLogCleanup,
            }
          : operations,
      [Symbol.asyncDispose]: async () => {
        disposals.push(selected.id);
      },
    }),
  );
  const gateway: DeviceRuntimeGateway<AppLogRuntimeOperations> = {
    bind,
    shutdown: async () => {},
  };
  return { gateway, bind, operations, disposals };
}

function device(id: string): DeviceInfo {
  return { platform: 'android', id, name: id, kind: 'emulator' };
}
