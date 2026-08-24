/**
 * The deterministic device-selection evidence shared by daemon responses and
 * the published client surface.
 */
export type DeviceSelectionReason =
  | 'explicit-selector'
  | 'existing-session'
  | 'single-booted-local'
  | 'single-bootable-local'
  | 'preferred-local'
  | 'single-provider-device';

export type DeviceSelectionSource = 'session' | 'local' | 'provider';

export type DeviceSelectionRetrySelector = {
  flag: '--device' | '--serial' | '--udid';
  value: string;
};

export type DeviceSelectionMetadata = {
  reason: DeviceSelectionReason;
  source: DeviceSelectionSource;
  candidateCount: number;
  /** Whether the selected inventory record was already booted at resolution time. */
  booted: boolean;
  /** Whether the selected lifecycle prepared a previously stopped local target. */
  bootOccurred: boolean;
  retrySelectors?: DeviceSelectionRetrySelector[];
};
