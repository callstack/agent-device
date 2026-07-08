import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeviceInfo } from '../../../../kernel/device.ts';
import { PNG } from '../../../../utils/png.ts';
import { screenshotIos } from '../screenshot.ts';

test('screenshotIos caches simulator screen scale per device', async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-ios-screenshot-scale-cache-'),
  );
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const commandLogPath = path.join(tmpDir, 'commands.log');
  const outPath = path.join(tmpDir, 'screen.png');
  const sourcePngPath = path.join(tmpDir, 'source.png');
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'sim-scale-cache',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };

  await fs.writeFile(sourcePngPath, PNG.sync.write(new PNG({ width: 1206, height: 2622 })));
  await fs.writeFile(
    xcrunPath,
    [
      '#!/bin/sh',
      'echo "__XCRUN__ $*" >> "$AGENT_DEVICE_TEST_COMMAND_LOG"',
      'if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then',
      '  echo \'{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-scale-cache","state":"Booted"}]}}\'',
      '  exit 0',
      'fi',
      'if [ "$1" = "simctl" ] && [ "$2" = "getenv" ] && [ "$3" = "sim-scale-cache" ] && [ "$4" = "SIMULATOR_MAINSCREEN_SCALE" ]; then',
      '  echo "3"',
      '  exit 0',
      'fi',
      'if [ "$1" = "simctl" ] && [ "$2" = "io" ] && [ "$3" = "sim-scale-cache" ] && [ "$4" = "screenshot" ]; then',
      '  cp "$AGENT_DEVICE_TEST_SCREENSHOT_SOURCE_FILE" "$5"',
      '  exit 0',
      'fi',
      'echo "unexpected xcrun args: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);

  const previousPath = process.env.PATH;
  const previousCommandLog = process.env.AGENT_DEVICE_TEST_COMMAND_LOG;
  const previousScreenshotSourceFile = process.env.AGENT_DEVICE_TEST_SCREENSHOT_SOURCE_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_COMMAND_LOG = commandLogPath;
  process.env.AGENT_DEVICE_TEST_SCREENSHOT_SOURCE_FILE = sourcePngPath;

  try {
    await screenshotIos(device, outPath);
    await screenshotIos(device, outPath);

    const logLines = (await fs.readFile(commandLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(
      logLines.filter(
        (line) => line === '__XCRUN__ simctl getenv sim-scale-cache SIMULATOR_MAINSCREEN_SCALE',
      ).length,
      1,
    );
    assert.equal(
      logLines.filter(
        (line) => line === '__XCRUN__ simctl io sim-scale-cache screenshot ' + outPath,
      ).length,
      2,
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousCommandLog === undefined) delete process.env.AGENT_DEVICE_TEST_COMMAND_LOG;
    else process.env.AGENT_DEVICE_TEST_COMMAND_LOG = previousCommandLog;
    if (previousScreenshotSourceFile === undefined)
      delete process.env.AGENT_DEVICE_TEST_SCREENSHOT_SOURCE_FILE;
    else process.env.AGENT_DEVICE_TEST_SCREENSHOT_SOURCE_FILE = previousScreenshotSourceFile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
