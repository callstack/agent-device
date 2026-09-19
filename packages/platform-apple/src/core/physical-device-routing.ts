import type { DeviceInfo } from '@agent-device/kernel/device';

/**
 * The physical-device routing contract, declared below both sides that need it: the runner's
 * command routing consults exactly this slice through its host port, and
 * `physical-device-control.ts` derives the full {@link IosPhysicalDeviceControl} from it. Keeping
 * it here leaves the runner free of the control module, whose launch and terminate members are
 * typed against the runner's own command executor.
 */
export type IosPhysicalDeviceBackend = 'coredevice' | 'xctest';

/**
 * Only the CoreDevice tunnel address is resolved here. Which transport a runner
 * command uses is decided by the route resolver, which reaches this at all only
 * after usbmux has reported the device unattached.
 */
export type IosPhysicalDeviceTunnel = { tunnelIp: string | null };

export type IosPhysicalDeviceRunnerControl = {
  readonly backend: IosPhysicalDeviceBackend;
  resolveTunnel(device: DeviceInfo, timeoutBudgetMs?: number): Promise<IosPhysicalDeviceTunnel>;
};
