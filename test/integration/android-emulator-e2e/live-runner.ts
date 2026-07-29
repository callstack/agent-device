import assert from 'node:assert/strict';
import path from 'node:path';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import { assertPngFile } from '../provider-scenarios/assertions.ts';
import { assertAutomationSystem } from './live-automation-scenario.ts';
import { assertFormInput } from './live-form-scenario.ts';
import { assertInventoryAndInstall } from './live-inventory-scenario.ts';
import {
  assertCoverageComplete,
  cleanupSession,
  createContext,
  runScenario,
  runStep,
  verifyCommand,
  writeCoverageReport,
  type LiveContext,
} from './live-harness.ts';
import { bindAndroidEmulatorScenarios } from './scenarios.ts';

const C = PUBLIC_COMMANDS;

const LIVE_SCENARIOS = bindAndroidEmulatorScenarios<LiveContext>({
  automationSystem: assertAutomationSystem,
  captureClose: assertCaptureAndClose,
  formInput: assertFormInput,
  inventoryInstall: assertInventoryAndInstall,
});

export async function runAndroidEmulatorE2E(): Promise<void> {
  const context = createContext();
  let primaryError: unknown;
  try {
    for (const scenario of LIVE_SCENARIOS) await runScenario(context, scenario);
    assertCoverageComplete(context);
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    await cleanupSession(context);
  } catch (error) {
    cleanupError = error;
  }
  try {
    writeCoverageReport(context);
  } catch (error) {
    cleanupError = cleanupError ?? error;
  }
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'Android E2E failed and cleanup also failed',
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function assertCaptureAndClose(context: LiveContext): Promise<void> {
  const screenshotPath = path.join(context.artifactDir, 'fixture-smoke.png');
  const screenshot = await runStep(context, 'capture fixture screenshot', [
    'screenshot',
    screenshotPath,
    '--max-size',
    '900',
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
