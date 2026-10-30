import type { AgentDeviceBackend } from '@agent-device/contracts/backend';
import type { CommandClock, CommandSessionRecord } from '@agent-device/contracts/runtime-contract';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { createLocalArtifactAdapter } from '../../../src/io.ts';
import { createCommandSurfaceAgentDevice } from '@agent-device/command-runtime';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import type { CommandSessionStore } from '@agent-device/contracts/runtime-contract';

type ContractBackendOverrides = Partial<
  Pick<
    AgentDeviceBackend,
    | 'captureSnapshot'
    | 'tap'
    | 'tapTarget'
    | 'fill'
    | 'fillTarget'
    | 'performGesture'
    | 'resolveGestureViewport'
  >
> & {
  platform?: AgentDeviceBackend['platform'];
  /**
   * A scenario-owned clock, so a guarantee with a time budget (the moving-target window) can state
   * its timing claim without a wall-clock race. Without one the runtime falls back to real time.
   */
  clock?: CommandClock;
  /**
   * Session state beyond the stored snapshot — the #3471 moving-target baseline is the case that
   * needs it, because the gate's whole premise is a session that has just finished mutating.
   */
  sessionState?: Partial<Omit<CommandSessionRecord, 'name'>>;
};

/**
 * The plain runtime harness for contract scenarios on the paths that never
 * touch the runner: runtime-selector, runtime-ref, native-ref (backend
 * tapTarget/fillTarget present) and coordinate. Path forcing is natural:
 * selector/ref targets pick the runtime path, a `tapTarget`/`fillTarget`
 * backend picks the native-ref fast path, x/y picks the coordinate path.
 */
export function createContractDevice(
  snapshot: SnapshotState,
  overrides: ContractBackendOverrides = {},
): ReturnType<typeof createCommandSurfaceAgentDevice> {
  const records = new Map<string, CommandSessionRecord>([
    ['default', { name: 'default', snapshot, ...overrides.sessionState }],
  ]);
  const sessions: CommandSessionStore = {
    get: (name) => records.get(name),
    set: (record) => {
      records.set(record.name, record);
    },
  };
  return createCommandSurfaceAgentDevice({
    backend: {
      platform: overrides.platform ?? 'ios',
      captureSnapshot: async (...args) =>
        overrides.captureSnapshot ? await overrides.captureSnapshot(...args) : { snapshot },
      tap: async (...args) => await overrides.tap?.(...args),
      tapTarget: overrides.tapTarget,
      fill: async (...args) => await overrides.fill?.(...args),
      fillTarget: overrides.fillTarget,
      performGesture: overrides.performGesture,
      resolveGestureViewport: overrides.resolveGestureViewport,
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions,
    policy: localCommandPolicy(),
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });
}

/**
 * A contract-scenario clock: `now()` reads elapsed virtual time and `sleep()` advances it. A
 * guarantee with a time budget — the #3471 moving-target window — can then assert what it waited
 * without racing the machine it runs on.
 */
export function createContractClock(startMs = 0): {
  now(): number;
  sleep(ms: number): Promise<void>;
} {
  let elapsed = startMs;
  return {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += Math.max(ms, 0);
    },
  };
}

export function ref(
  value: string,
  options: { fallbackLabel?: string } = {},
): import('@agent-device/contracts/interaction').RefTarget {
  return {
    kind: 'ref',
    ref: value,
    ...(options.fallbackLabel ? { fallbackLabel: options.fallbackLabel } : {}),
  };
}
export function selector(
  value: string,
): import('@agent-device/contracts/interaction').SelectorTarget {
  return { kind: 'selector', selector: value };
}
