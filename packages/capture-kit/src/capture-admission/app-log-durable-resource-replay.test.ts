import { expect, test, vi } from 'vitest';
import type { AppLogCompletion, AppLogLiveHandle } from '@agent-device/contracts/app-log-runtime';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { JsonObject } from '@agent-device/contracts/client';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createDurableResourceEnvelope } from '../durable-resource-envelope.ts';
import { makeCaptureSessionBinding } from '../durable-capture/session-binding.fixtures.ts';
import { appLogDurableResource, appLogResourceStore } from './app-log-durable-resource.ts';
import { createDurableCaptureAdmissionLedger } from './durable-capture-admission-ledger.ts';
import type { DurableCaptureSessionResource } from '../durable-capture/index.ts';
import {
  makeCaptureAdmissionSessionStore,
  type CaptureAdmissionSessionStore,
} from './__tests__/session-store.fixtures.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
};

const completion: AppLogCompletion = {
  backend: 'android',
  outputPath: '/tmp/app.log',
  completedAt: 2,
};

/** The app-log slot this kind owns, plus the device the record answers the caller with. */
type TestAppLogSession = Readonly<{
  name: string;
  device: DeviceInfo;
  appLog?: DurableCaptureSessionResource<'app-log', AppLogLiveHandle>;
}>;

function makeStore(prefix: string) {
  const sessionStore = makeCaptureAdmissionSessionStore<TestAppLogSession>(prefix);
  sessionStore.set('logging', { name: 'logging', device });
  return sessionStore;
}

function makeBinding(sessionStore: CaptureAdmissionSessionStore<TestAppLogSession>) {
  return makeCaptureSessionBinding<'app-log', AppLogLiveHandle, TestAppLogSession>(
    sessionStore,
    'logging',
    {
      read: (session) => session.appLog,
      replace: (session, appLog) => ({ ...session, appLog }),
    },
  );
}

function makeHandle(finishImpl?: () => Promise<void>) {
  return {
    inspect: () => ({ backend: 'android', state: 'active' as const, startedAt: 1 }),
    finish: vi.fn(async () => {
      await finishImpl?.();
      return { status: 'completed' as const, result: completion };
    }),
    forceCleanup: vi.fn(async () => ({ status: 'cleaned' as const })),
    [Symbol.asyncDispose]: async () => {},
  } satisfies AppLogLiveHandle & { finish: ReturnType<typeof vi.fn> };
}

async function adopt(
  sessionStore: CaptureAdmissionSessionStore<TestAppLogSession>,
  handle: AppLogLiveHandle,
) {
  const binding = makeBinding(sessionStore);
  await appLogDurableResource.adoptStarted({
    admissionLedger: createDurableCaptureAdmissionLedger({ displayName: 'app-log' }),
    binding,
    device,
    owner: localRuntimeOwner(device.platform),
    fence: { token: 'app-log-fence', generation: 1 },
    pendingHandle: new PendingTransferGuard(handle),
    envelope: createDurableResourceEnvelope({
      resourceKind: 'app-log',
      sessionId: 'logging',
      device: { id: device.id, family: device.platform, kind: device.kind },
      owner: localRuntimeOwner(device.platform),
      fence: { token: 'app-log-fence', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: { pid: 123 } },
    }),
    throwIfCanceled: () => {},
  });
  return binding;
}

function resourcePath(sessionStore: CaptureAdmissionSessionStore<TestAppLogSession>) {
  return appLogResourceStore.resolvePath(sessionStore.resolveSessionDir('logging'));
}

/**
 * Commits a record the way the mechanics do, then overwrites its journal with `metadata`, so a
 * finish arrives at a committed record whose completion facts are damaged on disk.
 */
