import { vi } from 'vitest';
import type { ApplicationLifecycleRuntimeOperations } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  applicationLifecycleRuntimeFixture,
  type LifecycleOperationsLoader,
} from './application-lifecycle-runtime-fixture.ts';

/**
 * The canned lifecycle port with `finalizeApplicationClose` answered by a spy (an empty result by
 * default) and any other operation replaceable per case. Daemon close tests read the spy to prove
 * the neutral orchestration asked the platform for close finalization, and with which arguments,
 * without encoding how a platform performs it.
 */
export function lifecycleOperationsSpy(
  overrides: Partial<ApplicationLifecycleRuntimeOperations> = {},
) {
  const finalizeApplicationClose = vi.fn<
    ApplicationLifecycleRuntimeOperations['finalizeApplicationClose']
  >(async () => ({}));
  const loader: LifecycleOperationsLoader = async (device, signal, shutdownTarget) =>
    Object.freeze({
      ...(await applicationLifecycleRuntimeFixture(device, signal, shutdownTarget)),
      ...overrides,
      finalizeApplicationClose,
    });
  return { loader, finalizeApplicationClose };
}
