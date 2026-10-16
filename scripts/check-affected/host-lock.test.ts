import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireValidationLock, VALIDATION_PARENT_ENV } from './host-lock.ts';

test('host lock excludes a waiter, supports cancellation, then admits it after release', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-lock-'));
  const lock = path.join(directory, 'gate.lock');
  const parent = process.env[VALIDATION_PARENT_ENV];
  delete process.env[VALIDATION_PARENT_ENV];
  const controller = new AbortController();
  try {
    const release = await acquireValidationLock(controller.signal, lock);
    const waiting = acquireValidationLock(controller.signal, lock, (message) => {
      assert.match(message, /wait.*host validation/);
      controller.abort();
    });
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.ok(fs.existsSync(lock), 'cancelled waiter must not release the owner');
    await release();
    const second = await acquireValidationLock(new AbortController().signal, lock);
    await second();
    assert.equal(fs.existsSync(lock), false);
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
