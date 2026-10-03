import type { RequestProgressEvent, RequestProgressSink } from '@agent-device/contracts/progress';

/**
 * Whether streamed `command` progress has already been rendered for the human
 * reader of this CLI run.
 *
 * A command whose final output would repeat what progress already said reads it
 * and prints the shorter form instead (`doctorCliOutput`). The state is handed
 * to the formatter with the result, so a caller that renders progress somewhere
 * else — an SDK or MCP consumer passing its own `RequestProgressSink`, which
 * writes nothing to this process's stderr — is never told progress was rendered
 * here, and gets the full output.
 */
export type CommandProgressState = {
  renderedToStderr: boolean;
};

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
    process.stderr.write(`${event.message}\n`);
  };
}
