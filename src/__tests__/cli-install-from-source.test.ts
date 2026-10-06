import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { AgentDeviceClient } from '../agent-device-client.ts';
import { tryRunClientBackedCommand } from '../cli/commands/router.ts';

const REACHED_CLIENT = new Error('reached the client');

async function runInstallFromSource(source: string) {
  const client = {
    apps: {
      installFromSource: async () => {
        throw REACHED_CLIENT;
      },
    },
  } as unknown as AgentDeviceClient;
  return await tryRunClientBackedCommand({
    command: 'install-from-source',
    positionals: [source],
    flags: { json: false, help: false, version: false },
    client,
  });
}

test('install-from-source refuses a local path with a typed error', async () => {
  await assert.rejects(
    () => runInstallFromSource('/abs/path/app.zip'),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'install-from-source <url> must be an http(s) URL: /abs/path/app.zip' &&
      String(error.details?.hint).includes('install <app> <path>'),
  );
});

for (const source of [
  'http://',
  'https://',
  'http://exa mple.com/app.zip',
  'ftp://example.com/app.zip',
  'example.com/app.zip',
]) {
  test(`install-from-source refuses ${JSON.stringify(source)} before any work`, async () => {
    await assert.rejects(
      () => runInstallFromSource(source),
      (error) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        String(error.details?.hint).includes('install <app> <path>'),
    );
  });
}

test('install-from-source passes an http(s) URL to the client', async () => {
  await assert.rejects(
    () => runInstallFromSource('HTTPS://example.com/app.zip'),
    (error) => error === REACHED_CLIENT,
  );
});
