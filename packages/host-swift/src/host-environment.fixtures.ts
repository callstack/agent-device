import { captureHostEnvironment } from '@agent-device/host-kit/environment';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

/**
 * The host a host-swift test hands to code that takes one explicitly: a snapshot of the process
 * as it is when called, so `vi.stubEnv` made earlier in the test reaches it. Test-kit depends on
 * capture-kit, which depends on this package, so this package keeps this local.
 */
export function createTestHost(): HostEnvironment {
  return captureHostEnvironment(process);
}
