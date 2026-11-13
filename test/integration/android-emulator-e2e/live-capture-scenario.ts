import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { assertPngFile } from '../provider-scenarios/assertions.ts';
import { assertScreenshotDemoPermissionRestoration } from './live-demo-permission-scenario.ts';
import { type LiveContext, runStep, verifyCommand } from './live-harness.ts';

const C = PUBLIC_COMMANDS;

export async function assertCaptureAndClose(context: LiveContext): Promise<void> {
  await runStep(context, 'open Settings for native permission restoration', [
    'open',
    'com.android.settings',
    '--no-test-ime',
  ]);
  const foreground = await runStep(context, 'verify Settings is foreground', ['appstate']);
  assert.equal(foreground.json?.data?.package, 'com.android.settings');
  const snapshot = await runStep(
    context,
    'verify candidate Android helper before normalized capture',
    ['snapshot', '-i'],
  );
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  assert.equal(snapshot.json?.data?.androidSnapshot?.backend, 'android-helper');
  assert.equal(snapshot.json?.data?.androidSnapshot?.helperVersion, version);
  fs.writeFileSync(
    path.join(context.artifactDir, 'demo-permission-snapshot.json'),
    JSON.stringify(snapshot.json, null, 2),
  );
  await assertScreenshotDemoPermissionRestoration({
    serial: context.serial,
    artifactDir: context.artifactDir,
    captureScreenshot: async (filePath) => {
      await runStep(context, 'capture normalized permission restoration evidence', [
        'screenshot',
        filePath,
        '--normalize-status-bar',
      ]);
    },
  });
  await runStep(context, 'restore fixture after native permission restoration', [
    'open',
    context.appId,
    '--no-test-ime',
  ]);
  const screenshotPath = path.join(context.artifactDir, 'fixture-smoke.png');
  const screenshot = await runStep(context, 'capture fixture screenshot', [
    'screenshot',
    screenshotPath,
    '--scale',
    '0.5',
  ]);
  assert.ok(
    JSON.stringify(screenshot.json?.data).includes(screenshotPath),
    JSON.stringify(screenshot.json),
  );
  assertPngFile(screenshotPath);
  verifyCommand(context, C.screenshot, 'captured Android fixture file has a valid PNG signature');

  await runStep(context, 'close fixture session', ['close']);
  const sessions = await runStep(context, 'verify fixture session released', ['session', 'list'], {
    commonFlags: false,
  });
  const inventory = Array.isArray(sessions.json?.data?.sessions) ? sessions.json.data.sessions : [];
  assert.equal(
    inventory.some((session: { name?: unknown }) => session.name === context.session),
    false,
    JSON.stringify(sessions.json),
  );
  verifyCommand(context, C.close, 'session inventory proves Android fixture lease was removed');
}
