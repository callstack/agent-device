import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { withDurableCaptureResourceFence } from '../durable-capture-resource-fence.ts';
import { createDurableCaptureResourceStore } from '../durable-capture-resource-store.ts';

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
