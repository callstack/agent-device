import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import * as exec from './exec.ts';
import { readMacosProcesses } from './macos-process.ts';

afterEach(() => vi.restoreAllMocks());

test.skipIf(process.platform !== 'darwin')(
  'native query validates requested PID and refuses malformed evidence',
  () => {
    assert.equal(readMacosProcesses([process.pid])[0]?.pid, process.pid);
    const base = {
      pid: process.pid,
      ppid: process.ppid,
      startSeconds: '1700000000',
      startMicros: 123456,
      zombie: false,
      argc: 1,
      argvHex: Buffer.from('node\0').toString('hex'),
    };
    const spy = vi.spyOn(exec, 'runCmdSync');
    for (const changes of [
      { pid: process.pid + 1 },
      { startSeconds: 'NaN' },
      { startMicros: 1_000_000 },
      { argc: 2 },
      { argvHex: 'ff00' },
      { argvHex: 'node' },
      { argvHex: '61'.repeat(32769) },
      { zombie: true },
      { argvHex: '6e6f6465' },
    ]) {
      spy.mockReturnValue({
        stdout: JSON.stringify({ ...base, ...changes }),
        stderr: '',
        exitCode: 0,
      });
      assert.deepEqual(readMacosProcesses([process.pid]), []);
    }
    spy.mockReturnValue({ stdout: '{', stderr: '', exitCode: 0 });
    assert.deepEqual(readMacosProcesses([process.pid]), []);
    spy.mockImplementation(() => {
      throw new Error('access denied');
    });
    assert.deepEqual(readMacosProcesses([process.pid]), []);
  },
);

test('invalid process selectors do not execute native tooling', () => {
  const spy = vi.spyOn(exec, 'runCmdSync');
  for (const pids of [
    [],
    [0],
    [-1],
    [1.1],
    [Number.NaN],
    [Infinity],
    [2_147_483_648],
    Array(1025).fill(1),
  ]) {
    assert.deepEqual(readMacosProcesses(pids), []);
  }
  assert.equal(spy.mock.calls.length, 0);
});

test.skipIf(process.platform !== 'darwin')(
  'cached helper avoids recompilation on repeated ownership checks',
  () => {
    const realRun = exec.runCmdSync;
    const spy = vi.spyOn(exec, 'runCmdSync').mockImplementation(realRun);
    assert.equal(readMacosProcesses([process.pid])[0]?.pid, process.pid);
    spy.mockClear();
    assert.equal(readMacosProcesses([process.pid])[0]?.pid, process.pid);
    assert.equal(spy.mock.calls.length, 1);
    assert.notEqual(spy.mock.calls[0]?.[0], '/usr/bin/clang');
  },
);
