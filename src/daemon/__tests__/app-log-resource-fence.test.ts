import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { withAppLogResourceFence } from '../app-log-resource-fence.ts';
import {
  readAppLogResourceRecord,
  resolveAppLogResourcePath,
  writeAppLogResourceRecord,
} from '../app-log-resource-store.ts';

test('ownership fence rejects a stale token before the native side effect', async () => {
  const resourcePath = makeRecord();
  const sideEffect = vi.fn(async () => {});
  await expect(
    withAppLogResourceFence({
      resourcePath,
      expected: { token: 'stale', generation: 1 },
      run: sideEffect,
    }),
  ).rejects.toMatchObject({ details: { reason: 'ownership-fence-lost' } });
  expect(sideEffect).not.toHaveBeenCalled();
});

test('ownership fence serializes validation, side effect, and persisted transition', async () => {
  const resourcePath = makeRecord();
  const order: string[] = [];
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = withAppLogResourceFence({
    resourcePath,
    expected: { token: 'current', generation: 1 },
    run: async (lease) => {
      order.push('first-start');
      markFirstStarted();
      await firstReleased;
      lease.transition('open', { metadata: { phase: 'completing' } });
      order.push('first-end');
    },
  });
  const second = withAppLogResourceFence({
    resourcePath,
    expected: { token: 'current', generation: 1 },
    run: async () => {
      order.push('second');
    },
  });
  await firstStarted;
  expect(order).toEqual(['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  expect(order).toEqual(['first-start', 'first-end', 'second']);
  expect(readAppLogResourceRecord(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { phase: 'completing' } },
  });
});

function makeRecord(): string {
  const resourcePath = resolveAppLogResourcePath(
    path.join(mkdtempForTestSync('app-log-fence-'), 'session'),
  );
  writeAppLogResourceRecord(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'app-log',
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
