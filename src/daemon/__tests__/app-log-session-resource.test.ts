import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { CleanupOutcome } from '@agent-device/contracts/durable-resource';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  createAppLogLiveHandleFromFinish,
  createAppLogStartResult,
  createDurableResourceEnvelope,
} from '@agent-device/capture-kit';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { createTestAppLogLiveHandle } from '../../__tests__/test-utils/app-log-live-handle.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createAppLogAdmissionLedger } from '../app-log-admission-ledger.ts';
import { adoptStartedSessionAppLog, finishSessionAppLog } from '../app-log-session-resource.ts';
import { createNextAppLogFence } from '../app-log-start-preflight.ts';
import { appLogResourceStore } from '../app-log-resource-store.ts';
import type { SessionState } from '../session-state.ts';
import { stopSessionAppLog } from '../session-teardown.ts';

test('teardown captures an adopted app log before its lazy import can cross retirement', async () => {
  const context = makeContext();
  const runtime = makeStartResult(context);
  await adoptStartedSessionAppLog({
    ...context,
    ...runtime.result,
    throwIfCanceled: () => {},
  });
  expect(context.ref.session.appLog).toBeUndefined();
  const stopping = stopSessionAppLog(context);
  context.sessionStore.retire(context.ref);
  const successor = context.sessionStore.publish(context.sessionName, {
    ...context.session,
    appName: 'successor',
  });
  await stopping;
  expect(runtime.forceCleanup).toHaveBeenCalledOnce();
  expect(context.sessionStore.requireCurrent(successor)).toBe(successor.session);
  expect(context.sessionStore.requireCurrent(successor).appLog).toBeUndefined();
});

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
  vi.spyOn(context.sessionStore, 'update').mockImplementationOnce(() => {
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

test('app-log disposes on a failed finish because its retry is that same finish and the log file survives it', async () => {
  const directory = mkdtempForTestSync('app-log-failed-finish-');
  const logPath = path.join(directory, 'app.log');
  fs.writeFileSync(logPath, 'launch\n');
  const context = makeContext();
  const finishError = new Error('logcat stream stop could not be confirmed');
  let finishAttempts = 0;
  const handle = createAppLogLiveHandleFromFinish({
    inspect: () => ({ backend: 'android', state: 'active', startedAt: 1 }),
    finish: async () => {
      finishAttempts += 1;
      if (finishAttempts === 1) throw finishError;
      return {
        status: 'completed',
        result: { backend: 'android', outputPath: logPath, completedAt: 2 },
      };
    },
  });
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'app-log',
    sessionId: context.sessionName,
    device: { id: context.device.id, family: context.device.platform, kind: context.device.kind },
    owner: context.owner,
    fence: context.fence,
    lifecycle: 'open',
    descriptor: { version: 1, body: { pid: 123 } },
  });
  await adoptStartedSessionAppLog({
    ...context,
    pendingHandle: new PendingTransferGuard(handle),
    envelope,
    throwIfCanceled: () => {},
  });

  await expect(
    finishSessionAppLog({
      intent: 'capture',
      ...context,
    }),
  ).rejects.toBe(finishError);

  expect(finishAttempts).toBe(2);
  expect(fs.readFileSync(logPath, 'utf8')).toBe('launch\n');
  expect(appLogResourceStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed' },
  });
  expect(() =>
    createNextAppLogFence({
      ledger: context.admissionLedger,
      resourcePath: context.resourcePath,
      device: context.device,
    }),
  ).not.toThrow();
});

test('shutdown admission rejects a late start while its existing session still occupies the address', async () => {
  const context = makeContext();
  const runtime = makeStartResult(context);
  context.sessionStore.closeAdmission();
  await expect(
    adoptStartedSessionAppLog({ ...context, ...runtime.result, throwIfCanceled: () => {} }),
  ).rejects.toMatchObject({ details: { reason: 'daemon_shutting_down' } });
  expect(runtime.forceCleanup).toHaveBeenCalledOnce();
  expect(context.sessionStore.requireCurrent(context.ref).appLog).toBeUndefined();
  expect(appLogResourceStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed' },
  });
});

