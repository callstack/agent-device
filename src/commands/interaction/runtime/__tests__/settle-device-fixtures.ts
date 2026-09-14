// Doubles the `--settle` routes share: the backend whose captures the settle loop
// reads, and the small trees it serves. `settle.test.ts` drives the loop itself and
// `post-action-surface.test.ts` the cross-surface comparison over it, so both read
// these builders from here instead of keeping a private copy.
//
// Budgets are injected (fake clock) — no real waiting.

import type { AgentDeviceBackend, BackendSnapshotResult } from '../../../../backend.ts';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { createLocalArtifactAdapter } from '../../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../../runtime.ts';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';

export function createFakeClock(stepMs = 300): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
} {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += ms > 0 ? ms : stepMs;
    },
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}

export function buttonSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Continue',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: true,
    },
  ]);
}

// Five nodes so a settled capture clears the tiny-tree readiness heuristic.
export function welcomeSnapshot(): SnapshotState {
  return makeSnapshotState(
    ['Welcome!', 'Next', 'Back', 'Home', 'Menu'].map((label, index) => ({
      index,
      depth: index === 0 ? 0 : 1,
      ...(index === 0 ? {} : { parentIndex: 0 }),
      type: index === 0 ? 'StaticText' : 'Button',
      label,
      rect: { x: 10, y: 20 + index * 60, width: 100, height: 40 },
      hittable: true,
    })),
  );
}

export function createSettleDevice(params: {
  stored: SnapshotState;
  captureSnapshot: () => Promise<BackendSnapshotResult> | BackendSnapshotResult;
  tap?: () => Promise<Record<string, unknown>>;
  clock?: ReturnType<typeof createFakeClock>;
  appBundleId?: string;
}): ReturnType<typeof createAgentDevice> {
  return createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => await params.captureSnapshot(),
      tap: async () => (params.tap ? await params.tap() : { ok: true }),
      fill: async () => ({ ok: true }),
      longPress: async () => ({ ok: true }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([
      {
        name: 'default',
        snapshot: params.stored,
        ...(params.appBundleId ? { appBundleId: params.appBundleId } : {}),
      },
    ]),
    policy: localCommandPolicy(),
    clock: params.clock ?? createFakeClock(),
  });
}
