import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { whenAdmitted } from '@agent-device/contracts/platform-runtime';
import type { TelephonyEventInput } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';

import { sendAndroidTelephonyEvent } from './console-event.ts';

const available = Object.freeze({ available: true } as const);

const telephonyKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'telephony simulates calls and SMS through the Android emulator console; a physical device has no console, so place a real call or send a real message to it instead.',
} as const);

/** The emulator console is the only telephony control adb has, so the kind is the whole admission. */
function androidTelephonyFact(device: DeviceInfo): RuntimeOperationFact {
  return device.kind === 'emulator' ? available : telephonyKindUnavailable;
}

/** The telephony cell: `sendTelephonyEvent`. */
export function androidTelephonyFacts(device: DeviceInfo) {
  return Object.freeze({ sendTelephonyEvent: androidTelephonyFact(device) });
}

/** Binds `sendTelephonyEvent` when {@link androidTelephonyFacts} admitted it. */
export function createAndroidTelephonyOperations(params: {
  device: DeviceInfo;
  signal: AbortSignal;
}) {
  const { device, signal } = params;
  return whenAdmitted(androidTelephonyFacts(device).sendTelephonyEvent, () => ({
    sendTelephonyEvent: async (input: TelephonyEventInput) => {
      signal.throwIfAborted();
      await sendAndroidTelephonyEvent(device, input, signal);
    },
  }));
}
