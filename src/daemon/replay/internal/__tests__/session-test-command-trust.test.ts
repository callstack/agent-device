/**
 * #2663 PR A: the suite command must forward the request-private trust bit to every nested replay.
 * If only the suite handler maps the bit, each Maestro attempt would reconstruct it as trusted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { SessionStore } from '../../../session-store.ts';
import {
  createReplaySession,
  replayDaemonDependencies,
} from '../../../handlers/session-replay-command.ts';
import { runReplayTestCommand } from '../../index.ts';
import type { ReplayCommand, ReplayTestCommand } from '../command-types.ts';
import { replayScriptSourceBundleFor } from '../../../../__tests__/test-utils/replay-script-source.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import type { DaemonInvokeFn, DaemonRequest } from '../../../daemon-request.ts';

const capturedCommands: ReplayCommand[] = [];

vi.mock('../native-command.ts', () => ({
  runReplayCommand: async (command: ReplayCommand) => {
    capturedCommands.push(command);
    return { ok: true as const, data: { replayed: 1 } };
  },
}));

beforeEach(() => {
  capturedCommands.length = 0;
});

async function forwardedCommands(publicNetworkOnly?: true): Promise<readonly ReplayCommand[]> {
  const root = mkdtempForTestSync('agent-device-test-command-trust-');
  const scriptPath = path.join(root, 'flow.ad');
  fs.writeFileSync(scriptPath, 'context platform=ios\nopen "Demo"\n');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const req: DaemonRequest = {
    token: 'token',
    session: 'default',
    command: 'test',
    positionals: [scriptPath],
    flags: {
      platform: 'ios',
      replayScriptSources: [replayScriptSourceBundleFor(scriptPath)],
    },
    meta: { cwd: root, requestId: 'test-command-trust' },
  };
  const command: ReplayTestCommand = {
    request: req,
    session: createReplaySession('default', path.join(root, 'daemon.log'), sessionStore),
    createSession: (sessionName, logPath) =>
      createReplaySession(sessionName, logPath, sessionStore),
    invoke: (async () => ({ ok: true as const, data: {} })) as DaemonInvokeFn,
    dependencies: replayDaemonDependencies,
    cleanupSession: async () => {},
    ...(publicNetworkOnly === undefined ? {} : { publicNetworkOnly }),
  };

  const response = await runReplayTestCommand(command);
  expect(response.ok).toBe(true);
  return capturedCommands;
}

test('test command forwards untrusted replay trust to each attempt', async () => {
  const commands = await forwardedCommands(true);
  expect(commands).toHaveLength(1);
  expect(commands[0]?.publicNetworkOnly).toBe(true);
});

test('test command forwards trusted replay trust to each attempt', async () => {
  const commands = await forwardedCommands();
  expect(commands).toHaveLength(1);
  expect(commands[0]?.publicNetworkOnly).toBeUndefined();
});
