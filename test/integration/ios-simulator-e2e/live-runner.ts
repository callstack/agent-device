import assert from 'node:assert/strict';
import path from 'node:path';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import { assertPngFile } from '../provider-scenarios/assertions.ts';
import {
  assertFilesDiffer,
  assertJsonContains,
  assertWaitText,
  capturePng,
  requireNodeRect,
} from './live-assertions.ts';
import { assertAutomationInput } from './live-automation-scenario.ts';
import { assertDeviceLifecycle, assertKnownGaps } from './live-device-lifecycle.ts';
import {
  assertLifecycleAndSystem,
  assertObservabilityAndArtifacts,
} from './live-full-scenarios.ts';
import { assertFixtureReplays } from './live-replay-scenarios.ts';
import {
  assertCoverageComplete,
  cleanupSession,
  createContext,
  type LiveContext,
  runScenario,
  runStep,
  sessionExists,
  verifyBehavior,
  verifyCommand,
  writeCoverageReport,
} from './live-harness.ts';
import { bindIosSimulatorScenarios } from './scenarios.ts';

const C = PUBLIC_COMMANDS;
const LIVE_SCENARIOS = bindIosSimulatorScenarios<LiveContext>({
  automationInput: assertAutomationInput,
  captureClose: async (context) => {
    await assertCapture(context);
    await assertClose(context);
  },
  deviceLifecycle: assertDeviceLifecycle,
  fixtureReplays: assertFixtureReplays,
  formInput: assertFormInput,
  inventoryInstall: assertInventoryAndInstall,
  knownGaps: async (context) => {
    await assertKnownGaps(context);
    await assertClose(context);
  },
  lifecycleSystem: assertLifecycleAndSystem,
  observabilityArtifacts: assertObservabilityAndArtifacts,
});

export async function runIosSimulatorE2E(): Promise<void> {
  const context = createContext();
  let primaryError: unknown;
  try {
    await executeLiveScenarios(context);
  } catch (error) {
    primaryError = error;
  }
  const cleanupError = await finalizeLiveRun(context);
  throwLiveRunErrors(primaryError, cleanupError);
}

async function executeLiveScenarios(context: LiveContext): Promise<void> {
  for (const scenario of LIVE_SCENARIOS.filter((candidate) => candidate.tier === 'smoke')) {
    await runScenario(context, scenario);
  }
  if (context.tier === 'full') {
    await runStep(context, 'reopen fixture for full tier', ['open', context.appId, '--relaunch']);
    for (const scenario of LIVE_SCENARIOS.filter((candidate) => candidate.tier === 'full')) {
      await runScenario(context, scenario);
    }
  }
  assertCoverageComplete(context);
}

async function finalizeLiveRun(context: LiveContext): Promise<unknown> {
  let cleanupError: unknown;
  try {
    context.sessionOpen = context.sessionOpen || (await sessionExists(context));
  } catch (error) {
    cleanupError = error;
  }
  if (context.sessionOpen) {
    try {
      await cleanupSession(context);
    } catch (error) {
      cleanupError = combineErrors(cleanupError, error, 'session inspection and cleanup failed');
    }
  }
  try {
    writeCoverageReport(context);
  } catch (error) {
    cleanupError = combineErrors(cleanupError, error, 'cleanup and coverage reporting failed');
  }
  return cleanupError;
}

function throwLiveRunErrors(primaryError: unknown, cleanupError: unknown): void {
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'iOS simulator E2E failed and cleanup also failed',
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
}

function combineErrors(existing: unknown, next: unknown, message: string): unknown {
  return existing === undefined ? next : new AggregateError([existing, next], message);
}

async function assertInventoryAndInstall(context: LiveContext): Promise<void> {
  const devices = await runStep(context, 'list iOS devices', ['devices']);
  assertJsonContains(devices, context.udid, 'device inventory should include selected UDID');
  verifyCommand(context, C.devices, 'selected simulator UDID appears in the typed inventory');

  const capabilities = await runStep(context, 'read simulator capabilities', ['capabilities']);
  for (const command of ['click', 'fill', 'gesture', 'snapshot']) {
    assertJsonContains(capabilities, command, `capabilities should include ${command}`);
  }
  verifyCommand(context, C.capabilities, 'typed capability response includes fixture commands');

  await runStep(context, 'install cached fixture through public CLI', ['install', context.appPath]);
  const apps = await runStep(context, 'list installed user apps', ['apps']);
  assertJsonContains(apps, context.appId, 'app inventory should include fixture bundle id');
  verifyCommand(context, C.install, 'fixture installed through the public CLI and appears in apps');
  verifyCommand(context, C.apps, 'installed fixture bundle appears in app inventory');

  const doctor = await runStep(context, 'doctor fixture discovery', [
    'doctor',
    '--app',
    context.appId,
  ]);
  assertJsonContains(doctor, context.appId, 'doctor should discover fixture app');
  verifyCommand(context, C.doctor, 'doctor discovers the installed fixture bundle');
}

