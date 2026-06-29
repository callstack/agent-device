import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchCommand } from '../dispatch.ts';
import { AppError } from '../../kernel/errors.ts';
import { ANDROID_EMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';

test('dispatch push reports missing payload file as INVALID_ARGS', async () => {
  await assert.rejects(
    () => dispatchCommand(ANDROID_EMULATOR, 'push', ['com.example.app', './missing-payload.json']),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INVALID_ARGS');
      assert.match((error as AppError).message, /payload file not found/i);
      return true;
    },
  );
});

test('dispatch push reports directory payload path as INVALID_ARGS', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-dispatch-push-dir-'));
  try {
    await assert.rejects(
      () => dispatchCommand(ANDROID_EMULATOR, 'push', ['com.example.app', tempDir]),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true);
        assert.equal((error as AppError).code, 'INVALID_ARGS');
        assert.match((error as AppError).message, /not a file/i);
        return true;
      },
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('dispatch push prefers existing brace-prefixed payload file over inline parsing', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-dispatch-push-brace-'));
  const adbPath = path.join(tempDir, 'adb');
  const argsLogPath = path.join(tempDir, 'args.log');
  const payloadPath = path.join(tempDir, '{payload}.json');
  await fs.writeFile(
    adbPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(adbPath, 0o755);
  await fs.writeFile(
    payloadPath,
    '{"action":"com.example.app.PUSH","extras":{"title":"Hello"}}\n',
    'utf8',
  );

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tempDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  try {
    const result = await dispatchCommand(ANDROID_EMULATOR, 'push', [
      'com.example.app',
      payloadPath,
    ]);
    assert.deepEqual(result, {
      platform: 'android',
      package: 'com.example.app',
      action: 'com.example.app.PUSH',
      extrasCount: 1,
      message: 'Pushed notification to com.example.app',
    });
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(args.includes('-a'), true);
    assert.equal(args.includes('com.example.app.PUSH'), true);
    assert.equal(args.includes('--es'), true);
    assert.equal(args.includes('title'), true);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
