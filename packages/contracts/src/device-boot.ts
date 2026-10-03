import type { DeviceInfo } from '@agent-device/kernel/device';

/**
 * Why a device owner could not name the start of its current boot. `unobserved` covers every
 * answer that establishes nothing — the device is not running, the tool call failed, or its
 * output was unreadable — and keeps the caller's decision binary.
 */
export type DeviceBootObservationFailure = 'unsupported-device' | 'unobserved';

export type DeviceBootObservation =
  | Readonly<{ observed: true; bootedAtMs: number }>
  | Readonly<{ observed: false; reason: DeviceBootObservationFailure }>;

/**
 * When a device's CURRENT boot began, as a host-clock epoch in milliseconds. Owners answer for the
 * device kinds they can actually observe and report `unsupported-device` for every other leaf, so a
 * caller never has to know which family answered.
 *
 * A probe answers a question a caller cannot answer from its own state, so its budget must stay far
 * below the operation it precedes, and an unanswered probe must leave that operation as cautious as
 * it was before the probe existed.
 */
export type DeviceBootObservationService = Readonly<{
  observeBootTimeMs(device: DeviceInfo): Promise<DeviceBootObservation>;
}>;
