import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { acquireValidationLock, VALIDATION_PARENT_ENV } from './host-lock.ts';

test('host lock excludes a waiter, supports cancellation, then admits it after release', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-lock-'));
  const lock = path.join(directory, 'gate.lock');
  const parent = process.env[VALIDATION_PARENT_ENV];
  delete process.env[VALIDATION_PARENT_ENV];
  const controller = new AbortController();
  try {
    const owner = await acquireValidationLock(controller.signal, lock);
    const waiting = acquireValidationLock(controller.signal, lock, (message) => {
      assert.match(message, /wait.*host validation/);
      controller.abort();
    });
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.ok(fs.existsSync(lock), 'cancelled waiter must not release the owner');
    owner.recordCommand('/fixture/receipt.json', null);
    assert.ok(fs.existsSync(`${lock}.active.json`));
    await owner.finishCommand(undefined);
    assert.equal(fs.existsSync(`${lock}.active.json`), false);
    await owner.release();
    const second = await acquireValidationLock(new AbortController().signal, lock);
    await second.release();
    assert.equal(fs.existsSync(lock), false);
    // A Windows orphan has a live PID, but no POSIX process group.
    fs.writeFileSync(
      `${lock}.active.json`,
      JSON.stringify({
        pid: process.pid,
        startTime: null,
        activation: 'stdin',
        receipt: '/orphan/receipt.json',
      }),
    );
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const kill = process.kill.bind(process);
    const probe = mock.method(process, 'kill', (pid: number, signal?: number | NodeJS.Signals) => {
      if (pid < 0) throw Object.assign(new Error('no process groups'), { code: 'ESRCH' });
      return kill(pid, signal);
    });
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const orphanWaiter = new AbortController();
      await assert.rejects(
        acquireValidationLock(orphanWaiter.signal, lock, (message) => {
          assert.match(message, /orphan validation group/);
          orphanWaiter.abort();
        }),
        { name: 'AbortError' },
      );
    } finally {
      Object.defineProperty(process, 'platform', platform);
      probe.mock.restore();
    }
  } finally {
    if (parent === undefined) delete process.env[VALIDATION_PARENT_ENV];
    else process.env[VALIDATION_PARENT_ENV] = parent;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('nested validation fails before acquisition', async () => {
  const parent = process.env[VALIDATION_PARENT_ENV];
  process.env[VALIDATION_PARENT_ENV] = '/parent/receipt.json';
  try {
    await assert.rejects(
      acquireValidationLock(new AbortController().signal),
      /Nested validation.*parent\/receipt/,
    );
  } finally {
    if (parent === undefined) delete process.env[VALIDATION_PARENT_ENV];
    else process.env[VALIDATION_PARENT_ENV] = parent;
  }
});

test('Windows cancellation confirms the tree or preserves a blocking marker', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-windows-'));
  const lock = path.join(directory, 'gate.lock');
  const parent = process.env[VALIDATION_PARENT_ENV];
  delete process.env[VALIDATION_PARENT_ENV];
  const owner = await acquireValidationLock(new AbortController().signal, lock);
  owner.recordCommand('/fixture/receipt.json', process.pid);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let exitCode = 1;
  const spawn = mock.method(childProcess, 'spawnSync', (command: string, args: string[]) => {
    assert.equal(command, 'taskkill.exe');
    assert.deepEqual(args, ['/PID', String(process.pid), '/T', '/F']);
    return { status: exitCode, stdout: '', stderr: '' };
  });
  syncBuiltinESMExports();
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    owner.cancelCommand(process.pid);
    await assert.rejects(owner.finishCommand(undefined), /Cannot verify.*termination/);
    await owner.release();
    await assert.rejects(
      acquireValidationLock(new AbortController().signal, lock),
      /Cannot verify.*termination/,
    );
    assert.ok(fs.existsSync(`${lock}.active.json`));
    exitCode = 0;
    owner.cancelCommand(process.pid);
    await owner.finishCommand(undefined);
    assert.equal(fs.existsSync(`${lock}.active.json`), false);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    spawn.mock.restore();
    syncBuiltinESMExports();
    await owner.release();
    if (parent === undefined) delete process.env[VALIDATION_PARENT_ENV];
    else process.env[VALIDATION_PARENT_ENV] = parent;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
