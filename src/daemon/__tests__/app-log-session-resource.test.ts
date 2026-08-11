import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { localRuntimeOwner, type CleanupOutcome } from '@agent-device/contracts/platform';
import { createAppLogStartResult, createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { createTestAppLogLiveHandle } from '../../__tests__/test-utils/app-log-live-handle.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createAppLogAdmissionLedger } from '../app-log-admission-ledger.ts';
import { adoptStartedSessionAppLog } from '../app-log-session-resource.ts';
import { createNextAppLogFence } from '../app-log-start-preflight.ts';
import { appLogResourceStore } from '../app-log-resource-store.ts';
import type { SessionState } from '../types.ts';

test('start persists open recovery truth before adopting the live handle', async () => {
  const context = makeContext();
  const runtime = makeStartResult(context);
  await adoptStartedSessionAppLog({
    ...context,
    ...runtime.result,
    throwIfCanceled: () => {},
  });
  expect(context.sessionStore.get(context.sessionName)?.appLog?.handle).toBe(runtime.handle);
  expect(appLogResourceStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { phase: 'active' } },
  });
});

test('cancellation after native start cleans the pending handle and terminalizes the record', async () => {
  const context = makeContext();
  const runtime = makeStartResult(context);
  const primary = new AppError('CANCELED', 'request canceled');
  await expect(
    adoptStartedSessionAppLog({
      ...context,
      ...runtime.result,
      throwIfCanceled: () => {
        throw primary;
      },
    }),
  ).rejects.toBe(primary);
  expect(runtime.forceCleanup).toHaveBeenCalledOnce();
  expect(appLogResourceStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed' },
  });
});

test('rejecting canceled-start cleanup retains cleanup-pending truth and blocks replacement', async () => {
  const context = makeContext();
  const runtime = makeStartResult(context, {
    status: 'cleanup-pending',
    reason: 'cleanup-unconfirmed',
  });
  const primary = new AppError('CANCELED', 'request canceled');
  await expect(
    adoptStartedSessionAppLog({
      ...context,
      ...runtime.result,
      throwIfCanceled: () => {
        throw primary;
      },
    }),
  ).rejects.toBe(primary);
  expect(appLogResourceStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { phase: 'cleanup-pending' } },
  });
  expect(() =>
    createNextAppLogFence({
      ledger: context.admissionLedger,
      resourcePath: context.resourcePath,
      device: context.device,
    }),
  ).toThrow(/terminal state/);
});

test('SessionStore failure after transfer disposes the transferred handle and preserves primary error', async () => {
  const context = makeContext();
  const runtime = makeStartResult(context);
  const primary = new Error('store adoption failed');
  vi.spyOn(context.sessionStore, 'set').mockImplementationOnce(() => {
    throw primary;
  });
  await expect(
    adoptStartedSessionAppLog({
      ...context,
      ...runtime.result,
      throwIfCanceled: () => {},
    }),
  ).rejects.toBe(primary);
  expect(runtime.forceCleanup).toHaveBeenCalledOnce();
  expect(appLogResourceStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed' },
  });
});

test('incoherent start envelope with rejecting cleanup persists a blocking tombstone', async () => {
  const context = makeContext();
  const runtime = makeStartResult(context, {
    status: 'cleanup-pending',
    reason: 'cleanup-unconfirmed',
  });
  const incoherentEnvelope = createDurableResourceEnvelope({
    ...runtime.result.envelope,
    sessionId: 'wrong-session',
  });

  await expect(
    adoptStartedSessionAppLog({
      ...context,
      pendingHandle: runtime.result.pendingHandle,
      envelope: incoherentEnvelope,
      throwIfCanceled: () => {},
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'runtime-contract-invalid' },
  });
  expect(runtime.forceCleanup).toHaveBeenCalledOnce();
  expect(appLogResourceStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: {
      sessionId: context.sessionName,
      lifecycle: 'open',
      metadata: { phase: 'cleanup-pending', runtimeContractInvalid: true },
    },
  });
  expect(() =>
    createNextAppLogFence({
      ledger: context.admissionLedger,
      resourcePath: context.resourcePath,
      device: context.device,
    }),
  ).toThrow(/terminal state/);
});

test.each([
  {
    label: 'Apple leaf',
    device: { id: 'ios-device', family: 'apple', appleOs: 'macos', kind: 'device' } as const,
  },
  {
    label: 'physical-device backend',
    device: {
      id: 'ios-device',
      family: 'apple',
      appleOs: 'ios',
      kind: 'device',
      target: 'mobile',
      iosPhysicalDeviceBackend: 'coredevice',
    } as const,
  },
])('rejects a start envelope with a mismatched $label identity', async ({ device }) => {
  const context = makeContext({
    platform: 'apple',
    appleOs: 'ios',
    id: 'ios-device',
    name: 'iPhone',
    kind: 'device',
    target: 'mobile',
    iosPhysicalDeviceBackend: 'xctest',
  });
  const runtime = makeStartResult(context, { status: 'cleaned' }, device);

  await expect(
    adoptStartedSessionAppLog({
      ...context,
      ...runtime.result,
      throwIfCanceled: () => {},
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'runtime-contract-invalid' },
  });
  expect(runtime.forceCleanup).toHaveBeenCalledOnce();
  expect(context.sessionStore.get(context.sessionName)?.appLog).toBeUndefined();
});