async function assertFormInput(context: LiveContext): Promise<void> {
  await runStep(context, 'open form tab', ['click', 'label="Form"']);
  await assertWaitText(context, 'Checkout form');

  await runStep(context, 'establish diff baseline', ['snapshot', '-i']);
  await runStep(context, 'fill full name', ['fill', 'id="field-name"', 'Ada Lovelace']);
  const diff = await runStep(context, 'observe filled-name diff', ['diff', 'snapshot', '-i']);
  const additions = Number(diff.json?.data?.summary?.additions ?? 0);
  const removals = Number(diff.json?.data?.summary?.removals ?? 0);
  assert.ok(
    additions + removals > 0,
    `expected non-empty snapshot diff: ${JSON.stringify(diff.json)}`,
  );
  verifyCommand(context, C.diff, 'snapshot diff reports a non-empty form mutation');
  const name = await runStep(context, 'read filled full name', ['get', 'attrs', 'id="field-name"']);
  assertJsonContains(name, 'Ada Lovelace', 'filled name should be observable');
  verifyCommand(context, C.fill, 'replacement name text is read back from the fixture field');

  const editable = await runStep(context, 'assert email is editable', [
    'is',
    'editable',
    'id="field-email"',
  ]);
  assert.equal(editable.json?.data?.pass, true, JSON.stringify(editable.json));

  await runStep(context, 'seed email field', ['fill', 'id="field-email"', 'ada@example']);
  const keyboardVisiblePath = path.join(context.artifactDir, 'keyboard-visible.png');
  await capturePng(context, 'capture visible input keyboard', keyboardVisiblePath);
  const keyboard = await runStep(context, 'dismiss input keyboard', ['keyboard', 'dismiss']);
  assert.equal(keyboard.json?.data?.dismissed, true, JSON.stringify(keyboard.json));
  assert.equal(keyboard.json?.data?.visible, false, JSON.stringify(keyboard.json));
  const keyboardHiddenPath = path.join(context.artifactDir, 'keyboard-hidden.png');
  await capturePng(context, 'capture dismissed input keyboard', keyboardHiddenPath);
  assertFilesDiffer(
    keyboardVisiblePath,
    keyboardHiddenPath,
    'keyboard dismissal should change simulator pixels',
  );
  verifyCommand(
    context,
    C.keyboard,
    'dismiss reports dismissed=true and visible=false while before/after pixels differ',
  );

  const formSnapshot = await runStep(context, 'locate email coordinates', ['snapshot', '-i']);
  const emailRect = requireNodeRect(formSnapshot, 'field-email');
  await runStep(context, 'focus email by snapshot-derived coordinates', [
    'focus',
    String(emailRect.x + emailRect.width / 2),
    String(emailRect.y + emailRect.height / 2),
  ]);
  await runStep(context, 'append email suffix from coordinate focus', ['type', '.test']);
  const email = await runStep(context, 'read typed email', ['get', 'attrs', 'id="field-email"']);
  assertJsonContains(email, 'ada@example.test', 'typed email suffix should be observable');
  verifyBehavior(
    context,
    'text-entry-keyboard-lifecycle',
    'fill showed the keyboard, dismissal changed pixels, and coordinate focus enabled typed text',
  );
  verifyCommand(context, C.focus, 'snapshot-derived coordinate focus directs subsequent typing');
  verifyCommand(context, C.type, 'typed suffix is read back from the coordinate-focused field');
}

async function assertCapture(context: LiveContext): Promise<void> {
  const screenshotPath = path.join(context.artifactDir, 'fixture-smoke.png');
  const screenshot = await runStep(context, 'capture fixture screenshot', [
    'screenshot',
    screenshotPath,
    '--max-size',
    '900',
  ]);
  assertJsonContains(screenshot, screenshotPath, 'screenshot response should return artifact path');
  assertPngFile(screenshotPath);
  verifyCommand(context, C.screenshot, 'captured fixture file has a valid PNG signature');
}

async function assertClose(context: LiveContext): Promise<void> {
  await runStep(context, 'close fixture session', ['close']);
  const inventory = await runStep(context, 'verify fixture session released', ['session', 'list'], {
    commonFlags: false,
  });
  const sessions = Array.isArray(inventory.json?.data?.sessions)
    ? inventory.json.data.sessions
    : [];
  assert.equal(
    sessions.some((session: { name?: unknown }) => session.name === context.session),
    false,
    JSON.stringify(inventory.json),
  );
  verifyCommand(context, C.close, 'session inventory proves the fixture lease was removed');
}
