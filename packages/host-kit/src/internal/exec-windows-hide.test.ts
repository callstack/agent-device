import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, test, vi } from 'vitest';

type MockChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

import { runCmd, runCmdBackground, runCmdDetached, runCmdSync } from './exec.ts';

beforeEach(() => {
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
});

test('process helpers hide Windows console windows for spawned commands', async () => {
  spawnMock.mockImplementation(() => makeMockChild());
  spawnSyncMock.mockReturnValue({ stdout: '', stderr: '', status: 0 });

  await runCmd('node', ['--version']);
  runCmdSync('node', ['--version']);
  runCmdDetached('node', ['--version']);
  runCmdBackground('node', ['--version']);

  for (const call of spawnMock.mock.calls) {
    assert.equal(call[2]?.windowsHide, true);
  }
  assert.equal(spawnSyncMock.mock.calls[0]?.[2]?.windowsHide, true);
});

function makeMockChild(): ReturnType<typeof import('node:child_process').spawn> {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();

  queueMicrotask(() => {
    child.stdout?.end();
    child.stderr?.end();
    child.emit('close', 0, null);
  });

  return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
}
