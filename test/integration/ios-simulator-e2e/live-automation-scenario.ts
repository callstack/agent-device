import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_ALERT_TIMEOUT_MS } from '@agent-device/contracts/alert-contract';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import {
  assertElementText,
  assertElementTextAfterScrolling,
  assertJsonContains,
  assertWaitText,
} from './live-assertions.ts';
import { clearStateLaunchUrlMaestroFlow } from './live-fixtures.ts';
import { type LiveContext, runStep, verifyBehavior, verifyCommand } from './live-harness.ts';

const C = PUBLIC_COMMANDS;
const ALERT_WAIT_TIMEOUT = String(DEFAULT_ALERT_TIMEOUT_MS);
const FIXTURE_HOME_TITLE = 'Agent Device Tester';
const AUTOMATION_DEEP_LINK =
  'agent-device-test-app:///automation?event=cold.start&payload=%7B%22source%22%3A%22deep-link%22%7D';

async function observeFixtureHome(context: LiveContext) {
  await assertWaitText(context, FIXTURE_HOME_TITLE);
  const snapshot = await runStep(context, 'capture fixture home', [
    'snapshot',
    '-i',
    '-s',
    FIXTURE_HOME_TITLE,
  ]);
  const nodes = Array.isArray(snapshot.json?.data?.nodes) ? snapshot.json.data.nodes : [];
  assert.ok(
    nodes.some((node: { label?: unknown }) => node.label === FIXTURE_HOME_TITLE),
    `home snapshot nodes should expose ${FIXTURE_HOME_TITLE}: ${JSON.stringify(snapshot.json)}`,
  );
  return snapshot;
}

async function assertAutomationAlertTriggerVisible(context: LiveContext): Promise<void> {
  const visible = await runStep(context, 'assert automation-open-alert is visible', [
    'is',
    'visible',
    'id="automation-open-alert"',
  ]);
  assert.equal(visible.json?.data?.pass, true, JSON.stringify(visible.json));
}

async function openNativeAlert(context: LiveContext, step: string): Promise<void> {
  await assertAutomationAlertTriggerVisible(context);
  await runStep(context, step, ['click', 'id="automation-open-alert"']);
  // The canary proves JS ran and the state update is observable; alert wait proves native presentation.
  await assertWaitText(context, 'Alert result: opened');
}

