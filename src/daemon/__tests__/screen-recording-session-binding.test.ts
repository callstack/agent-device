import { expect, test, vi } from 'vitest';
import { createScreenRecordingLiveHandle } from '@agent-device/capture-kit';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { makeRecordingSession } from './session-teardown.fixtures.ts';
import { bindRecordOnlyScreenRecording } from '../screen-recording-session-binding.ts';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import {
  adoptStartedScreenRecording,
  screenRecordingDurableResource,
} from '@agent-device/capture-kit/screen-recording-session-resource';

test('shutdown refuses draft publication while retaining unconfirmed recording cleanup evidence', async () => {
  const store = makeSessionStore();
  const session = makeRecordingSession({
    name: 'draft',
    sessionStore: store,
    finish: async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
  });
  const { handle: initial, envelope } = session.screenRecording!;
  const cleanup = vi.fn(
    async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }) as const,
  );
  const handle = createScreenRecordingLiveHandle(initial.inspect(), {
    finish: async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
    forceCleanup: cleanup,
  });
  const draft = bindRecordOnlyScreenRecording(store, 'draft', {
    ...session,
    screenRecording: undefined,
  });
  store.closeAdmission();
  await expect(
    adoptStartedScreenRecording({
      binding: draft.binding,
      admissionLedger: createScreenRecordingAdmissionLedger(),
      device: session.device,
      owner: envelope.owner,
      fence: envelope.fence,
      pendingHandle: new PendingTransferGuard(handle),
      envelope,
      throwIfCanceled: () => {},
    }),
  ).rejects.toMatchObject({ details: { reason: 'daemon_shutting_down' } });
  expect(cleanup).toHaveBeenCalledOnce();
  expect(store.lookup('draft')).toBeUndefined();
  const record = screenRecordingDurableResource.store.read(
    screenRecordingDurableResource.store.resolvePath(draft.binding.sessionDir),
  );
  expect(record).toMatchObject({
    status: 'decoded',
    envelope: {
      lifecycle: 'open',
      descriptor: envelope.descriptor,
      metadata: { phase: 'cleanup-pending' },
    },
  });
  if (record.status !== 'decoded') throw new Error('Expected recovery evidence');
  expect(record.envelope.metadata?.runtimeContractInvalid).toBeUndefined();
});

test('a draft binding retains its latest observed recording after retirement', () => {
  const store = makeSessionStore();
  const session = makeRecordingSession({
    name: 'draft',
    sessionStore: store,
    finish: async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
  });
  const first = session.screenRecording!;
  const latest = makeRecordingSession({
    name: 'draft',
    sessionStore: store,
    finish: async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
  }).screenRecording!;
  const draft = bindRecordOnlyScreenRecording(store, 'draft', {
    ...session,
    screenRecording: undefined,
  });
  draft.binding.adopt(first);
  const ref = draft.requireRef();
  store.update(ref, { screenRecording: latest });
  expect(draft.binding.read()).toBe(latest);
  expect(store.retire(ref)).toBe(true);
  expect(draft.binding.read()).toBe(latest);
  expect(draft.binding.clear(latest)).toBe('retired');
});

test('a published draft cannot create another lifetime after retirement', () => {
  const store = makeSessionStore();
  const session = makeRecordingSession({
    name: 'draft',
    sessionStore: store,
    finish: async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
  });
  const recording = session.screenRecording!;
  const draft = bindRecordOnlyScreenRecording(store, 'draft', {
    ...session,
    screenRecording: undefined,
  });
  draft.binding.adopt(recording);
  const ref = draft.requireRef();
  expect(store.retire(ref)).toBe(true);
  expect(draft.binding.canPersist()).toBe(false);
  expect(() => draft.binding.assertAdoptable()).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'session_lifetime_ended' }),
    }),
  );
  expect(() => draft.binding.adopt(recording)).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'session_lifetime_ended' }),
    }),
  );
  expect(store.lookup('draft')).toBeUndefined();
  expect(draft.requireRef()).toBe(ref);
});
