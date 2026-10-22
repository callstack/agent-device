import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireValidationLock, runLockedCommand, VALIDATION_PARENT_ENV } from './host-lock.ts';

test(
  'host lock excludes a waiter, supports cancellation, then admits it after release',
  { skip: process.platform === 'win32' },
  async () => {
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
    } finally {
      if (parent === undefined) delete process.env[VALIDATION_PARENT_ENV];
      else process.env[VALIDATION_PARENT_ENV] = parent;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'nested validation fails before acquisition',
  { skip: process.platform === 'win32' },
  async () => {
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
  },
);

test('unsupported hosts reject validation before writing lock state', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-unsupported-'));
  const lock = path.join(directory, 'gate.lock');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await assert.rejects(
      acquireValidationLock(new AbortController().signal, lock),
      /requires macOS or Linux/,
    );
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test(
  'a locked command publishes ownership while it runs and clears it when it finishes',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-run-'));
    const lock = path.join(directory, 'gate.lock');
    const activePath = `${lock}.active.json`;
    const env = { ...process.env };
    delete env[VALIDATION_PARENT_ENV];
    try {
      const owner = await acquireValidationLock(new AbortController().signal, lock, () => {}, env);
      const observed: string[] = [];
      const exitCode = await runLockedCommand(
        owner,
        '/fixture/receipt.json',
        [
          process.execPath,
          '-e',
          `process.stdout.write(process.env.${VALIDATION_PARENT_ENV}); process.exit(3)`,
        ],
        {
          cwd: directory,
          env,
          signal: new AbortController().signal,
          onStdoutChunk: (chunk) => {
            const active = JSON.parse(fs.readFileSync(activePath, 'utf8')) as {
              receipt: string;
              pid: number;
              activation: string;
            };
            observed.push(chunk, active.receipt, active.activation);
            assert.ok(active.pid > 0);
          },
          onStderrChunk: () => {},
        },
      );
      assert.equal(exitCode, 3);
      assert.deepEqual(observed, ['/fixture/receipt.json', '/fixture/receipt.json', 'stdin']);
      assert.equal(fs.existsSync(activePath), false);
      await owner.release();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
