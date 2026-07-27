// Parser fuzz lane's mapping onto the shared scheduled-lane envelope (#1414, #1430).
//
// The shape lives in scripts/scheduled-lane/envelope.ts so freshness/health monitoring reads one
// envelope contract across lanes; this module only supplies the fuzz-specific `details` payload
// and guarantees an envelope exists for *every* terminal path — pass, fail, or self-check.

import {
  buildLaneEnvelope,
  type LaneEnvelope,
  writeLaneEnvelope,
} from '../scheduled-lane/envelope.ts';
import type { FuzzFailure } from './invariant.ts';

const LANE = 'parser-fuzz';
const TOOL = 'scripts/fuzz/run.ts';

export type FuzzTargetRun = {
  target: string;
  cases: number;
  failures: number;
  durationMs: number;
};

export type FuzzRunMode = 'generate' | 'replay-corpus' | 'replay-artifact' | 'self-check';

export type FuzzEnvelopeDetails = {
  mode: FuzzRunMode;
  corpusEntries: number;
  targetRuns: FuzzTargetRun[];
  failures: (FuzzFailure & { artifact?: string })[];
  reproCommands: string[];
};

export type FuzzRunEnvelope = LaneEnvelope<FuzzEnvelopeDetails>;

/** Writes the envelope for one fuzz run into `artifactDir`; returns its path. */
export function writeFuzzEnvelope(input: {
  artifactDir: string;
  startedAt: number;
  finishedAt: number;
  result: FuzzRunEnvelope['result'];
  config: Record<string, unknown>;
  details: FuzzEnvelopeDetails;
}): string {
  return writeLaneEnvelope(
    input.artifactDir,
    buildLaneEnvelope({
      lane: LANE,
      tool: TOOL,
      result: input.result,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      config: { mode: input.details.mode, ...input.config },
      details: input.details,
    }),
  );
}