async function commitRecordWithMetadata(
  sessionStore: CaptureAdmissionSessionStore<TestAppLogSession>,
  metadata: JsonObject | undefined,
) {
  const handle = makeHandle();
  const binding = await adopt(sessionStore, handle);
  const queued = binding.read();
  if (!queued) throw new Error('Expected an adopted app-log resource');
  await appLogDurableResource.forceCleanupLive({ binding });
  const record = appLogResourceStore.read(resourcePath(sessionStore));
  if (record.status !== 'decoded') throw new Error('Expected a committed app-log record');
  appLogResourceStore.write(resourcePath(sessionStore), { ...record.envelope, metadata });
  // A finish that had captured the handle before the record settled.
  binding.adopt(queued);
  return { binding, handle };
}

/**
 * A stopped stream journals the three facts it answered with, so a second caller of the same record
 * is answered from them instead of being refused. Before the record could answer for its own
 * completion, a teardown finish queued behind an in-flight `logs stop` reported the session's log
 * file as an unreleased resource.
 */
test('a finish queued behind a committed app-log stop replays that completion', async () => {
  const sessionStore = makeStore('app-log-replay-');
  const handle = makeHandle();
  const binding = await adopt(sessionStore, handle);
  // The queued teardown's own view of the slot, captured while the record was still open.
  const queued = binding.read();
  if (!queued) throw new Error('Expected an adopted app-log resource');

  const stopped = await appLogDurableResource.finishLive({ intent: 'capture', binding });
  binding.adopt(queued);

  await expect(appLogDurableResource.finishLive({ intent: 'disposal', binding })).resolves.toEqual(
    stopped,
  );
  expect(handle.finish).toHaveBeenCalledOnce();
  expect(binding.read()).toBeUndefined();
});

/**
 * A stream the session forced closed committed a record that never produced a log file, so its
 * journal holds the mechanics' cleanup state and none of the completion facts. A finish arriving for
 * that record keeps the typed refusal: nothing here may invent a log path the stream never flushed to.
 */
test('an app-log record committed by cleanup refuses rather than inventing a log path', async () => {
  const sessionStore = makeStore('app-log-replay-cleanup-');
  const handle = makeHandle();
  const binding = await adopt(sessionStore, handle);
  const queued = binding.read();
  if (!queued) throw new Error('Expected an adopted app-log resource');

  await appLogDurableResource.forceCleanupLive({ binding });
  // A finish that had already captured this handle reaches the record cleanup committed.
  binding.adopt(queued);

  await expect(
    appLogDurableResource.finishLive({ intent: 'disposal', binding }),
  ).rejects.toMatchObject({ details: { reason: 'resource-already-completed' } });
  expect(handle.finish).not.toHaveBeenCalled();
});

/**
 * Every fact the reader needs is checked, so a committed record whose journal is damaged stays a
 * refusal. Each case is a record that has lost exactly one fact, or holds one the backend union does
 * not know: none of them may be answered with a completion assembled from the rest.
 */
const damagedCompletions: ReadonlyArray<readonly [string, JsonObject | undefined]> = [
  ['no journal at all', undefined],
  ['no backend', { phase: 'completed', outputPath: '/tmp/app.log', completedAt: 2 }] as const,
  [
    'an unknown backend',
    { phase: 'completed', backend: 'symbian', outputPath: '/tmp/app.log', completedAt: 2 },
  ] as const,
  ['no log path', { phase: 'completed', backend: 'android', completedAt: 2 }] as const,
  [
    'an empty log path',
    { phase: 'completed', backend: 'android', outputPath: '', completedAt: 2 },
  ] as const,
  ['no stop time', { phase: 'completed', backend: 'android', outputPath: '/tmp/app.log' }] as const,
  [
    'a stop time that is not a real instant',
    { phase: 'completed', backend: 'android', outputPath: '/tmp/app.log', completedAt: Number.NaN },
  ] as const,
];

test.each(damagedCompletions)(
  'a committed app-log record that cannot name its completion (%s) is refused',
  async (_case, metadata) => {
    const sessionStore = makeStore('app-log-replay-damaged-');
    const { binding, handle } = await commitRecordWithMetadata(sessionStore, metadata);

    await expect(
      appLogDurableResource.finishLive({ intent: 'disposal', binding }),
    ).rejects.toMatchObject({ details: { reason: 'resource-already-completed' } });
    expect(handle.finish).not.toHaveBeenCalled();
  },
);
