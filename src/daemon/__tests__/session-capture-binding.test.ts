import { expect, test, vi } from 'vitest';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { makeRecordingSession } from './session-teardown.fixtures.ts';
import {
  bindSessionScreenRecording,
  bindRecordOnlyScreenRecording,
} from '../session-capture-binding.ts';

import { createScreenRecordingLiveHandle } from '@agent-device/capture-kit';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import {
  adoptStartedScreenRecording,
  screenRecordingDurableResource,
} from '@agent-device/capture-kit/screen-recording-session-resource';

test('adoption owns a vacant slot and retains its adopted handle after retirement', () => {
  const store = makeSessionStore();
  const recorded = makeRecordingSession({
    name: 'capture',
    sessionStore: store,
    finish: async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
  });
  const resource = recorded.screenRecording!;
  const ref = store.publish('capture', { ...recorded, screenRecording: undefined });
  const binding = bindSessionScreenRecording(store, ref);
  expect(binding.canPersist()).toBe(true);
  binding.adopt(resource);
  expect(store.requireCurrent(ref).screenRecording).toBe(resource);
  expect(binding.canPersist()).toBe(false);
  expect(() => binding.adopt(resource)).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'session_resource_changed' }),
    }),
  );
  store.retire(ref);
  const successor = store.publish('capture', {
    ...recorded,
    screenRecording: undefined,
    appName: 'successor',
  });
  expect(binding.read()).toBe(resource);
  expect(binding.clear(resource)).toBe('retired');
  expect(binding.canPersist()).toBe(false);
  expect(() => binding.adopt(resource)).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'session_lifetime_ended' }),
    }),
  );
  expect(store.requireCurrent(successor)).toBe(successor.session);
  expect(store.requireCurrent(successor).screenRecording).toBeUndefined();
});

test('clearing a capture refreshes a rebuilt record without losing its other changes', () => {
  const store = makeSessionStore();
  const session = makeRecordingSession({
    name: 'capture',
    sessionStore: store,
    finish: async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
  });
  const ref = store.publish('capture', session);
  const binding = bindSessionScreenRecording(store, ref);
  const active = binding.read()!;
  store.update(ref, { appName: 'updated', screenRecording: { ...active } });
  expect(binding.clear(active)).toBe('cleared');
  expect(store.requireCurrent(ref)).toMatchObject({
    appName: 'updated',
    screenRecording: undefined,
  });
});

test('clearing an older handle or fence leaves a replacement capture intact', () => {
  const store = makeSessionStore();
  const session = makeRecordingSession({
    name: 'capture',
    sessionStore: store,
    finish: async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
  });
  const ref = store.publish('capture', session);
  const binding = bindSessionScreenRecording(store, ref);
  const active = binding.read()!;
  const replacement = makeRecordingSession({
    name: 'other',
    sessionStore: store,
    finish: async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
  }).screenRecording!;
  const differentHandle = { ...active, handle: replacement.handle };
  store.update(ref, { screenRecording: differentHandle });
  expect(binding.clear(active)).toBe('resource-changed');
  expect(binding.read()).toBe(differentHandle);
  for (const fence of [
    { ...active.envelope.fence, token: 'next' },
    { ...active.envelope.fence, generation: active.envelope.fence.generation + 1 },
  ]) {
    const newerFence = { ...active, envelope: { ...active.envelope, fence } };
    store.update(ref, { screenRecording: newerFence });
    expect(binding.clear(active)).toBe('resource-changed');
    expect(binding.read()).toBe(newerFence);
  }
});

test('a retired binding retains its old resource but cannot write into the next lifetime', () => {
  const store = makeSessionStore();
  const session = makeRecordingSession({
    name: 'capture',
    sessionStore: store,
    finish: async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
  });
  const ref = store.publish('capture', session);
  const binding = bindSessionScreenRecording(store, ref);
  const active = binding.read()!;
  store.retire(ref);
  const successor = store.publish('capture', session);
  expect(binding.read()).toBe(active);
  expect(binding.clear(active)).toBe('retired');
  expect(binding.canPersist()).toBe(false);
  expect(() => binding.adopt(active)).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'session_lifetime_ended' }),
    }),
  );
  expect(store.requireCurrent(successor).screenRecording).toBe(active);
});

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

test('an occupied recording draft is refused before publication', () => {
  const store = makeSessionStore();
  const session = makeRecordingSession({
    name: 'occupied-draft',
    sessionStore: store,
    finish: async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
  });
  const draft = bindRecordOnlyScreenRecording(store, 'occupied-draft', session);
  expect(() => draft.binding.adopt(session.screenRecording!)).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'session_resource_changed' }),
    }),
  );
  expect(store.lookup('occupied-draft')).toBeUndefined();
});
