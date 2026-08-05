import assert from 'node:assert/strict';
import path from 'node:path';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import { assertPngFile } from '../provider-scenarios/assertions.ts';
import { type LiveContext, runStep, verifyCommand } from './live-harness.ts';

const C = PUBLIC_COMMANDS;

export async function assertCaptureAndClose(context: LiveContext): Promise<void> {
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
