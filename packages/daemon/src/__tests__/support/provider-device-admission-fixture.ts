import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { installProviderDeviceAdmission } from '../../core/provider-device-admission.ts';

/**
 * Provider ownership as the daemon consumes it: the `ProviderDeviceAdmission` port over a list
 * of runtime fakes, installed exactly the way root composition installs the real one. Daemon
 * suites flip which devices a provider lease currently owns and assert the daemon's branching
 * on that fact; which runtime module answers for a device is root composition's job, owned by
 * the provider-admission suites under `src/__tests__/daemon-composition/`.
 */
export function providerDeviceAdmissionFixture(runtimes: ProviderDeviceRuntime[] = []) {
  let activeRuntimes = [...runtimes];
  const admission = {
    isActive: (device: DeviceInfo) => activeRuntimes.some((runtime) => runtime.ownsDevice(device)),
  };
  installProviderDeviceAdmission(admission);
  return {
    /** Same semantics as the production ambient scope: replaces the active runtime set. */
    setActive: (next: ProviderDeviceRuntime[]) => {
      activeRuntimes = [...next];
    },
  };
}
