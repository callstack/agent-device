import type { CommandFlags } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { validateRecordedInputVariableName } from '@agent-device/ad-script';

export function assertRecordedFillParameterization(params: {
  flags: CommandFlags | undefined;
  replayPlanStep: boolean;
  isSessionRecording: boolean;
}): void {
  const recordAs = params.flags?.recordAs;
  if (recordAs === undefined) {
    assertStdinFillNotRecordedLiterally(params);
    return;
  }
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

/**
 * Stdin text reaches the daemon as a literal, so an armed recording would publish it verbatim.
 * The caller decides how the step is scripted: `--record-as` publishes `${VAR}`, `--no-record`
 * leaves it out.
 */
function assertStdinFillNotRecordedLiterally(params: {
  flags: CommandFlags | undefined;
  isSessionRecording: boolean;
}): void {
  if (params.flags?.textStdin !== true || params.flags.noRecord) return;
  if (!params.isSessionRecording) return;
  throw new AppError(
    'INVALID_ARGS',
    'fill --text-stdin needs --record-as <VAR> or --no-record while script recording is armed, so the stdin text is not published in the script.',
    { reason: 'fill_text_stdin_unparameterized_recording' },
  );
}
