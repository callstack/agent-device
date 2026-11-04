export const IOS_DEVICE_READY_TIMEOUT_MS = 15_000;
export const IOS_DEVICE_READY_COMMAND_TIMEOUT_BUFFER_MS = 3_000;

export function isCoreDeviceUnreachable(tunnelState: string | undefined): boolean {
  return tunnelState?.toLowerCase() === 'unavailable';
}
