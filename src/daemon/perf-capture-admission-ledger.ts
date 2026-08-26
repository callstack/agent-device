import {
  createDurableCaptureAdmissionLedger,
  type DurableCaptureAdmissionLedger,
} from './durable-capture-admission-ledger.ts';

export type PerfCaptureAdmissionLedger = DurableCaptureAdmissionLedger;

export function createPerfCaptureAdmissionLedger(): PerfCaptureAdmissionLedger {
  return createDurableCaptureAdmissionLedger({ displayName: 'perf capture' });
}
