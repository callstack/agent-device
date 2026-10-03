import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { AgentDeviceClient } from '../agent-device-client.ts';
import { tryRunClientBackedCommand } from '../cli/commands/router.ts';

test('install-from-source refuses a local path with a typed error', async () => {
  const client = {
    apps: {
      installFromSource: async () => {
        throw new Error('unexpected call');
      },
    },
  } as unknown as AgentDeviceClient;

  await assert.rejects(
    () =>
      tryRunClientBackedCommand({
        command: 'install-from-source',
        positionals: ['/abs/path/app.zip'],
        flags: { json: false, help: false, version: false },
        client,
      }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'install-from-source <url> must be an http(s) URL: /abs/path/app.zip' &&
      String(error.details?.hint).includes('install <app> <path>'),
  );
});
