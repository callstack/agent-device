import { expect, test } from 'vitest';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { makeRecordingSession } from './session-teardown.fixtures.ts';
import { bindSessionScreenRecording } from '../session-capture-binding.ts';

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
