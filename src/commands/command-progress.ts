import type { CommandProgressState } from '@agent-device/command-output';
import type { RequestProgressEvent, RequestProgressSink } from '@agent-device/contracts/progress';
import { escapeTerminalText } from '@agent-device/kernel/success-text';

export function createCommandProgressState(): CommandProgressState {
  return { renderedToStderr: false };
}

/**
 * The CLI's own progress sink: `command` progress lines go to stderr as they
 * arrive, and `state` records that they did. Other event types belong to their
 * own reporters (replay-test) and are not rendered here.
 */
export function createStderrCommandProgressSink(state: CommandProgressState): RequestProgressSink {
  return (event: RequestProgressEvent) => {
    if (event.type !== 'command') return;
    state.renderedToStderr = true;
    // Escaped like every CLI write, since a progress message can name a value a device chose.
    process.stderr.write(escapeTerminalText(`${event.message}\n`));
  };
}
