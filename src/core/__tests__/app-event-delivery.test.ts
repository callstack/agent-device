import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bindAdmittedLocalInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { parseTriggerAppEventArgs, resolveAppEventUrl } from '../app-events.ts';
import { getInteractor } from '../interactors.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  ANDROID_EMULATOR,
  IOS_DEVICE,
  MACOS_DEVICE,
} from '../../__tests__/test-utils/device-fixtures.ts';
import { mkdtempForTest } from '../../__tests__/test-utils/tmp-dir.ts';

/**
 * The composed `trigger-app-event` path as R57 left it: the daemon's own policy resolves the
 * event URL, and the bound `triggerAppEvent` operation opens it through the selected owner's
 * interactor. This helper is the same composition `daemon/app-event-runtime.ts` performs, minus
 * the request plumbing, so these tests keep asserting the real shell invocation the retired
 * `dispatchCommand('trigger-app-event', …)` used to reach.
 */
async function triggerAppEvent(
  device: DeviceInfo,
  positionals: string[],
  options: { appBundleId?: string } = {},
): Promise<{ event: string; eventUrl: string; transport: 'deep-link' }> {
  const { eventName, payload } = parseTriggerAppEventArgs(positionals);
  const eventUrl = resolveAppEventUrl(device, eventName, payload);
  const operations = bindAdmittedLocalInteractorOperations({
    device,
    signal: new AbortController().signal,
    resolveInteractor: async (owned: DeviceInfo, runner) => await getInteractor(owned, runner),
    facts: { triggerAppEvent: { available: true } },
  });
  await operations.triggerAppEvent?.({ eventUrl, options });
  return { event: eventName, eventUrl, transport: 'deep-link' };
}

test('trigger-app-event reports missing URL template as UNSUPPORTED_OPERATION', async () => {
  const previousGlobalTemplate = process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE;
  const previousAndroidTemplate = process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
  delete process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE;
  delete process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;

  try {
    await assert.rejects(
      () => triggerAppEvent(ANDROID_EMULATOR, ['screenshot_taken']),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true);
        assert.equal((error as AppError).code, 'UNSUPPORTED_OPERATION');
        assert.match((error as AppError).message, /No app event URL template configured/i);
        return true;
      },
    );
  } finally {
    if (previousGlobalTemplate === undefined)
      delete process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE;
    else process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE = previousGlobalTemplate;
    if (previousAndroidTemplate === undefined)
      delete process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
    else process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE = previousAndroidTemplate;
  }
});

test('trigger-app-event validates payload JSON', async () => {
  const previousTemplate = process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
  process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE =
    'myapp://agent-device/event?name={event}&payload={payload}';
  try {
    await assert.rejects(
      () => triggerAppEvent(ANDROID_EMULATOR, ['screenshot_taken', '{invalid-json']),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true);
        assert.equal((error as AppError).code, 'INVALID_ARGS');
        assert.match((error as AppError).message, /Invalid trigger-app-event payload JSON/i);
        return true;
      },
    );
  } finally {
    if (previousTemplate === undefined)
      delete process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
    else process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE = previousTemplate;
  }
});