test('failed adoption cannot terminalize successor evidence after its cleanup yields', async () => {
  const context = makeContext();
  const runtime = makeStartResult(context);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cleaning = new Promise<void>((resolve) => {
    entered = resolve;
  });
  runtime.forceCleanup.mockImplementationOnce(async () => {
    entered();
    await held;
    return { status: 'cleaned' };
  });
  const canceled = new AppError('CANCELED', 'canceled');
  const adoption = adoptStartedSessionAppLog({
    ...context,
    ...runtime.result,
    throwIfCanceled: () => {
      throw canceled;
    },
  });
  const rejected = expect(adoption).rejects.toBe(canceled);
  await cleaning;
  context.sessionStore.retire(context.ref);
  const successor = context.sessionStore.publish(context.sessionName, { ...context.session });
  const successorEnvelope = {
    ...runtime.result.envelope,
    fence: { token: 'successor', generation: 2 },
  };
  appLogResourceStore.write(context.resourcePath, successorEnvelope);
  release();
  await rejected;
  expect(context.sessionStore.requireCurrent(successor).appLog).toBeUndefined();
  expect(appLogResourceStore.read(context.resourcePath)).toEqual({
    status: 'decoded',
    envelope: successorEnvelope,
  });
});

test('late adoption disposes its pending handle without overwriting a successor manifest', async () => {
  const context = makeContext();
  const runtime = makeStartResult(context);
  context.sessionStore.retire(context.ref);
  const successor = context.sessionStore.publish(context.sessionName, { ...context.session });
  const envelope = { ...runtime.result.envelope, fence: { token: 'successor', generation: 2 } };
  appLogResourceStore.write(context.resourcePath, envelope);
  await expect(
    adoptStartedSessionAppLog({ ...context, ...runtime.result, throwIfCanceled: () => {} }),
  ).rejects.toMatchObject({ details: { reason: 'session_lifetime_ended' } });
  expect(runtime.forceCleanup).toHaveBeenCalledOnce();
  expect(context.sessionStore.requireCurrent(successor).appLog).toBeUndefined();
  expect(appLogResourceStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope,
  });
});

test.each(['rebuild', 'retire', 'replace-resource'] as const)(
  'finishing app log after %s preserves the current record and its other fields',
  async (change) => {
    const context = makeContext();
    const {
      result: { envelope },
    } = makeStartResult(context);
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const finish = vi.fn(async () => {
      enter();
      await release;
      return {
        status: 'completed' as const,
        result: { backend: 'android' as const, outputPath: '/tmp/app.log', completedAt: 2 },
      };
    });
    const handle = createTestAppLogLiveHandle({
      inspect: () => ({ backend: 'android', state: 'active', startedAt: 1 }),
      finish,
      forceCleanup: async () => ({ status: 'cleaned' }),
    });
    await adoptStartedSessionAppLog({
      ...context,
      envelope,
      pendingHandle: new PendingTransferGuard(handle),
      throwIfCanceled: () => {},
    });
    const finishing = finishSessionAppLog({ ...context, intent: 'capture' });
    await entered;
    let currentRef = context.ref;
    const active = context.sessionStore.requireCurrent(currentRef).appLog!;
    const replacementHandle = makeStartResult(context).handle;
    if (change === 'retire') {
      context.sessionStore.retire(currentRef);
      currentRef = context.sessionStore.publish(context.sessionName, {
        ...context.session,
        appLog: active,
        appName: 'successor',
      });
    } else {
      context.sessionStore.update(currentRef, {
        appName: 'updated',
        appLog:
          change === 'replace-resource' ? { ...active, handle: replacementHandle } : { ...active },
      });
    }
    resume();
    await finishing;
    expect(finish).toHaveBeenCalledOnce();
    const current = context.sessionStore.requireCurrent(currentRef);
    expect(current.appName).toBe(change === 'retire' ? 'successor' : 'updated');
    if (change === 'rebuild') expect(current.appLog).toBeUndefined();
    else expect(current.appLog?.handle).toBe(change === 'retire' ? handle : replacementHandle);
  },
);

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
    ref: sessionStore.lookup(sessionName)!,
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
