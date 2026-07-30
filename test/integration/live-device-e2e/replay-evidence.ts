import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parseReplayScriptDetailed, readReplayScriptMetadata } from '../../../src/replay/script.ts';

const DEFAULT_REPLAY_TIMEOUT_MS = 90_000;
const HOST_TIMEOUT_MARGIN_MS = 60_000;

export function readReplayCommands(replayPath: string): string[] {
  return parseReplayScriptDetailed(fs.readFileSync(replayPath, 'utf8')).actions.map(
    (action) => action.command,
  );
}

export function assertReplayCommands(
  replayPath: string,
  commands: readonly string[],
  expectedCommands: readonly string[],
): void {
  for (const command of expectedCommands) {
    assert.ok(commands.includes(command), `${replayPath} did not execute ${command}`);
  }
}

export function replayAttemptTimeoutMs(replayPath: string): number {
  return (
    readReplayScriptMetadata(fs.readFileSync(replayPath, 'utf8')).timeoutMs ??
    DEFAULT_REPLAY_TIMEOUT_MS
  );
}

export function replaySuiteHostTimeoutMs(replayPaths: readonly string[], retries: number): number {
  const maximumAttemptTime = replayPaths.reduce(
    (total, replayPath) => total + replayAttemptTimeoutMs(replayPath),
    0,
  );
  return maximumAttemptTime * (retries + 1) + HOST_TIMEOUT_MARGIN_MS;
}