test('trigger-app-event opens deep link with encoded event payload', async () => {
  const tempDir = await mkdtempForTest('agent-device-dispatch-trigger-event-');
  const adbPath = path.join(tempDir, 'adb');
  const argsLogPath = path.join(tempDir, 'args.log');
  await fs.writeFile(
    adbPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(adbPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  const previousTemplate = process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
  process.env.PATH = `${tempDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;
  process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE =
    'myapp://agent-device/event?name={event}&payload={payload}&platform={platform}';

  try {
    const result = await triggerAppEvent(ANDROID_EMULATOR, [
      'screenshot_taken',
      '{"source":"qa","count":2}',
    ]);
    assert.equal(result?.event, 'screenshot_taken');
    assert.equal(result?.transport, 'deep-link');
    const expectedUrl =
      'myapp://agent-device/event?name=screenshot_taken&payload=%7B%22source%22%3A%22qa%22%2C%22count%22%3A2%7D&platform=android';
    assert.equal(result?.eventUrl, expectedUrl);

    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(args.includes('-d'), true);
    assert.equal(args.includes(`'${expectedUrl}'`), true);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    else process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    if (previousTemplate === undefined)
      delete process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
    else process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE = previousTemplate;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('trigger-app-event prefers platform-specific template over global template', async () => {
  const tempDir = await mkdtempForTest('agent-device-dispatch-trigger-template-');
  const adbPath = path.join(tempDir, 'adb');
  const argsLogPath = path.join(tempDir, 'args.log');
  await fs.writeFile(
    adbPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(adbPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  const previousGlobalTemplate = process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE;
  const previousAndroidTemplate = process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
  process.env.PATH = `${tempDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;
  process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE = 'myapp://global?name={event}';
  process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE = 'myapp://android?name={event}';

  try {
    const result = await triggerAppEvent(ANDROID_EMULATOR, ['screenshot_taken']);
    assert.equal(result?.eventUrl, 'myapp://android?name=screenshot_taken');
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    else process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    if (previousGlobalTemplate === undefined)
      delete process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE;
    else process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE = previousGlobalTemplate;
    if (previousAndroidTemplate === undefined)
      delete process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
    else process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE = previousAndroidTemplate;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('trigger-app-event supports iOS device path and prefers iOS template', async () => {
  const tempDir = await mkdtempForTest('agent-device-dispatch-trigger-ios-');
  const xcrunPath = path.join(tempDir, 'xcrun');
  const argsLogPath = path.join(tempDir, 'args.log');
  await fs.writeFile(
    xcrunPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  const previousGlobalTemplate = process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE;
  const previousIosTemplate = process.env.AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE;
  process.env.PATH = `${tempDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;
  process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE = 'myapp://global?name={event}';
  process.env.AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE =
    'myapp://ios?name={event}&payload={payload}';

  try {
    const result = await triggerAppEvent(IOS_DEVICE, ['screenshot_taken', '{"source":"ios"}'], {
      appBundleId: 'com.example.app',
    });
    const expectedUrl = 'myapp://ios?name=screenshot_taken&payload=%7B%22source%22%3A%22ios%22%7D';
    assert.equal(result?.eventUrl, expectedUrl);
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual(args, [
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      'ios-device-1',
      'com.example.app',
      '--payload-url',
      expectedUrl,
    ]);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    else process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    if (previousGlobalTemplate === undefined)
      delete process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE;
    else process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE = previousGlobalTemplate;
    if (previousIosTemplate === undefined)
      delete process.env.AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE;
    else process.env.AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE = previousIosTemplate;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('trigger-app-event supports macOS and prefers macOS template', async () => {
  const tempDir = await mkdtempForTest('agent-device-dispatch-trigger-macos-');
  const openPath = path.join(tempDir, 'open');
  const argsLogPath = path.join(tempDir, 'args.log');
  await fs.writeFile(
    openPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(openPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  const previousGlobalTemplate = process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE;
  const previousMacosTemplate = process.env.AGENT_DEVICE_MACOS_APP_EVENT_URL_TEMPLATE;
  process.env.PATH = `${tempDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;
  process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE = 'myapp://global?name={event}';
  process.env.AGENT_DEVICE_MACOS_APP_EVENT_URL_TEMPLATE =
    'myapp://macos?name={event}&payload={payload}&platform={platform}';

  try {
    const result = await triggerAppEvent(MACOS_DEVICE, [
      'screenshot_taken',
      '{"source":"desktop"}',
    ]);
    const expectedUrl =
      'myapp://macos?name=screenshot_taken&payload=%7B%22source%22%3A%22desktop%22%7D&platform=macos';
    assert.equal(result?.eventUrl, expectedUrl);
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual(args, [expectedUrl]);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    else process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    if (previousGlobalTemplate === undefined)
      delete process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE;
    else process.env.AGENT_DEVICE_APP_EVENT_URL_TEMPLATE = previousGlobalTemplate;
    if (previousMacosTemplate === undefined)
      delete process.env.AGENT_DEVICE_MACOS_APP_EVENT_URL_TEMPLATE;
    else process.env.AGENT_DEVICE_MACOS_APP_EVENT_URL_TEMPLATE = previousMacosTemplate;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('trigger-app-event rejects invalid event names', async () => {
  const previousTemplate = process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
  process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE =
    'myapp://agent-device/event?name={event}';
  try {
    await assert.rejects(
      () => triggerAppEvent(ANDROID_EMULATOR, ['bad event']),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true);
        assert.equal((error as AppError).code, 'INVALID_ARGS');
        assert.match((error as AppError).message, /Invalid trigger-app-event event name/i);
        return true;
      },
    );
  } finally {
    if (previousTemplate === undefined)
      delete process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
    else process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE = previousTemplate;
  }
});

test('trigger-app-event rejects payloads that exceed size limits', async () => {
  const previousTemplate = process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
  process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE =
    'myapp://agent-device/event?name={event}&payload={payload}';
  const oversizedPayload = JSON.stringify({ value: 'x'.repeat(9000) });
  try {
    await assert.rejects(
      () => triggerAppEvent(ANDROID_EMULATOR, ['screenshot_taken', oversizedPayload]),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true);
        assert.equal((error as AppError).code, 'INVALID_ARGS');
        assert.match((error as AppError).message, /exceeds 8192 bytes/i);
        return true;
      },
    );
  } finally {
    if (previousTemplate === undefined)
      delete process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
    else process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE = previousTemplate;
  }
});

test('trigger-app-event rejects event URLs that exceed length limits', async () => {
  const previousTemplate = process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
  process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE = `myapp://${'a'.repeat(5000)}?name={event}`;
  try {
    await assert.rejects(
      () => triggerAppEvent(ANDROID_EMULATOR, ['screenshot_taken']),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true);
        assert.equal((error as AppError).code, 'INVALID_ARGS');
        assert.match((error as AppError).message, /URL exceeds maximum supported length/i);
        return true;
      },
    );
  } finally {
    if (previousTemplate === undefined)
      delete process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
    else process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE = previousTemplate;
  }
});
