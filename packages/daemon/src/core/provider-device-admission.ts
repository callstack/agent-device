import { defineRuntimeSlots, type RuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';
import type { DeviceInfo } from '@agent-device/kernel/device';

/**
 * Whether a device is currently owned by a provider runtime (a cloud or remote lease holder)
 * rather than a local simulator or emulator. Callers branch on it for fast paths, foreground
 * reads, and hint policy.
 */
export type ProviderDeviceAdmission = Readonly<{
  isActive(device: DeviceInfo): boolean;
}>;

/**
 * The no-provider state, which is what an un-composed process sees: every device is local.
 * Root composition replaces it through `installProviderDeviceAdmission` before requests run,
 * the same way it installs the other request-scoped runtime capabilities.
 */
const NO_PROVIDER_DEVICE_ADMISSION: ProviderDeviceAdmission = {
  isActive: () => false,
};

type ProviderAdmissionState = { admission: ProviderDeviceAdmission };

const providerAdmissionRuntime = defineRuntimeSlots();
const PROVIDER_ADMISSION_SLOT = Symbol('providerDeviceAdmission');
const providerAdmissionState = (): ProviderAdmissionState =>
  providerAdmissionRuntime.slot(PROVIDER_ADMISSION_SLOT, (): ProviderAdmissionState => ({
    admission: NO_PROVIDER_DEVICE_ADMISSION,
  }));

/** The admission one daemon runtime owns; the runtime installs its composition's into it. */
export const createProviderDeviceAdmissionRuntimeState = (): RuntimeStateHandle =>
  providerAdmissionRuntime.createHandle();

/**
 * Root composition's installation point. The provider runtime scope is ambient per request, so
 * this is the one place the daemon names where the fact comes from, and the daemon never reads
 * provider runtime internals itself.
 */
export function installProviderDeviceAdmission(admission: ProviderDeviceAdmission): void {
  providerAdmissionState().admission = admission;
}

export function isActiveProviderDevice(device: DeviceInfo): boolean {
  return providerAdmissionState().admission.isActive(device);
}