export async function assertAutomationInput(context: LiveContext): Promise<void> {
  const opened = await runStep(context, 'cold launch fixture', [
    'open',
    context.appId,
    '--relaunch',
  ]);
  assertJsonContains(opened, context.appId, 'open response should retain fixture identity');
  const runnerLogPath = opened.json?.data?.runnerLogPath;
  assert.equal(
    typeof runnerLogPath,
    'string',
    `open response should expose the authoritative runner log path: ${JSON.stringify(opened.json)}`,
  );
  context.runnerLogPath = runnerLogPath;
  if (context.tier === 'full') {
    await runStep(context, 'normalize simulator orientation', ['orientation', 'portrait']);
    await runStep(context, 'normalize simulator appearance', ['settings', 'appearance', 'light']);
  }

  await observeFixtureHome(context);
  verifyCommand(context, C.snapshot, 'interactive fixture tree exposes its stable title');
  verifyCommand(context, C.open, 'cold launch exposes the fixture UI through snapshot and wait');

  await openAutomationDeepLink(context, 'cold launch fixture through a deep link');
  await acceptDeepLinkConfirmationIfPresent(context);
  await assertWaitText(context, 'Automation lab');
  await assertElementText(context, 'id="automation-event-name"', 'cold.start');
  await assertElementText(context, 'id="automation-event-payload"', '{"source":"deep-link"}');
  await assertClearStateLaunchUrl(context);
  await runStep(context, 'navigate onward from cold deep link', [
    'click',
    'id="automation-continue-catalog"',
  ]);
  await runStep(context, 'wait for exact catalog destination', [
    'wait',
    'id="catalog-title"',
    '10000',
  ]);
  verifyBehavior(
    context,
    'cold-start-deep-link-navigation',
    'launchApp(clearState) removed a seeded data canary, rendered the stored deep route and payload, and continued into the fixture catalog',
  );

  await runStep(context, 'wait for settings tab target', ['wait', 'label="Settings"', '10000']);
  await runStep(context, 'open settings tab', ['click', 'label="Settings"']);
  await assertWaitText(context, 'Settings');
  await runStep(context, 'open automation route', ['click', 'id="open-automation-lab"']);
  await assertWaitText(context, 'Automation lab');
  verifyCommand(context, C.click, 'selector click opens the automation route');

  await runStep(context, 'open fixture sheet', ['click', 'id="automation-open-sheet"']);
  await assertWaitText(context, 'Automation sheet');
  await runStep(context, 'close fixture sheet', ['click', 'id="automation-close-sheet"']);
  await assertWaitText(context, 'Automation lab');
  const absentSheet = await runStep(context, 'assert closed fixture sheet is absent', [
    'is',
    'absent',
    'id="automation-close-sheet"',
  ]);
  assert.equal(absentSheet.json?.data?.pass, true, JSON.stringify(absentSheet.json));
  verifyCommand(context, C.is, 'strict absence observes the unmounted fixture sheet control');
  await runStep(context, 'restore automation route top after sheet', ['scroll', 'top']);
  verifyBehavior(
    context,
    'modal-open-close',
    'page-sheet modal exposed structural content and returned to the automation route',
  );

  const heading = await runStep(context, 'read automation heading', [
    'get',
    'text',
    'text="Automation lab"',
  ]);
  assertJsonContains(heading, 'Automation lab', 'get text should return automation heading');
  verifyCommand(context, C.get, 'get returns exact automation heading text');

  const visible = await runStep(context, 'assert automation heading visible', [
    'is',
    'visible',
    'id="automation-title"',
  ]);
  assert.equal(visible.json?.data?.pass, true, JSON.stringify(visible.json));
  verifyCommand(context, C.is, 'visible predicate passes for the automation heading');

  const found = await runStep(context, 'find automation heading', [
    'find',
    'text',
    'Automation lab',
    'exists',
  ]);
  assert.equal(found.json?.data?.found, true, JSON.stringify(found.json));
  verifyCommand(context, C.find, 'find reports the automation heading');

  await assertElementTextAfterScrolling(context, 'id="automation-press"', 'Press canary');
  const pressVisible = await runStep(context, 'assert automation-press is visible', [
    'is',
    'visible',
    'id="automation-press"',
  ]);
  assert.equal(pressVisible.json?.data?.pass, true, JSON.stringify(pressVisible.json));

  await runStep(context, 'press semantic canary', ['press', 'id="automation-press"']);
  await assertWaitText(context, 'Last input: press');
  verifyCommand(context, C.press, 'semantic press changes the durable fixture canary');

  await assertElementTextAfterScrolling(context, 'id="automation-longpress"', 'Long press canary');
  const longPressVisible = await runStep(context, 'assert automation-longpress is visible', [
    'is',
    'visible',
    'id="automation-longpress"',
  ]);
  assert.equal(longPressVisible.json?.data?.pass, true, JSON.stringify(longPressVisible.json));

  await runStep(context, 'long press semantic canary', [
    'longpress',
    'id="automation-longpress"',
    '800',
  ]);
  await assertWaitText(context, 'Long presses: 1');
  verifyCommand(context, C.longPress, '800ms hold increments the long-press counter');

  await assertElementTextAfterScrolling(
    context,
    'id="automation-open-alert"',
    'Open automation alert',
  );
  await openNativeAlert(context, 'open native alert');
  const alert = await runStep(context, 'wait for native alert', [
    'alert',
    'wait',
    ALERT_WAIT_TIMEOUT,
  ]);
  assertJsonContains(alert, 'Automation confirmation', 'alert wait should return fixture alert');
  await runStep(context, 'inspect native alert', ['alert', 'get']);
  await runStep(context, 'dismiss native alert', ['alert', 'dismiss']);
  await assertWaitText(context, 'Alert result: cancelled');

  await openNativeAlert(context, 'reopen native alert');
  const reopenedAlert = await runStep(context, 'wait for reopened native alert', [
    'alert',
    'wait',
    ALERT_WAIT_TIMEOUT,
  ]);
  assertJsonContains(
    reopenedAlert,
    'Automation confirmation',
    'alert wait should return the reopened fixture alert',
  );
  await runStep(context, 'accept native alert', ['alert', 'accept']);
  await assertWaitText(context, 'Alert result: accepted');
  verifyCommand(context, C.alert, 'alert wait/get/dismiss/accept produce both fixture outcomes');

  await runStep(context, 'return from automation route', ['back']);
  await assertWaitText(context, 'Settings');
  verifyCommand(context, C.back, 'back returns from automation route to Settings');
}

