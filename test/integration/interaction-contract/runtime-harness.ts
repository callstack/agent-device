import type { AgentDeviceBackend } from '../../../src/backend.ts';
import type { SnapshotState } from '../../../src/kernel/snapshot.ts';
import { createLocalArtifactAdapter } from '../../../src/io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../src/runtime.ts';

type ContractBackendOverrides = Partial<
  Pick<AgentDeviceBackend, 'captureSnapshot' | 'tap' | 'tapTarget' | 'fill' | 'fillTarget'>
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
      typeText: async () => {},
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
  });
}
