import assert from 'node:assert/strict';

import type { CliJsonResult } from '../cli-json.ts';
import {
  assertReplayCommands,
  readReplayCommands,
  replayAttemptTimeoutMs,
} from './replay-evidence.ts';

type SelectorRouteReplayStep<Context> = (
  context: Context,
  step: string,
  args: string[],
  options?: {
    allowFailure?: boolean;
    commonFlags?: boolean;
    expectFailure?: boolean;
    timeoutMs?: number;
  },
) => Promise<CliJsonResult>;

export async function assertSelectorRouteReplay<
  Context extends { artifactDir: string; session: string; sessionOpen: boolean },
>(
  context: Context,
  replayPath: string,
  runStep: SelectorRouteReplayStep<Context>,
  options: { postReplayCleanup?: { args: string[]; step: string }[] } = {},
): Promise<void> {
  const commands = readReplayCommands(replayPath);
  assertReplayCommands(replayPath, commands, ['get', 'is', 'find', 'click']);
  const daemonTimeoutMs = replayAttemptTimeoutMs(replayPath) + 30_000;

  try {
    const replay = await runStep(
      context,
      'run focused selector-route replay through covered-target diagnosis',
      ['replay', replayPath, '--timeout', String(daemonTimeoutMs)],
      { expectFailure: true, timeoutMs: daemonTimeoutMs + 30_000 },
    );
    assertCoveredTargetDivergence(replay, commands.length);
  } finally {
    const close = await runStep(context, 'close focused selector-route replay session', ['close'], {
      allowFailure: true,
    });
    assert.ok(
      close.status === 0 || close.json?.error?.code === 'SESSION_NOT_FOUND',
      JSON.stringify(close.json),
    );
    context.sessionOpen = false;
    for (const cleanup of options.postReplayCleanup ?? []) {
      await runStep(context, cleanup.step, cleanup.args, { commonFlags: false });
    }
  }
}

function assertCoveredTargetDivergence(replay: CliJsonResult, expectedStep: number): void {
  const error = replay.json?.error;
  const divergence = error?.details?.divergence;
  assert.equal(error?.code, 'REPLAY_DIVERGENCE', JSON.stringify(replay.json));
  assert.equal(divergence?.kind, 'action-failure', JSON.stringify(divergence));
  assert.equal(divergence?.step?.index, expectedStep, JSON.stringify(divergence));
  assert.match(String(divergence?.action), /click.*(?:gearshape\.fill|field-name)/);
  assert.equal(divergence?.cause?.code, 'COMMAND_FAILED', JSON.stringify(divergence));
  assert.match(String(divergence?.cause?.message), /covered by another visible element/);
}