test('unwritable tombstone plus rejecting cleanup blocks same-process replacement', async () => {
  const context = makeContext();
  const runtime = makeStartResult(context, {
    status: 'cleanup-pending',
    reason: 'cleanup-unconfirmed',
  });
  const incoherentEnvelope = createDurableResourceEnvelope({
    ...runtime.result.envelope,
    sessionId: 'wrong-session',
  });
  const resourceDir = path.dirname(context.resourcePath);
  fs.mkdirSync(resourceDir, { recursive: true });
  fs.chmodSync(resourceDir, 0o500);

  try {
    await expect(
      adoptStartedSessionAppLog({
        ...context,
        pendingHandle: runtime.result.pendingHandle,
        envelope: incoherentEnvelope,
        throwIfCanceled: () => {},
      }),
    ).rejects.toMatchObject({ details: { reason: 'runtime-contract-invalid' } });
  } finally {
    fs.chmodSync(resourceDir, 0o700);
  }

  expect(appLogResourceStore.read(context.resourcePath)).toEqual({ status: 'missing' });
  expect(() =>
    createNextAppLogFence({
      ledger: context.admissionLedger,
      resourcePath: context.resourcePath,
      device: context.device,
    }),
  ).toThrow(/process-local/);
});

test('lost durable record during failed adoption installs a same-device process block', async () => {
  const context = makeContext({
    platform: 'android',
    id: 'record-lost-device',
    name: 'Pixel',
    kind: 'emulator',
  });
  const runtime = makeStartResult(context, {
    status: 'cleanup-pending',
    reason: 'cleanup-unconfirmed',
  });
  const primary = new AppError('CANCELED', 'request canceled');

  await expect(
    adoptStartedSessionAppLog({
      ...context,
      ...runtime.result,
      throwIfCanceled: () => {
        fs.rmSync(context.resourcePath);
        throw primary;
      },
    }),
  ).rejects.toBe(primary);

  expect(appLogResourceStore.read(context.resourcePath)).toEqual({ status: 'missing' });
  expect(() =>
    createNextAppLogFence({
      ledger: context.admissionLedger,
      resourcePath: context.resourcePath,
      device: context.device,
    }),
  ).toThrow(/process-local/);
});

function makeContext(
  device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
  },
) {
  const sessionStore = makeSessionStore('app-log-session-resource-');
  const sessionName = 'session';
  const session: SessionState = {
    name: sessionName,
    device,
    createdAt: Date.now(),
    actions: [],
  };
  sessionStore.set(sessionName, session);
  const resourcePath = appLogResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName));
  return {
    admissionLedger: createAppLogAdmissionLedger(),
    session,
    sessionName,
    sessionStore,
    resourcePath,
    device: session.device,
    owner: localRuntimeOwner(device.platform),
    fence: { token: 'fence', generation: 1 },
  };
}

function makeStartResult(
  context: ReturnType<typeof makeContext>,
  cleanup: CleanupOutcome = { status: 'cleaned' },
  envelopeDevice?: Parameters<typeof createDurableResourceEnvelope>[0]['device'],
) {
  const forceCleanup = vi.fn(async () => cleanup);
  const handle = createTestAppLogLiveHandle({
    inspect: () => ({ backend: 'android', state: 'active', startedAt: 1 }),
    finish: async () => ({
      status: 'completed',
      result: { backend: 'android', outputPath: '/tmp/app.log', completedAt: 2 },
    }),
    forceCleanup,
  });
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'app-log',
    sessionId: context.sessionName,
    device: envelopeDevice ?? {
      id: context.device.id,
      family: context.device.platform,
      ...(context.device.appleOs === undefined ? {} : { appleOs: context.device.appleOs }),
      kind: context.device.kind,
      ...(context.device.target === undefined ? {} : { target: context.device.target }),
      ...(context.device.iosPhysicalDeviceBackend === undefined
        ? {}
        : { iosPhysicalDeviceBackend: context.device.iosPhysicalDeviceBackend }),
    },
    owner: context.owner,
    fence: context.fence,
    lifecycle: 'open',
    descriptor: { version: 1, body: { pid: 123 } },
  });
  return {
    handle,
    forceCleanup,
    result: createAppLogStartResult(handle, envelope),
  };
}
