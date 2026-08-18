/**
 * `session-replay.ts` is a routing decision and nothing else: `replay` is one script run, `test` is
 * a suite of them, and any other command belongs to a different handler family. Both arms'
 * orchestration lives in its own module, so what is left to pin here is the routing itself —
 * which arm each command reaches, that the other arm is NOT reached, and that an unrelated command
 * is declined rather than swallowed.
 *
 * Both destinations are mocked, so a wrong edge is observable as the wrong marker rather than as a
 * device-level failure: swapping the two delegations flips the first two cases red.
 */
import { beforeEach, expect, test, vi } from 'vitest';
import path from 'node:path';
import type { DaemonRequest } from '../../types.ts';
import { SessionStore } from '../../session-store.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../session-replay-runtime.ts', () => ({
  runReplayScriptSource: vi.fn(async () => ({ ok: true, data: { reached: 'replay-runtime' } })),
}));

vi.mock('../session-test-suite-command.ts', () => ({
  runReplayTestSuiteCommand: vi.fn(async () => ({ ok: true, data: { reached: 'test-suite' } })),
}));

import { handleSessionReplayCommands } from '../session-replay.ts';
import { runReplayScriptSource } from '../session-replay-runtime.ts';
import { runReplayTestSuiteCommand } from '../session-test-suite-command.ts';

const mockRunReplayScriptSource = vi.mocked(runReplayScriptSource);
const mockRunReplayTestSuiteCommand = vi.mocked(runReplayTestSuiteCommand);

beforeEach(() => {
  mockRunReplayScriptSource.mockClear();
  mockRunReplayTestSuiteCommand.mockClear();
});

function routerParams(command: string) {
  const root = mkdtempForTestSync('agent-device-replay-router-');
  const req: DaemonRequest = {
    token: 'token',
    session: 'default',
    command,
    positionals: [],
    flags: {},
  };
  return {
    req,
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore: new SessionStore(path.join(root, 'sessions')),
    leaseRegistry: new LeaseRegistry(),
    invoke: async () => ({ ok: true as const, data: {} }),
  };
}

test('a replay request routes to the script-source runtime, not the suite command', async () => {
  const params = routerParams('replay');

  const response = await handleSessionReplayCommands(params);

  expect(response).toMatchObject({ ok: true, data: { reached: 'replay-runtime' } });
  expect(mockRunReplayTestSuiteCommand).not.toHaveBeenCalled();
  // The replay arm narrows the params rather than forwarding the suite's own shape.
  expect(mockRunReplayScriptSource).toHaveBeenCalledWith({
    req: params.req,
    sessionName: params.sessionName,
    logPath: params.logPath,
    sessionStore: params.sessionStore,
    invoke: params.invoke,
  });
});

test('a test request routes to the suite command with the whole parameter set', async () => {
  const params = routerParams('test');

  const response = await handleSessionReplayCommands(params);

  expect(response).toMatchObject({ ok: true, data: { reached: 'test-suite' } });
  expect(mockRunReplayScriptSource).not.toHaveBeenCalled();
  // The suite owns video recording, sharding and device binding, so it receives `params` whole —
  // narrowing here is what would silently drop those capabilities.
  expect(mockRunReplayTestSuiteCommand).toHaveBeenCalledWith(params);
});

test('an unrelated command is declined so another handler family can claim it', async () => {
  const response = await handleSessionReplayCommands(routerParams('snapshot'));

  expect(response).toBeNull();
  expect(mockRunReplayScriptSource).not.toHaveBeenCalled();
  expect(mockRunReplayTestSuiteCommand).not.toHaveBeenCalled();
});
