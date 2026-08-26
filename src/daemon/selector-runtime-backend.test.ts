import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type {
  CaptureSnapshotInput,
  SnapshotResult,
} from '@agent-device/contracts/snapshot-runtime';
import { createSelectorRuntimeForDevice } from './selector-runtime-backend.ts';
import { SessionStore } from './session-store.ts';
import type { SessionState } from './types.ts';
import { mkdtempForTestSync } from '../__tests__/test-utils/tmp-dir.ts';
import { makeSnapshotState } from '../__tests__/test-utils/snapshot-builders.ts';

const device: SessionState['device'] = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone Simulator',
  kind: 'simulator',
  booted: true,
};

test('wait text passes its poll deadline signal to the Apple runner fast path', async () => {
  const sessionName = 'ios-wait-deadline';
  const sessionStore = new SessionStore(
    path.join(mkdtempForTestSync('selector-runtime-'), 'sessions'),
  );
  const session: SessionState = {
    name: sessionName,
    device,
    appBundleId: 'com.example.fixture',
    createdAt: Date.now(),
    actions: [],
  };
  sessionStore.set(sessionName, session);
  let observedSignal: AbortSignal | undefined;
  // R35: every selector runtime is bound, so the poll deadline must reach the platform through
  // the bound capture's per-capture signal — the seam the runner used to be reached through.
  const capture = vi.fn(
    async (input: CaptureSnapshotInput): Promise<SnapshotResult> =>
      await new Promise((resolve) => {
        observedSignal = input.signal;
        if (input.signal?.aborted) {
          resolve({ backend: 'xctest', producer: 'apple-runner', nodes: [] });
          return;
        }
        input.signal?.addEventListener(
          'abort',
          () => resolve({ backend: 'xctest', producer: 'apple-runner', nodes: [] }),
          {
            once: true,
          },
        );
      }),
  );
  const runtime = createSelectorRuntimeForDevice({
    req: {
      token: 't',
      session: sessionName,
      command: 'wait',
      positionals: ['Never appears', '10'],
      flags: {},
    },
    sessionName,
    sessionStore,
    session,
    device,
    bound: { capture },
  });

  await expect(
    runtime.selectors.waitForText('Never appears', { session: sessionName, timeoutMs: 10 }),
  ).rejects.toThrow(/timed out/i);
  expect(observedSignal).toBeDefined();
  expect(observedSignal?.aborted).toBe(true);
});

test('daemon wait stable pins private-ax on emitted snapshot runner requests', async () => {
  const sessionName = 'ios-wait-stable-private-ax';
  const sessionStore = new SessionStore(
    path.join(mkdtempForTestSync('selector-runtime-'), 'sessions'),
  );
  const nodes = [
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
    ...Array.from({ length: 5 }, (_, offset) => ({
      index: offset + 1,
      parentIndex: 0,
      type: 'Button',
      label: `Action ${offset + 1}`,
      rect: { x: 20, y: 100 + offset * 50, width: 120, height: 44 },
      hittable: true,
    })),
  ];
  const snapshot = makeSnapshotState(nodes, {
    snapshotQuality: { state: 'recovered', backend: 'private-ax', reasonCode: 'deferred' },
  });
  const session: SessionState = {
    name: sessionName,
    device,
    appBundleId: 'com.example.fixture',
    createdAt: Date.now(),
    actions: [],
    snapshot,
  };
  sessionStore.set(sessionName, session);
  const capture = vi.fn(async (_input: CaptureSnapshotInput): Promise<SnapshotResult> => ({
    backend: 'xctest',
    producer: 'apple-runner',
    nodes,
    quality: {
      state: 'recovered',
      backend: 'private-ax',
      reasonCode: 'requested-backend',
    },
  }));
  const runtime = createSelectorRuntimeForDevice({
    req: {
      token: 't',
      session: sessionName,
      command: 'wait',
      positionals: ['stable', '25', '1000'],
      flags: {},
    },
    sessionName,
    sessionStore,
    session,
    device,
    bound: { capture },
  });

  await runtime.selectors.wait({
    session: sessionName,
    target: { kind: 'stable', quietMs: 25, timeoutMs: 1_000 },
  });

  expect(capture.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(
    capture.mock.calls.every(([input]) => input.options?.preferredBackend === 'private-ax'),
  ).toBe(true);
});
