import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { buildBrowserStackCapabilities, uploadBrowserStackApp } from './browserstack.ts';

/**
 * BrowserStack resolves a payload carrying both legacy JSONWP keys and `bstack:options` as JSONWP,
 * and drops the vendor block without erroring. The hub accepts the request either way, so only an
 * explicit absence assertion keeps the regression from returning silently.
 */
const LEGACY_JSONWP_KEYS = ['device', 'os_version', 'app'] as const;

test('BrowserStack capabilities stay W3C so bstack:options survives the hub', () => {
  const capabilities = buildBrowserStackCapabilities({
    deviceName: 'Google Pixel 8',
    osVersion: '14.0',
    app: 'bs://app-id',
    projectName: 'agent-device',
    buildName: 'run-a',
    sessionName: 'lease-a',
    deviceFeatures: { timezone: 'New_York' },
    configured: { platformName: 'Android', 'appium:deviceName': 'Google Pixel 8' },
  });

  assert.deepEqual(capabilities, {
    platformName: 'Android',
    'appium:deviceName': 'Google Pixel 8',
    'appium:platformVersion': '14.0',
    'appium:app': 'bs://app-id',
    'bstack:options': {
      projectName: 'agent-device',
      buildName: 'run-a',
      sessionName: 'lease-a',
      timezone: 'New_York',
    },
  });

  for (const key of LEGACY_JSONWP_KEYS) {
    assert.ok(!(key in capabilities), `legacy JSONWP key "${key}" must not be emitted`);
  }
});

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('BrowserStack upload aborts while the provider request is in flight', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-browserstack-upload-'));
  const appPath = path.join(tempDir, 'App.apk');
  const controller = new AbortController();
  const abortReason = new Error('request cancelled during BrowserStack upload');
  try {
    await fs.writeFile(appPath, 'placeholder');
    globalThis.fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        assert.equal(init?.signal, controller.signal);
        if (init?.signal?.aborted) {
          reject(init.signal.reason);
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });

    const pending = uploadBrowserStackApp(
      appPath,
      {
        clientVersion: '0.0.0-test',
        username: 'user',
        accessKey: 'key',
      },
      controller.signal,
    );
    await Promise.resolve();
    controller.abort(abortReason);

    await assert.rejects(pending, (error: unknown) => error === abortReason);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
