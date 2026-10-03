import type { CommandFlags } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { validateRecordedInputVariableName } from '@agent-device/ad-script';

export function assertRecordedFillParameterization(params: {
  flags: CommandFlags | undefined;
  replayPlanStep: boolean;
  isSessionRecording: boolean;
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
  if (!params.isSessionRecording && !params.replayPlanStep) {
    throw new AppError(
      'INVALID_ARGS',
      'fill --record-as requires an armed script recording. Start a fresh session with open --save-script, then retry the fill.',
    );
  }
}
