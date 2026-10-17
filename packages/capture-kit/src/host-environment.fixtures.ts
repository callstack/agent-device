import { captureHostEnvironment } from '@agent-device/host-kit/process';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

/**
 * The host a capture-kit test hands to code that takes one explicitly: a snapshot of the process
 * as it is when called, so `vi.stubEnv` made earlier in the test reaches it. Test-kit depends on
 * capture-kit, so capture-kit keeps this local.
 */
export function createTestHost(): HostEnvironment {
  return captureHostEnvironment(process);
}
