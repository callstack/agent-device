import type { CommandFlags } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { validateRecordedInputVariableName } from '../../replay/recorded-input.ts';
import type { SessionState } from '../types.ts';
import { isSessionRecording } from '../session-script-publication-capability.ts';

export function assertRecordedFillParameterization(params: {
  session: SessionState;
  flags: CommandFlags | undefined;
  replayPlanStep: boolean;
}): void {
  const recordAs = params.flags?.recordAs;
  if (recordAs === undefined) return;
  validateRecordedInputVariableName(recordAs);
  if (params.flags?.noRecord) {
    throw new AppError(
      'INVALID_ARGS',
      'fill --record-as cannot be combined with --no-record because no script step would be published.',
    );
  }
  if (!isSessionRecording(params.session) && !params.replayPlanStep) {
    throw new AppError(
      'INVALID_ARGS',
      'fill --record-as requires an armed script recording. Start a fresh session with open --save-script, then retry the fill.',
    );
  }
}
