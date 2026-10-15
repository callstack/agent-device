import { expect, test, vi } from 'vitest';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { ReplaySession, ReplayTestCommand } from './command-types.ts';
import { runReplayTestCommand } from './test-command.ts';

function rejectedTestCommand(flags: CommandFlags) {
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));
  const createSession = vi.fn(() => {
    throw new Error('test must not start a suite attempt when a replay-only flag is rejected');
  });
  const command: ReplayTestCommand = {
    request: {
      token: 'token',
      session: 'default',
      command: 'test',
      positionals: ['/suite/flow.ad'],
      flags,
      meta: { cwd: '/suite' },
    },
    session: { name: 'default', logPath: '/suite/daemon.log' } as unknown as ReplaySession,
    createSession,
    invoke,
    dependencies: {
      resolveSessionScope: () => {
        throw new Error(
          'test must not resolve a session scope when a replay-only flag is rejected',
        );
      },
    },
    cleanupSession: async () => {},
  };
  return { command, invoke, createSession };
}

// ADR 0012 decision 4 (`--from`/`--plan-digest`), decision 6 (`--save-script`/`--force`), and the
// replay-only `--keep-session`: the raw wire refuses them before a suite runs.
test.each([
  { label: '--keep-session', flags: { replayKeepSession: true }, message: /--keep-session/ },
  {
    label: '--from',
    flags: { replayFrom: 2, replayPlanDigest: 'deadbeef' },
    message: /--from/,
  },
  {
    label: '--plan-digest alone',
    flags: { replayPlanDigest: 'deadbeef' },
    message: /--plan-digest/,
  },
  { label: '--save-script', flags: { saveScript: true }, message: /--save-script/ },
  { label: '--force without --save-script', flags: { force: true }, message: /--force/ },
] as const)(
  'test rejects raw $label with INVALID_ARGS before running the suite',
  async ({ flags, message }) => {
    const { command, invoke, createSession } = rejectedTestCommand(flags);

    const response = await runReplayTestCommand(command);

    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(message);
    expect(invoke).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  },
);
