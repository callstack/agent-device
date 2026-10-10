import type { AgentDeviceBackend } from '@agent-device/contracts/backend';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { createLocalArtifactAdapter } from '../../../src/io.ts';
import { createAgentDevice } from '../../../src/runtime.ts';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { createMemorySessionStore } from '../../../src/command-runtime/runtime-factory.ts';

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
): ReturnType<typeof createAgentDevice> {
  return createAgentDevice({
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
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
  });
}
