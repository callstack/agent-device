import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('@agent-device/host-kit/command', () => ({
  runCmdStreaming: vi.fn(),
}));

vi.mock('../client/client-react-devtools-companion.ts', () => ({
  ensureReactDevtoolsCompanion: vi.fn(),
  stopReactDevtoolsCompanion: vi.fn(),
}));

import { runCmdStreaming } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import { runReactDevtoolsCommand } from '../cli/commands/react-devtools.ts';

afterEach(() => {
  vi.clearAllMocks();
});

function mockStatusOutput(connectedApps: number): void {
  vi.mocked(runCmdStreaming).mockResolvedValueOnce({
    exitCode: 0,
    stdout: `Daemon: running (port 8097)\nApps: ${connectedApps} connected, 0 components\nUptime: 12s\n`,
    stderr: '',
  });
}

async function captureError(args: string[]): Promise<unknown> {
  try {
    await runReactDevtoolsCommand(args, { cwd: '/tmp/project' });
    return null;
  } catch (error) {
    return error;
  }
}

function passthroughArgs(callIndex: number): string[] {
  const args = vi.mocked(runCmdStreaming).mock.calls[callIndex]?.[1] ?? [];
  return args.slice(args.indexOf('agent-react-devtools') + 1);
}

test('react-devtools errors fails instead of reporting a clean pass with no app attached', async () => {
  mockStatusOutput(0);

  const error = await captureError(['errors']);

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.details?.connectedApps, 0);
  assert.equal(error.details?.subcommand, 'errors');
  assert.match(error.message, /0 apps connected/);
  assert.equal(vi.mocked(runCmdStreaming).mock.calls.length, 1);
  assert.deepEqual(passthroughArgs(0), ['status']);
});

for (const args of [['find', 'Button'], ['count'], ['get', 'tree']]) {
  test(`react-devtools ${args.join(' ')} fails with no app attached`, async () => {
    mockStatusOutput(0);

    const error = await captureError(args);

    assert.ok(error instanceof AppError);
    assert.equal(error.details?.subcommand, args[0]);
  });
}

test('react-devtools errors passes through once an app is attached', async () => {
  mockStatusOutput(1);
  vi.mocked(runCmdStreaming).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

  const exitCode = await runReactDevtoolsCommand(['errors'], { cwd: '/tmp/project' });

  assert.equal(exitCode, 0);
  assert.deepEqual(passthroughArgs(1), ['errors']);
});

test('react-devtools errors fails instead of starting an empty daemon to read', async () => {
  vi.mocked(runCmdStreaming).mockResolvedValueOnce({
    exitCode: 1,
    stdout: 'Daemon is not running\n',
    stderr: '',
  });

  const error = await captureError(['errors']);

  assert.ok(error instanceof AppError);
  assert.match(error.message, /daemon is not running/);
  assert.equal(error.details?.connectedApps, null);
  assert.equal(vi.mocked(runCmdStreaming).mock.calls.length, 1);
});

test('react-devtools errors defers to the passthrough when status reports no app count', async () => {
  vi.mocked(runCmdStreaming).mockResolvedValueOnce({
    exitCode: 0,
    stdout: 'Daemon: running (port 8097)\n',
    stderr: '',
  });
  vi.mocked(runCmdStreaming).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

  const exitCode = await runReactDevtoolsCommand(['errors'], { cwd: '/tmp/project' });

  assert.equal(exitCode, 0);
  assert.deepEqual(passthroughArgs(1), ['errors']);
});

for (const args of [['status'], ['wait', '--connected'], ['start'], ['stop']]) {
  test(`react-devtools ${args.join(' ')} runs without an attachment probe`, async () => {
    vi.mocked(runCmdStreaming).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    await runReactDevtoolsCommand(args, { cwd: '/tmp/project' });

    assert.equal(vi.mocked(runCmdStreaming).mock.calls.length, 1);
    assert.deepEqual(passthroughArgs(0), args);
  });
}
