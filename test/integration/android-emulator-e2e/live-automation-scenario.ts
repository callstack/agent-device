import assert from 'node:assert/strict';
import path from 'node:path';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import {
  assertElementText,
  assertDiffLine,
  assertFilesDiffer,
  assertJsonContains,
  assertPersistentAndroidHelper,
  assertWaitSelector,
  assertWaitText,
  capturePng,
  requireAndroidResourceId,
} from './live-assertions.ts';
import { type LiveContext, runStep, verifyBehavior, verifyCommand } from './live-harness.ts';

const C = PUBLIC_COMMANDS;

export async function assertAutomationSystem(context: LiveContext): Promise<void> {
  await assertElementText(context, 'id="automation-event-name"', 'cold.start');
  await assertElementText(
    context,
    'id="automation-event-payload"',
    '{"source":"android-deep-link"}',
  );
  verifyCommand(context, C.open, 'cold Android deep link renders decoded fixture event payload');
  verifyBehavior(
    context,
    'cold-start-deep-link-navigation',
    'cold deep link rendered exact event and payload before normal navigation resumed',
  );

  await runStep(context, 'continue from cold deep link to fixture catalog', [
    'click',
    'id="automation-continue-catalog"',
  ]);
  await assertWaitText(context, 'Catalog');
  const catalogSnapshot = await runStep(context, 'capture Android catalog navigation', [
    'snapshot',
    '-i',
  ]);
  assertPersistentAndroidHelper(catalogSnapshot, { reused: true });
  const settingsTab = (
    catalogSnapshot.json?.data?.nodes as { label?: unknown; ref?: unknown }[] | undefined
  )?.find((node) => typeof node.label === 'string' && node.label.startsWith('Settings'));
  const settingsRef = settingsTab?.ref;
  assert.ok(typeof settingsRef === 'string', JSON.stringify(catalogSnapshot.json));
  await runStep(context, 'open Settings tab', ['click', `@${settingsRef}`]);
  await assertWaitText(context, 'Settings');
  await runStep(context, 'open automation lab', ['click', 'id="open-automation-lab"']);
  await assertWaitText(context, 'Automation lab');

  const snapshot = await runStep(context, 'capture Android automation tree', ['snapshot', '-i']);
  const eventName = requireAndroidResourceId(snapshot, 'automation-event-name');
  assert.match(eventName.identifier, /(^|:id\/)automation-event-name$/, eventName.identifier);
  verifyCommand(
    context,
    C.snapshot,
    `interactive tree exposes Android resource-id ${eventName.identifier}`,
  );
  verifyBehavior(
    context,
    'android-resource-id-selectors',
    `observed ${eventName.identifier} before id selector-driven fixture actions`,
  );

  const heading = await runStep(context, 'read Android automation heading', [
    'get',
    'text',
    'text="Automation lab"',
  ]);
  assertJsonContains(heading, 'Automation lab', 'get text should return automation heading');
  verifyCommand(context, C.get, 'get returns exact automation heading text');

  const appState = await runStep(context, 'read Android fixture foreground app state', [
    'appstate',
  ]);
  assert.equal(appState.json?.data?.package, context.appId, JSON.stringify(appState.json));
  verifyCommand(
    context,
    C.appState,
    'Android foreground package names the fixture before system UI',
  );

  const visible = await runStep(context, 'assert automation title visible', [
    'is',
    'visible',
    'id="automation-title"',
  ]);
  assert.equal(visible.json?.data?.pass, true, JSON.stringify(visible.json));
  verifyCommand(context, C.is, 'visible predicate passes for automation resource-id');

  const found = await runStep(context, 'find automation heading', [
    'find',
    'text',
    'Automation lab',
    'exists',
  ]);
  assert.equal(found.json?.data?.found, true, JSON.stringify(found.json));
  verifyCommand(context, C.find, 'find observes the automation landmark');

  await runStep(context, 'open Android fixture modal', ['click', 'id="automation-open-sheet"']);
  await assertWaitText(context, 'Automation sheet');
  await runStep(context, 'close Android fixture modal', ['click', 'id="automation-close-sheet"']);
  await assertWaitText(context, 'Automation lab');
  verifyCommand(context, C.click, 'resource-id selectors open and close fixture modal');

  await assertOrientationFixtureState(context, 'landscape-left', 'landscape');
  await assertOrientationFixtureState(context, 'portrait', 'portrait');
  verifyCommand(
    context,
    C.orientation,
    'fixture window state observed landscape then portrait Android rotation',
  );
  verifyBehavior(
    context,
    'orientation-fixture-state',
    'fixture automation-window value changed to landscape and back to portrait',
  );

  await runStep(context, 'reveal input canaries', ['scroll', 'down', '0.7']);
  await runStep(context, 'press semantic canary', ['press', 'id="automation-press"']);
  await assertWaitText(context, 'Last input: press');
  verifyCommand(context, C.press, 'semantic press updates durable fixture input state');

  await runStep(context, 'long press semantic canary', [
    'longpress',
    'id="automation-longpress"',
    '800',
  ]);
  await assertWaitText(context, 'Long presses: 1');
  verifyCommand(context, C.longPress, '800ms hold increments durable fixture long-press counter');

  await runStep(context, 'open Android native alert', ['click', 'id="automation-open-alert"']);
  await assertWaitText(context, 'Automation confirmation');
  const alertSnapshot = await runStep(context, 'capture native alert through persistent helper', [
    'snapshot',
    '-i',
  ]);
  assertPersistentAndroidHelper(alertSnapshot);
  assertJsonContains(
    alertSnapshot,
    'Automation confirmation',
    'persistent helper snapshot should expose fixture dialog',
  );
  const reusedAlertSnapshot = await runStep(context, 'reuse persistent helper on native alert', [
    'snapshot',
    '-i',
  ]);
  assertPersistentAndroidHelper(reusedAlertSnapshot, { reused: true });
  assertJsonContains(
    reusedAlertSnapshot,
    'Automation confirmation',
    'reused persistent helper snapshot should retain the fixture dialog',
  );
  const alert = await runStep(context, 'inspect Android native alert', ['alert', 'get']);
  assertJsonContains(alert, 'Automation confirmation', 'alert get should expose fixture dialog');
  await runStep(context, 'dismiss Android native alert', ['alert', 'dismiss']);
  await assertWaitText(context, 'Alert result: cancelled');
  await runStep(context, 'reopen Android native alert', ['click', 'id="automation-open-alert"']);
  await runStep(context, 'accept Android native alert', ['alert', 'accept']);
  await assertWaitText(context, 'Alert result: accepted');
  verifyCommand(context, C.alert, 'alert wait/get/dismiss/accept produce fixture-visible results');

  await assertHomeAndRecentsRestoration(context);
  await runStep(context, 'reveal Android alert canary for diff baseline', ['scroll', 'down', '1']);
  await runStep(context, 'establish automation diff baseline', ['snapshot', '-i']);
  await runStep(context, 'return from automation route with Back', ['back']);
  const diff = await runStep(context, 'observe automation-to-settings diff', [
    'diff',
    'snapshot',
    '-i',
  ]);
  assertDiffLine(diff, 'removed', 'Open automation alert');
  assertDiffLine(diff, 'added', 'Open automation lab');
  await assertWaitText(context, 'Settings');
  verifyCommand(context, C.diff, 'snapshot diff reports the Automation-to-Settings transition');
  verifyCommand(context, C.back, 'Android Back returns from automation route to Settings');
  verifyBehavior(
    context,
    'safe-back-navigation',
    'Back returned from the automation route to the fixture Settings tab without opening system navigation',
  );
}

