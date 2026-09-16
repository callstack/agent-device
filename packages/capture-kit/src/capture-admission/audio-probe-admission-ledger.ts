import {
  createDurableCaptureAdmissionLedger,
  type DurableCaptureAdmissionLedger,
} from './durable-capture-admission-ledger.ts';

export type AudioProbeAdmissionLedger = DurableCaptureAdmissionLedger;

export function createAudioProbeAdmissionLedger(): AudioProbeAdmissionLedger {
  return createDurableCaptureAdmissionLedger({ displayName: 'audio probe' });
}
