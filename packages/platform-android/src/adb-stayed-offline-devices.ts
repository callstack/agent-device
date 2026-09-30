/** Devices, keyed by adb server and serial, that stayed offline through a wait for the device. */
export type StayedOfflineDevices = Readonly<{
  /** Whether the device's refusals still surface without another wait. */
  has(device: string): boolean;
  /** Records that the device stayed offline, and drops every mark that has lapsed. */
  mark(device: string): void;
  forget(device: string): void;
}>;

export function createStayedOfflineDevices(
  windowMs: number,
  expiries = new Map<string, number>(),
): StayedOfflineDevices {
  return {
    has: (device) => (expiries.get(device) ?? 0) > Date.now(),
    mark: (device) => {
      const now = Date.now();
      for (const [key, expiresAt] of expiries) {
        if (expiresAt <= now) expiries.delete(key);
      }
      expiries.set(device, now + windowMs);
    },
    forget: (device) => {
      expiries.delete(device);
    },
  };
}
