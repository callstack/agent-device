import { beforeEach, expect, test, vi } from 'vitest';
import type {
  Interactor,
  SnapshotOptions,
  SnapshotResult,
} from '@agent-device/contracts/interactor-types';
import type { SettleObservation } from '@agent-device/contracts/interaction';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { makeIosSession } from '../../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import { contextFromFlags as buildDaemonContext } from '../../../core/context.ts';
import { installInteractorResolution } from '../../../core/interactor-resolution.ts';
import { handleInteractionCommands } from '../index.ts';
import { getRuntimeBindings } from '../../__tests__/interaction-get-runtime-fixture.ts';
import { createTouchCommandSurface } from '../../../__tests__/support/touch-command-surface-fake.ts';

// The settle loop pins `private-ax` on its captures once the observation reports that producer; the
// daemon must carry that preference through its capture path to the interactor, which is what the
// runner request is built from. Where the loop decides to pin is pinned beside it, in
// src/commands/interaction/runtime/settle.test.ts, and how the Apple interactor turns the preference
// into a runner request in packages/platform-apple.

const snapshotCalls: SnapshotOptions[] = [];

const nodes = [
  { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Continue',
    rect: { x: 20, y: 100, width: 120, height: 44 },
    hittable: true,
  },
  ...Array.from({ length: 4 }, (_, offset) => ({
    index: offset + 2,
    parentIndex: 0,
    type: 'Button',
    label: `Action ${offset + 1}`,
    rect: { x: 20, y: 160 + offset * 50, width: 120, height: 44 },
    hittable: true,
  })),
];
const privateAxQuality = {
  state: 'recovered' as const,
  backend: 'private-ax' as const,
  reasonCode: 'requested-backend' as const,
};

installInteractorResolution({
  resolve: async () =>
    ({
      snapshot: vi.fn(async (options: SnapshotOptions): Promise<SnapshotResult> => {
        snapshotCalls.push(options);
        return { nodes, backend: 'xctest', quality: privateAxQuality } as SnapshotResult;
      }),
    }) as unknown as Interactor,
});

beforeEach(() => {
  snapshotCalls.length = 0;
});

/** The pin the settle loop applies: every settle capture asks for `private-ax` once it is established. */
const pinningSurface = createTouchCommandSurface({
  observeSettle: async ({ settle, baselineQuality, capture }): Promise<SettleObservation> => {
    let pinned = baselineQuality?.backend === 'private-ax';
    for (let captures = 0; captures < 3; captures += 1) {
      const settled = await capture(pinned ? { preferredBackend: 'private-ax' } : undefined);
      pinned ||= settled.snapshotQuality?.backend === 'private-ax';
    }
    return {
      settled: true,
      waitedMs: 0,
      captures: 3,
      quietMs: settle.quietMs ?? 500,
      timeoutMs: settle.timeoutMs ?? 10_000,
    };
  },
});

test('daemon press --settle pins private-ax on emitted snapshot runner requests', async () => {
  const sessionName = 'press-settle-private-ax-route';
  const sessionStore = makeSessionStore();
  sessionStore.publish(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.fixture',
      snapshot: makeSnapshotState(nodes, {
        backend: 'xctest',
        snapshotQuality: { ...privateAxQuality, reasonCode: 'deferred' },
      }),
    }),
  );

  const response = await handleInteractionCommands({
    createCommandSurface: pinningSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['label=Continue'],
      flags: { settle: true, settleQuietMs: 25, timeoutMs: 1_000 },
    },
    sessionName,
    sessionStore,
    contextFromFlags: (flags, appBundleId, traceLogPath) =>
      buildDaemonContext('', flags, appBundleId, traceLogPath),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(snapshotCalls.length).toBeGreaterThanOrEqual(3);
  const preferredBackends = snapshotCalls.map((options) => options.preferredBackend);
  expect(preferredBackends).toEqual([
    undefined,
    ...Array.from({ length: preferredBackends.length - 1 }, () => 'private-ax' as const),
  ]);
});
