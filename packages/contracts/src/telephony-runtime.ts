import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { TelephonyEventInput } from './device-rotation.ts';

/**
 * One simulated telephony event. The owner returns nothing: the emulator console acknowledges the
 * event, and what the app does with the call or message is observed through the next capture.
 */
export type TelephonyRuntimeOperations = Readonly<{
  sendTelephonyEvent(input: TelephonyEventInput): Promise<void>;
}>;

export type TelephonyRuntimeOperationFacts = Readonly<{
  sendTelephonyEvent: RuntimeOperationFact;
}>;

export function telephonyRuntimeOperationFacts(
  input: Readonly<{ telephony: RuntimeOperationFact }>,
): TelephonyRuntimeOperationFacts {
  return Object.freeze({ sendTelephonyEvent: input.telephony });
}