async function assertClearStateLaunchUrl(context: LiveContext): Promise<void> {
  const prepared = await runStep(context, 'prepare fixture data clear canary', [
    'settings',
    'clear-app-state',
    context.appId,
  ]);
  const containerPath = prepared.json?.data?.containerPath;
  assert.ok(
    typeof containerPath === 'string' && path.isAbsolute(containerPath),
    `clear-state response should expose an absolute data container: ${JSON.stringify(prepared.json)}`,
  );

  const canaryPath = path.join(containerPath, 'Documents', 'agent-device-clear-state-canary.txt');
  fs.mkdirSync(path.dirname(canaryPath), { recursive: true });
  fs.writeFileSync(canaryPath, 'must be removed by launchApp(clearState: true)\n');
  assert.equal(fs.existsSync(canaryPath), true, `failed to seed clear-state canary: ${canaryPath}`);

  const flowPath = path.join(context.artifactDir, 'clear-state-launch-url.yaml');
  fs.writeFileSync(flowPath, clearStateLaunchUrlMaestroFlow(context.appId));
  const replay = await runStep(context, 'launch clear-state fixture through stored URL', [
    'replay',
    flowPath,
    '--maestro',
  ]);
  assert.equal(replay.json?.data?.replayed, 3, JSON.stringify(replay.json));
  assert.equal(
    fs.existsSync(canaryPath),
    false,
    `launchApp(clearState: true) retained data canary: ${canaryPath}`,
  );
  await assertElementText(context, 'id="automation-event-name"', 'cold.start');
  await assertElementText(context, 'id="automation-event-payload"', '{"source":"deep-link"}');
}

export async function acceptDeepLinkConfirmationIfPresent(context: LiveContext): Promise<void> {
  const destination = await runStep(
    context,
    'wait for deep-link destination before inspecting system UI',
    ['wait', 'text', 'Automation lab', '2500'],
    { allowFailure: true },
  );
  if (destination.status === 0) return;

  const alert = await runStep(context, 'inspect delayed deep-link system alert', ['alert', 'get'], {
    allowFailure: true,
  });
  if (alert.status !== 0) return;
  const alertInfo = alert.json?.data;
  assert.match(String(alertInfo?.message), /^Open in\b/, JSON.stringify(alert.json));
  assert.ok(
    Array.isArray(alertInfo?.items) && alertInfo.items.includes('Open'),
    JSON.stringify(alert.json),
  );
  await runStep(context, 'accept deep-link confirmation', ['alert', 'accept']);
}

async function openAutomationDeepLink(context: LiveContext, step: string): Promise<void> {
  await runStep(context, step, [
    'open',
    context.appId,
    '--relaunch',
    '--launch-url',
    AUTOMATION_DEEP_LINK,
  ]);
}