async function assertOrientationFixtureState(
  context: LiveContext,
  orientation: 'landscape-left' | 'portrait',
  expectedWindow: 'landscape' | 'portrait',
): Promise<void> {
  await runStep(context, `set Android ${orientation} orientation`, ['orientation', orientation]);
  await assertWaitText(context, expectedWindow);
  await assertElementText(context, 'id="automation-window"', expectedWindow);
}

async function assertHomeAndRecentsRestoration(context: LiveContext): Promise<void> {
  const foreground = path.join(context.artifactDir, 'foreground.png');
  await capturePng(context, 'capture Android fixture foreground', foreground);
  await runStep(context, 'send Android fixture Home', ['home']);
  const homeState = await runStep(context, 'read Android Home foreground state', ['appstate']);
  assert.notEqual(homeState.json?.data?.package, context.appId, JSON.stringify(homeState.json));
  const home = path.join(context.artifactDir, 'home.png');
  await capturePng(context, 'capture Android Home surface', home);
  assertFilesDiffer(foreground, home, 'Android Home should replace fixture pixels');
  verifyCommand(context, C.home, 'Home changes Android foreground package and system pixels');

  await runStep(context, 'open Android Recents', ['app-switcher']);
  const recents = path.join(context.artifactDir, 'recents.png');
  await capturePng(context, 'capture Android Recents surface', recents);
  assertFilesDiffer(home, recents, 'Android Recents should differ from Home pixels');
  verifyCommand(context, C.appSwitcher, 'Recents pixels differ from Home system surface');

  await runStep(context, 'restore fixture after Android system UI', ['open', context.appId]);
  await runStep(context, 'restore automation route top after Android system UI', ['scroll', 'top']);
  await assertWaitSelector(context, 'id="automation-open-sheet"');
  const restored = await runStep(context, 'verify restored Android fixture foreground state', [
    'appstate',
  ]);
  assert.equal(restored.json?.data?.package, context.appId, JSON.stringify(restored.json));
  verifyBehavior(
    context,
    'home-recents-restoration',
    'Android foreground package and distinct Home/Recents screenshots prove restoration path',
  );
}
