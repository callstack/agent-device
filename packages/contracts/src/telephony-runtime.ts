import type { TelephonyEventInput } from './device-rotation.ts';

/**
 * One simulated telephony event. The owner returns nothing: the emulator console acknowledges the
 * event, and what the app does with the call or message is observed through the next capture.
 */
export type TelephonyRuntimeOperations = Readonly<{
  sendTelephonyEvent(input: TelephonyEventInput): Promise<void>;
}>;

/**
 * Closed result of the `telephony` command: a discriminated union on `action`. The call actions
 * echo the number; `sms` also reports the length of the text it delivered.
 */
export type TelephonyCommandResult =
  | {
      action: Exclude<TelephonyEventInput['action'], 'sms'>;
      number: string;
      message: string;
    }
  | {
      action: 'sms';
      number: string;
      textLength: number;
      message: string;
    };
