import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { bindAdmittedLocalInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { ANDROID_EMULATOR, IOS_DEVICE, MACOS_DEVICE, mkdtempForTest } from '@agent-device/test-kit';
import { getInteractor } from './interactors.ts';

async function triggerEvent(device: DeviceInfo, eventUrl: string, appBundleId?: string) {
  const operations = bindAdmittedLocalInteractorOperations({
    device,
    signal: new AbortController().signal,
    resolveInteractor: async (owned, runner) => await getInteractor(owned, runner),
    facts: { triggerAppEvent: { available: true } },
  });
  await operations.triggerAppEvent?.({
    eventUrl,
    options: appBundleId === undefined ? {} : { appBundleId },
  });
}

async function withCommandStub<T>(
  command: string,
  run: (argsLogPath: string) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtempForTest(`agent-device-trigger-app-event-${command}-`);
  const commandPath = path.join(tempDir, command);
  const argsLogPath = path.join(tempDir, 'args.log');
  await fs.writeFile(
    commandPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(commandPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tempDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;
  try {
    return await run(argsLogPath);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousArgsFile === undefined) delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    else process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('trigger-app-event opens an Android deep link through adb', async () => {
  await withCommandStub('adb', async (argsLogPath) => {
    const eventUrl = 'myapp://agent-device/event?name=screenshot_taken&platform=android';
    await triggerEvent(ANDROID_EMULATOR, eventUrl);
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(args.includes('-d'), true);
    assert.equal(args.includes(`'${eventUrl}'`), true);
  });
});

test('trigger-app-event opens an iOS device payload URL through devicectl', async () => {
  await withCommandStub('xcrun', async (argsLogPath) => {
    const eventUrl = 'myapp://ios?name=screenshot_taken&payload=%7B%22source%22%3A%22ios%22%7D';
    await triggerEvent(IOS_DEVICE, eventUrl, 'com.example.app');
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual(args, [
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      'ios-device-1',
      '--payload-url',
      eventUrl,
      'com.example.app',
    ]);
  });
});

test('trigger-app-event opens a macOS URL through open', async () => {
  await withCommandStub('open', async (argsLogPath) => {
    const eventUrl = 'myapp://macos?name=screenshot_taken&platform=macos';
    await triggerEvent(MACOS_DEVICE, eventUrl);
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual(args, [eventUrl]);
  });
});
