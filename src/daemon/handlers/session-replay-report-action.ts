import type { SessionAction } from '../types.ts';

export type ReplayReportAction = {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: SessionAction['flags'];
  readonly result?: SessionAction['result'];
  readonly targetEvidence?: SessionAction['targetEvidence'];
};
