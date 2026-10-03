import {
  createDurableCaptureAdmissionLedger,
  type DurableCaptureAdmissionLedger,
} from './durable-capture-admission-ledger.ts';

export type ScreenRecordingAdmissionLedger = DurableCaptureAdmissionLedger;

export function createScreenRecordingAdmissionLedger(): ScreenRecordingAdmissionLedger {
  return createDurableCaptureAdmissionLedger({ displayName: 'screen recording' });
}
