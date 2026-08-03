import type { SessionAction } from '@agent-device/contracts/session';

export type ReplayReportAction = {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: SessionAction['flags'];
  readonly result?: SessionAction['result'];
  readonly targetEvidence?: SessionAction['targetEvidence'];
  readonly targetEvidences?: SessionAction['targetEvidences'];
};
