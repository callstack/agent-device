import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('../cli/commands/web.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/commands/web.ts')>();
  return { ...actual, runWebCommand: vi.fn(async () => 0) };
});

import { runCli } from '../cli.ts';
import { runWebCommand } from '../cli/commands/web.ts';
import { installIsolatedCliTestEnv } from './cli-test-env.ts';
import { resolveDaemonPaths } from '../daemon/config.ts';
import type { DaemonResponse } from '../daemon/client/daemon-client.ts';

afterEach(() => {
  vi.clearAllMocks();
});

function installExitSpy(): { calls: number[]; restore: () => void } {
  const originalExit = process.exit;
  const calls: number[] = [];
  (process as any).exit = ((code?: number) => {
    calls.push(code ?? 0);
  }) as typeof process.exit;
  return { calls, restore: () => (process.exit = originalExit) };
}

class ProcessExitSentinel extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

// `parseCliInputOrExit`'s early-exit branches run before `runCli`'s own
// try/catch, so — unlike `installExitSpy` above — the mock here must behave
// like a real `process.exit()` and actually stop execution (by throwing),
// or the function falls through past its `return exitAfterFlush(...)` into
// code that assumes a command was parsed.
function installTerminatingExitSpy(): { restore: () => void } {
  const originalExit = process.exit;
  (process as any).exit = ((code?: number) => {
    throw new ProcessExitSentinel(code ?? 0);
  }) as typeof process.exit;
  return { restore: () => (process.exit = originalExit) };
}

async function runCliExpectingExit(
  argv: string[],
  deps: { sendToDaemon: (...args: any[]) => Promise<DaemonResponse> },
): Promise<number> {
  try {
    await runCli(argv, deps as any);
  } catch (error) {
    if (error instanceof ProcessExitSentinel) return error.code;
    throw error;
  }
  throw new Error('expected runCli to exit');
}

function captureStdout(): { read: () => string; restore: () => void } {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = '';
  (process.stdout as { write: typeof process.stdout.write }).write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    read: () => captured,
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}

function captureStderr(): { read: () => string; restore: () => void } {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  (process.stderr as { write: typeof process.stderr.write }).write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    read: () => captured,
    restore: () => {
      process.stderr.write = originalWrite;
    },
  };
}

test('--version exits 0 and prints the version, without touching the daemon', async () => {
  const restoreEnv = installIsolatedCliTestEnv();
  const exitSpy = installTerminatingExitSpy();
  const stdout = captureStdout();
  const sendToDaemon = async (): Promise<DaemonResponse> => {
    throw new Error('sendToDaemon should not be called for --version');
  };

  let exitCode: number;
  try {
    exitCode = await runCliExpectingExit(['--version'], { sendToDaemon });
  } finally {
    stdout.restore();
    exitSpy.restore();
    restoreEnv();
  }

  assert.equal(exitCode, 0);
  assert.ok(stdout.read().trim().length > 0);
});

test('bare `help` with no target exits 0 and prints usage', async () => {
  const restoreEnv = installIsolatedCliTestEnv();
  const exitSpy = installTerminatingExitSpy();
  const stdout = captureStdout();
  const sendToDaemon = async (): Promise<DaemonResponse> => {
    throw new Error('sendToDaemon should not be called for help');
  };

  let exitCode: number;
  try {
    exitCode = await runCliExpectingExit(['help'], { sendToDaemon });
  } finally {
    stdout.restore();
    exitSpy.restore();
    restoreEnv();
  }

  assert.equal(exitCode, 0);
  assert.ok(stdout.read().includes('agent-device'));
});

test('no command exits 1 and prints usage', async () => {
  const restoreEnv = installIsolatedCliTestEnv();
  const exitSpy = installTerminatingExitSpy();
  const stdout = captureStdout();
  const sendToDaemon = async (): Promise<DaemonResponse> => {
    throw new Error('sendToDaemon should not be called with no command');
  };

  let exitCode: number;
  try {
    exitCode = await runCliExpectingExit([], { sendToDaemon });
  } finally {
    stdout.restore();
    exitSpy.restore();
    restoreEnv();
  }

  assert.equal(exitCode, 1);
  assert.ok(stdout.read().length > 0);
});

test("web command exits with runWebCommand's status code", async () => {
  const restoreEnv = installIsolatedCliTestEnv();
  const exitSpy = installExitSpy();
  const sendToDaemon = async (): Promise<DaemonResponse> => {
    throw new Error('sendToDaemon should not be called for web');
  };
  vi.mocked(runWebCommand).mockResolvedValueOnce(0);

  try {
    await runCli(['web', 'status'], { sendToDaemon });
  } finally {
    exitSpy.restore();
    restoreEnv();
  }

  assert.deepEqual(exitSpy.calls, [0]);
  assert.equal(vi.mocked(runWebCommand).mock.calls.length, 1);
  assert.deepEqual(vi.mocked(runWebCommand).mock.calls[0]?.[0], ['status']);
});

// #1596: printDaemonLogTailOnError's --debug dump must stay bounded even when
// the daemon log itself is large — otherwise the dump risks the same
// process.exit()-truncates-a-pipe-write failure exitAfterFlush exists to fix.
test('a --debug failure caps the daemon-log-tail dump instead of printing it unbounded', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-cli-log-tail-'));
  const stateDir = path.join(tempRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const { logPath } = resolveDaemonPaths(stateDir);

  // 200 lines * 500 bytes = 100,000 bytes: within the existing 200-line cap,
  // but past the 64,000-byte cap this change adds — so only the byte cap can
  // explain the head line being absent from the captured output below.
  const headMarker = 'HEAD_OF_SEEDED_LOG_LINE_0000';
  const tailMarker = 'TAIL_OF_SEEDED_LOG_LINE_0199';
  const lines: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    const marker = i === 0 ? headMarker : i === 199 ? tailMarker : `line-${i}`;
    lines.push(`${marker}-${'x'.repeat(500 - marker.length - 1)}`);
  }
  fs.writeFileSync(logPath, `${lines.join('\n')}\n`);

  const restoreEnv = installIsolatedCliTestEnv();
  const exitSpy = installExitSpy();
  const stderr = captureStderr();
  const sendToDaemon = async (): Promise<DaemonResponse> => ({
    ok: false,
    error: { code: 'SESSION_NOT_FOUND', message: 'No active session' },
  });

  try {
    await runCli(['session', 'list', '--state-dir', stateDir, '--debug'], { sendToDaemon });
  } finally {
    stderr.restore();
    exitSpy.restore();
    restoreEnv();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  assert.deepEqual(exitSpy.calls, [1]);
  const output = stderr.read();
  assert.ok(output.includes('[daemon log]'), 'expected the daemon-log-tail block to be printed');
  assert.ok(output.includes(tailMarker), 'expected the most recent line to survive the byte cap');
  assert.ok(
    !output.includes(headMarker),
    'expected the byte cap to drop the oldest lines, not just the 200-line cap',
  );
});
