import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createDurableResourceEnvelope } from '../durable-resource-envelope.ts';
import { mkdtempForTestSync } from '../tmp-dir.fixtures.ts';
import {
  withDurableCaptureResourceFence,
  type DurableCaptureOpenResourceFenceLease,
} from './fence.ts';
import { createDurableCaptureResourceStore } from './store.ts';

const store = createDurableCaptureResourceStore({
  resourceKind: 'screen-recording',
  fileName: 'screen-recording.resource.json',
  displayName: 'Screen recording',
});

test('rejects a stale fence before its side effect', async () => {
  const resourcePath = makeRecord();
  const sideEffect = vi.fn(async () => {});
  await expect(
    withDurableCaptureResourceFence({
      store,
      resourcePath,
      expected: { token: 'stale', generation: 1 },
      onCompleted: () => undefined,
      run: sideEffect,
    }),
  ).rejects.toMatchObject({ details: { reason: 'ownership-fence-lost' } });
  expect(sideEffect).not.toHaveBeenCalled();
});

test('serializes validation, native work, and transition for one resource path', async () => {
  const resourcePath = makeRecord();
  const order: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const firstReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withDurableCaptureResourceFence({
    store,
    resourcePath,
    expected: { token: 'current', generation: 1 },
    onCompleted: () => undefined,
    run: async (lease) => {
      order.push('first-start');
      started();
      await firstReleased;
      lease.transition('open', { metadata: { phase: 'completing' } });
      order.push('first-end');
    },
  });
  const second = withDurableCaptureResourceFence({
    store,
    resourcePath,
    expected: { token: 'current', generation: 1 },
    onCompleted: () => undefined,
    run: async () => {
      order.push('second');
    },
  });
  await firstStarted;
  expect(order).toEqual(['first-start']);
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(['first-start', 'first-end', 'second']);
  expect(store.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { metadata: { phase: 'completing' } },
  });
});

/**
 * A caller that captured the same live resource presents the same fence, so serialization alone lets
 * it drive a record its predecessor already committed. Both facts here have to hold: the caller that
 * arrives second is answered without a lease, and the record stays as its predecessor left it.
 */
test('a caller holding the same fence cannot write a record an earlier caller committed', async () => {
  const resourcePath = makeRecord();
  let release!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const firstHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withDurableCaptureResourceFence({
    store,
    resourcePath,
    expected: { token: 'current', generation: 1 },
    onCompleted: () => undefined,
    run: async (lease) => {
      lease.transition('completed', { metadata: { phase: 'completed' } });
      started();
      // Holds the fence, and the record its run committed, until the second caller is queued.
      await firstHeld;
    },
  });
  const late = vi.fn(async () => undefined);
  const second = withDurableCaptureResourceFence({
    store,
    resourcePath,
    expected: { token: 'current', generation: 1 },
    onCompleted: (lease) => lease.envelope.metadata?.phase,
    run: late,
  });
  await firstStarted;
  release();
  expect(await second).toBe('completed');
  await first;
  expect(late).not.toHaveBeenCalled();
  expect(store.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
});

/**
 * A progress port its own run kept holding outlives that run, and a later run commits the record it
 * was issued against. Two leases, not two transitions on one lease: the escaped one must be dead the
 * moment its own run ends, or its cached `open` view overwrites what the later run committed.
 */
test('a lease that outlived its run cannot write a record a later run committed', async () => {
  const resourcePath = makeRecord();
  let escape!: DurableCaptureOpenResourceFenceLease<'screen-recording'>;
  await withDurableCaptureResourceFence({
    store,
    resourcePath,
    expected: { token: 'current', generation: 1 },
    onCompleted: () => undefined,
    run: async (lease) => {
      escape = lease;
    },
  });

  await withDurableCaptureResourceFence({
    store,
    resourcePath,
    expected: { token: 'current', generation: 1 },
    onCompleted: () => undefined,
    run: async (lease) => {
      lease.transition('completed', { metadata: { phase: 'completed' } });
    },
  });

  expect(() => escape.transition('open', { metadata: { phase: 'completing' } })).toThrow();
  expect(store.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
});

/**
 * The reviewer's probe: an escaped lease invoked while the committing run still holds the fence. Its
 * cached `open` view must not publish, or the manifest that run just committed is overwritten.
 */
test('an escaped lease cannot overwrite the record the committing run is writing', async () => {
  const resourcePath = makeRecord();
  let escape!: DurableCaptureOpenResourceFenceLease<'screen-recording'>;
  await withDurableCaptureResourceFence({
    store,
    resourcePath,
    expected: { token: 'current', generation: 1 },
    onCompleted: () => undefined,
    run: async (lease) => {
      escape = lease;
    },
  });

  let escapeWrite: unknown;
  await withDurableCaptureResourceFence({
    store,
    resourcePath,
    expected: { token: 'current', generation: 1 },
    onCompleted: () => undefined,
    run: async (lease) => {
      lease.transition('completed', { metadata: { phase: 'completed' } });
      // The escaped lease is invoked with the committed record already published.
      try {
        escape.transition('open', { metadata: { phase: 'completing' } });
        escapeWrite = 'published';
      } catch (error) {
        escapeWrite = error;
      }
    },
  });

  expect(escapeWrite).toMatchObject({ details: { reason: 'resource-already-completed' } });
  expect(store.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
});

/** A stop's progress port writes into the record it holds. A commit ends what it may still write. */
test('a progress write that reaches a committed record cannot reopen it', async () => {
  const resourcePath = makeRecord();
  let late!: () => void;
  const held = new Promise<void>((resolve) => {
    late = resolve;
  });
  const first = withDurableCaptureResourceFence({
    store,
    resourcePath,
    expected: { token: 'current', generation: 1 },
    onCompleted: () => undefined,
    run: async (lease) => {
      lease.transition('completed', { metadata: { phase: 'completed' } });
      late();
      // The stop's own progress port, driven after its record already committed.
      lease.transition('open', { metadata: { phase: 'completing' } });
    },
  });
  await held;
  await expect(first).rejects.toMatchObject({ details: { reason: 'resource-already-completed' } });
  expect(store.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
});

function makeRecord(): string {
  const resourcePath = store.resolvePath(
    path.join(mkdtempForTestSync('capture-fence-'), 'session'),
  );
  store.write(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: 'session',
      device: { id: 'emulator-5554', family: 'android', kind: 'emulator' },
      owner: localRuntimeOwner('android'),
      fence: { token: 'current', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: {} },
    }),
  );
  return resourcePath;
}
