import assert from 'node:assert/strict';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import { assertElementText, assertJsonContains, assertWaitText } from './live-assertions.ts';
import { type LiveContext, runStep, verifyBehavior, verifyCommand } from './live-harness.ts';

const C = PUBLIC_COMMANDS;
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

export async function assertAutomationInput(context: LiveContext): Promise<void> {
  const opened = await runStep(context, 'cold launch fixture', [
    'open',
    context.appId,
    '--relaunch',
  ]);
  assertJsonContains(opened, context.appId, 'open response should retain fixture identity');
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
    'cold deep route rendered decoded payload and continued into the fixture catalog',
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

  await runStep(context, 'reveal automation input canaries', ['scroll', 'down', '--pixels', '120']);
  for (const identifier of ['automation-press', 'automation-longpress']) {
    const inputVisible = await runStep(context, `assert ${identifier} is visible`, [
      'is',
      'visible',
      `id="${identifier}"`,
    ]);
    assert.equal(inputVisible.json?.data?.pass, true, JSON.stringify(inputVisible.json));
  }

  await runStep(context, 'press semantic canary', ['press', 'id="automation-press"']);
  await assertWaitText(context, 'Last input: press');
  verifyCommand(context, C.press, 'semantic press changes the durable fixture canary');

  await runStep(context, 'long press semantic canary', [
    'longpress',
    'id="automation-longpress"',
    '800',
  ]);
  await assertWaitText(context, 'Long presses: 1');
  verifyCommand(context, C.longPress, '800ms hold increments the long-press counter');

  await runStep(context, 'scroll native alert canary into view', ['scroll', 'down', '1']);
  await runStep(context, 'open native alert', ['click', 'id="automation-open-alert"']);
  const alert = await runStep(context, 'wait for native alert', ['alert', 'wait', '5000']);
  assertJsonContains(alert, 'Automation confirmation', 'alert wait should return fixture alert');
  await runStep(context, 'inspect native alert', ['alert', 'get']);
  await runStep(context, 'dismiss native alert', ['alert', 'dismiss']);
  await assertWaitText(context, 'Alert result: cancelled');

  await runStep(context, 'reopen native alert', ['click', 'id="automation-open-alert"']);
  await runStep(context, 'accept native alert', ['alert', 'accept']);
  await assertWaitText(context, 'Alert result: accepted');
  verifyCommand(context, C.alert, 'alert wait/get/dismiss/accept produce both fixture outcomes');

  await runStep(context, 'return from automation route', ['back']);
  await assertWaitText(context, 'Settings');
  verifyCommand(context, C.back, 'back returns from automation route to Settings');
}

async function acceptDeepLinkConfirmationIfPresent(context: LiveContext): Promise<void> {
  const destination = await runStep(
    context,
    'wait for deep-link destination before inspecting system UI',
    ['wait', 'text', 'Automation lab', '2500'],
    { allowFailure: true },
  );
  if (destination.status === 0) return;

  const alert = await runStep(context, 'inspect delayed deep-link system alert', ['alert', 'get']);
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
