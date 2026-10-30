import type { CommandName } from '@agent-device/command-surface';
import { messageOutput, type CliOutputFormatter } from '../output-common.ts';

// Replay owns a composable warnings channel (`optional` step skips, capture degradations); a run
// that reports success while warnings say otherwise must not render as a bare success line (#2560).
export const replayCliOutputFormatters = {
  replay: messageOutput,
} as const satisfies Partial<Record<CommandName, CliOutputFormatter>>;
