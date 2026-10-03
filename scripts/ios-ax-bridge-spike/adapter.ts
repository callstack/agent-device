import type { CandidateId, ResourceLimits, SpikeRequest, SpikeResponse } from './types.ts';

export type AcquisitionAdapter = Readonly<{
  candidate: CandidateId;
  acquireBatch(
    requests: readonly SpikeRequest[],
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<{ responses: readonly SpikeResponse[]; stderr: string }>>;
  close?: () => Promise<void>;
  evidence?: Readonly<{ terminateReaderOnNextBatch?: () => void }>;
}>;

export type AdapterOptions = Readonly<{
  limits?: ResourceLimits;
  guestBridge?: string;
}>;
