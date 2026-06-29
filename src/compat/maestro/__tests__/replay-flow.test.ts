import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../../../utils/errors.ts';
import { parseMaestroReplayFlow } from '../replay-flow.ts';

test('parseMaestroReplayFlow converts a supported Maestro command subset', () => {
  const parsed = parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
env:
  USER_NAME: Ada
---
- launchApp
- tapOn:
    id: home-open-form
- tapOn:
    point: 20%,20%
    label: Dismiss save password prompt
- doubleTapOn:
    id: release-notice
    delay: 150
- longPressOn:
    text: Agent Device Tester
- openLink: exp://localhost:8082
- tapOn: Full name
- inputText:
    text: Ada Lovelace
    label: Full name
- assertVisible:
    text: Checkout form
- assertNotVisible:
    text: Missing banner
- extendedWaitUntil:
    visible:
      id: submit-order
    timeout: 7000
- scroll
- swipe:
    start: 50%, 75%
    end: 50%, 35%
    duration: 300
- swipe:
    direction: LEFT
- scrollUntilVisible:
    element: Discover
    direction: UP
- takeScreenshot: ./screens/form.png
- hideKeyboard
- stopApp
`);

  assert.equal(parsed.metadata.env?.USER_NAME, 'Ada');
  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [
      ['open', ['com.callstack.agentdevicelab']],
      ['__maestroTapOn', ['id="home-open-form"']],
      ['__maestroTapPointPercent', ['20', '20']],
      ['click', ['id="release-notice"']],
      [
        'click',
        ['label="Agent Device Tester" || text="Agent Device Tester" || id="Agent Device Tester"'],
      ],
      ['open', ['exp://localhost:8082']],
      ['__maestroTapOn', ['label="Full name" || text="Full name" || id="Full name"']],
      ['type', ['Ada Lovelace']],
      [
        '__maestroAssertVisible',
        ['label="Checkout form" || text="Checkout form" || id="Checkout form"', '17000'],
      ],
      [
        '__maestroAssertNotVisible',
        ['label="Missing banner" || text="Missing banner" || id="Missing banner"'],
      ],
      ['__maestroAssertVisible', ['id="submit-order"', '7000']],
      ['scroll', ['down']],
      ['__maestroSwipeScreen', ['percent', '50', '75', '50', '35', '300']],
      ['__maestroSwipeScreen', ['direction', 'left']],
      [
        '__maestroScrollUntilVisible',
        ['label="Discover" || text="Discover" || id="Discover"', '5000', 'up'],
      ],
      ['screenshot', ['./screens/form.png']],
      ['keyboard', ['dismiss']],
      ['close', ['com.callstack.agentdevicelab']],
    ],
  );
  assert.equal(parsed.actions[3]?.flags.doubleTap, true);
  assert.equal(parsed.actions[3]?.flags.intervalMs, 150);
  assert.equal(parsed.actions[4]?.flags.holdMs, 3000);
  assert.equal(parsed.actions[1]?.flags.maestro?.allowNonHittableCoordinateFallback, true);
  assert.equal(parsed.actions[6]?.flags?.maestro?.allowNonHittableCoordinateFallback, true);
  assert.equal(parsed.actions[10]?.flags.maestro?.allowAlreadyPastLoading, true);
});

test('parseMaestroReplayFlow maps iOS openLink through the app id when available', () => {
  const parsed = parseMaestroReplayFlow(
    `appId: com.callstack.agentdevicelab
---
- openLink: exp://localhost:8082
`,
    { platform: 'ios' },
  );

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [['open', ['com.callstack.agentdevicelab', 'exp://localhost:8082']]],
  );
  assert.equal(parsed.actions[0]?.flags.maestro?.prewarmRunnerBeforeOpen, true);
});

test('parseMaestroReplayFlow maps Android openLink through the app id when available', () => {
  const parsed = parseMaestroReplayFlow(
    `appId: com.callstack.agentdevicelab
---
- openLink: exp://localhost:8082
`,
    { platform: 'android' },
  );

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [['open', ['com.callstack.agentdevicelab', 'exp://localhost:8082']]],
  );
});

test('parseMaestroReplayFlow maps Android openLink without package binding when appId is absent', () => {
  const parsed = parseMaestroReplayFlow(
    `---
- openLink: exp://localhost:8082
`,
    { platform: 'android' },
  );

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [['open', ['exp://localhost:8082']]],
  );
});

test('parseMaestroReplayFlow converts Maestro nested selector compatibility syntax', () => {
  const parsed = parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- eraseText
- eraseText: 12
- tapOn:
    id: childActionButton
    childOf:
      id: parent-row-secondary
- tapOn:
    id: overflowButton
    index: 0
- tapOn:
    label: Profile name metadata
    text: Profile name
- swipe:
    label: Drag item down
    from:
      id: reorder-handle
    direction: UP
    duration: 350
`);

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [
      ['type', ['\b'.repeat(50)]],
      ['type', ['\b'.repeat(12)]],
      [
        '__maestroTapOn',
        ['id="childActionButton"', JSON.stringify({ childOf: 'id="parent-row-secondary"' })],
      ],
      ['__maestroTapOn', ['id="overflowButton"', JSON.stringify({ index: 0 })]],
      ['__maestroTapOn', ['label="Profile name" || text="Profile name" || id="Profile name"']],
      ['__maestroSwipeOn', ['id="reorder-handle"', 'up', '350']],
    ],
  );
});

test('parseMaestroReplayFlow preserves runScript as an ordered runtime action', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-runscript-'));
  const scriptPath = path.join(root, 'setup.js');
  const flowPath = path.join(root, 'flow.yml');
  fs.writeFileSync(scriptPath, `output.result = SERVER_PATH`);

  const parsed = parseMaestroReplayFlow(
    `appId: com.callstack.agentdevicelab
---
- runScript:
    file: ./setup.js
    env:
      SERVER_PATH: local
- inputText: \${output.result}
`,
    { sourcePath: flowPath },
  );

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [
      ['__maestroRunScript', [scriptPath]],
      ['type', ['${output.result}']],
    ],
  );
  assert.deepEqual(parsed.actions[0]?.flags.maestro?.runScriptEnv, { SERVER_PATH: 'local' });
});

test('parseMaestroReplayFlow keeps focused inputText and pressKey Enter as separate actions', () => {
  const parsed = parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- inputText: hello
- pressKey: Enter
- inputText: world
`);

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [
      ['type', ['hello']],
      ['__maestroPressEnter', []],
      ['type', ['world']],
    ],
  );
  assert.deepEqual(parsed.actionLines, [3, 4, 5]);
});

test('parseMaestroReplayFlow keeps tapOn inputText without Enter on Maestro path', () => {
  const parsed = parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- tapOn:
    id: editableNameInput
- inputText: Saved list
`);

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [
      ['__maestroTapOn', ['id="editableNameInput"']],
      ['type', ['Saved list']],
    ],
  );
  assert.deepEqual(parsed.actionLines, [3, 5]);
  assert.equal(parsed.actions[0]?.flags?.maestro?.allowNonHittableCoordinateFallback, true);
});

test('parseMaestroReplayFlow preserves optional tapOn before inputText without Enter', () => {
  const parsed = parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- tapOn:
    id: editableNameInput
    optional: true
- inputText: Saved list
`);

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [
      ['__maestroTapOn', ['id="editableNameInput"']],
      ['type', ['Saved list']],
    ],
  );
  assert.deepEqual(parsed.actionLines, [3, 6]);
  assert.equal(parsed.actions[0]?.flags?.maestro?.optional, true);
  assert.equal(parsed.actions[0]?.flags?.maestro?.allowNonHittableCoordinateFallback, true);
});

test('parseMaestroReplayFlow coalesces tapOn inputText while preserving pressKey Enter submit', () => {
  const parsed = parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- tapOn:
    id: e2eProxyHeaderInput
- inputText: \${output.result}
- pressKey: Enter
`);

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [
      ['wait', ['id="e2eProxyHeaderInput"', '30000']],
      ['fill', ['id="e2eProxyHeaderInput"', '${output.result}']],
      ['__maestroPressEnter', []],
    ],
  );
  assert.deepEqual(parsed.actionLines, [3, 3, 6]);
  assert.equal(parsed.actions[1]?.flags?.maestro?.allowNonHittableCoordinateFallback, true);
});

test('parseMaestroReplayFlow does not coalesce text entry for non-input-looking targets', () => {
  const parsed = parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- tapOn: Continue
- inputText: unexpected
- pressKey: Enter
`);

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [
      ['__maestroTapOn', ['label="Continue" || text="Continue" || id="Continue"']],
      ['type', ['unexpected']],
      ['__maestroPressEnter', []],
    ],
  );
  assert.equal(parsed.actions[0]?.flags?.maestro?.allowNonHittableCoordinateFallback, undefined);
});

test('parseMaestroReplayFlow maps focused input commands to native type and keyboard actions', () => {
  const parsed = parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- inputText: hello
- eraseText:
    charactersToErase: 3
- pasteText: pasted
- pressKey: Return
`);

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [
      ['type', ['hello']],
      ['type', ['\b'.repeat(3)]],
      ['type', ['pasted']],
      ['__maestroPressEnter', []],
    ],
  );
});

test('parseMaestroReplayFlow rejects relative runScript paths without source path', () => {
  assert.throws(
    () =>
      parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- runScript: ./setup.js
`),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /runScript file paths/.test(error.message),
  );
});

test('parseMaestroReplayFlow rejects unsupported Maestro commands', () => {
  assert.throws(
    () => parseMaestroReplayFlow('---\n- travelThroughTime: Save\n'),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /travelThroughTime/.test(error.message) &&
      /issues\/558/.test(error.message) &&
      /issues\/new/.test(error.message) &&
      /line 2/.test(error.message),
  );
});

test('parseMaestroReplayFlow preserves selector state and absolute swipe commands', () => {
  const parsed = parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- assertVisible:
    id: shipping-pickup
    selected: true
- swipe:
    start: 100, 500
    end: 100, 200
    duration: 300
`);

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [
      ['__maestroAssertVisible', ['id="shipping-pickup" selected="true"', '17000']],
      ['swipe', ['100', '500', '100', '200', '300']],
    ],
  );
  assert.deepEqual(parsed.actionLines, [3, 6]);
});

test('parseMaestroReplayFlow maps extendedWaitUntil.notVisible through Maestro visibility assertions', () => {
  const parsed = parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- extendedWaitUntil:
    notVisible:
      text: Loading
    timeout: 1200
`);

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [['__maestroAssertNotVisible', ['label="Loading" || text="Loading" || id="Loading"', '1200']]],
  );
});

test('parseMaestroReplayFlow applies the Maestro default to extendedWaitUntil.visible', () => {
  const parsed = parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- extendedWaitUntil:
    visible:
      text: Ready
`);

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [['__maestroAssertVisible', ['label="Ready" || text="Ready" || id="Ready"', '17000']]],
  );
});

test('parseMaestroReplayFlow rejects deferred Maestro utility commands loudly', () => {
  assert.throws(
    () => parseMaestroReplayFlow('---\n- assertTrue: "${READY}"\n'),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /assertTrue/.test(error.message) &&
      /issues\/558/.test(error.message) &&
      /line 2/.test(error.message),
  );

  assert.throws(
    () => parseMaestroReplayFlow('---\n- setPermissions:\n    camera: allow\n'),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /setPermissions/.test(error.message) &&
      /issues\/558/.test(error.message) &&
      /line 2/.test(error.message),
  );
});

test('parseMaestroReplayFlow rejects unsupported fields instead of ignoring them', () => {
  assert.throws(
    () =>
      parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- tapOn:
    id: submit-order
    retryTapIfNoChange: true
`),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /retryTapIfNoChange/.test(error.message) &&
      /issues\/558/.test(error.message) &&
      /line 3/.test(error.message),
  );
});

test('parseMaestroReplayFlow reports top-level command lines around nested lists', () => {
  assert.throws(
    () =>
      parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- runFlow:
    commands:
      - tapOn: Nested
- travelThroughTime: Save
`),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /travelThroughTime/.test(error.message) &&
      /line 6/.test(error.message),
  );
});

test('parseMaestroReplayFlow flattens hooks, file runFlow, inline runFlow, env, and repeat times', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-flow-'));
  const childPath = path.join(root, 'child.yaml');
  fs.writeFileSync(
    childPath,
    `appId: com.child.app
---
- tapOn: "\${CHILD_LABEL}"
- repeat:
    times: \${COUNT}
    commands:
      - tapOn:
          id: child-repeat
`,
  );

  const parsed = parseMaestroReplayFlow(
    `appId: com.callstack.agentdevicelab
env:
  COUNT: "2"
onFlowStart:
  - tapOn: Before
onFlowComplete:
  - tapOn: After
---
- runFlow:
    file: child.yaml
    env:
      CHILD_LABEL: Nested
- runFlow:
    when:
      platform: iOS
    commands:
      - tapOn: iOS only
- repeat:
    times: 2
    commands:
      - tapOn: Again
`,
    { sourcePath: path.join(root, 'main.yaml'), platform: 'ios' },
  );

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [
      ['__maestroTapOn', ['label="Before" || text="Before" || id="Before"']],
      ['__maestroTapOn', ['label="Nested" || text="Nested" || id="Nested"']],
      ['__maestroTapOn', ['id="child-repeat"']],
      ['__maestroTapOn', ['id="child-repeat"']],
      ['__maestroTapOn', ['label="iOS only" || text="iOS only" || id="iOS only"']],
      ['__maestroTapOn', ['label="Again" || text="Again" || id="Again"']],
      ['__maestroTapOn', ['label="Again" || text="Again" || id="Again"']],
      ['__maestroTapOn', ['label="After" || text="After" || id="After"']],
    ],
  );
});

test('parseMaestroReplayFlow skips platform-gated runFlow commands for other platforms', () => {
  const parsed = parseMaestroReplayFlow(
    `appId: com.callstack.agentdevicelab
---
- runFlow:
    when:
      platform: Android
    commands:
      - tapOn: Android only
- tapOn: Shared
`,
    { platform: 'ios' },
  );

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [['__maestroTapOn', ['label="Shared" || text="Shared" || id="Shared"']]],
  );
});

test('parseMaestroReplayFlow treats Web platform gates as non-native branches', () => {
  const parsed = parseMaestroReplayFlow(
    `appId: com.callstack.agentdevicelab
---
- runFlow:
    when:
      platform: Web
    commands:
      - tapOn: Web only
- tapOn: Native
`,
    { platform: 'ios' },
  );

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [['__maestroTapOn', ['label="Native" || text="Native" || id="Native"']]],
  );
});

test('parseMaestroReplayFlow evaluates simple runFlow.when.true platform expressions', () => {
  const parsed = parseMaestroReplayFlow(
    `appId: com.callstack.agentdevicelab
---
- runFlow:
    when:
      true: \${maestro.platform == 'android' || maestro.platform == 'ios'}
    commands:
      - tapOn: Native
- runFlow:
    when:
      true: \${maestro.platform == 'web' || maestro.platform == 'android'}
    commands:
      - tapOn: Not iOS
`,
    { platform: 'ios' },
  );

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [['__maestroTapOn', ['label="Native" || text="Native" || id="Native"']]],
  );
});

test('parseMaestroReplayFlow keeps visible-gated runFlow commands for runtime evaluation', () => {
  const parsed = parseMaestroReplayFlow(
    `appId: com.callstack.agentdevicelab
---
- runFlow:
    when:
      visible: Continue
    commands:
      - tapOn: Continue
`,
    { platform: 'ios' },
  );

  assert.equal(parsed.actions[0]?.command, 'runFlow.when');
  assert.deepEqual(parsed.actions[0]?.positionals, [
    'visible',
    'label="Continue" || text="Continue" || id="Continue"',
  ]);
  const control = parsed.actions[0]?.replayControl;
  assert.equal(control?.kind, 'maestroRunFlowWhen');
  if (control?.kind !== 'maestroRunFlowWhen') throw new Error('expected runFlow.when control');
  assert.equal(control.mode, 'visible');
  assert.equal(control.selector, 'label="Continue" || text="Continue" || id="Continue"');
  assert.deepEqual(
    control.actions.map((entry) => [entry.command, entry.positionals, entry.flags]),
    [
      [
        '__maestroTapOn',
        ['label="Continue" || text="Continue" || id="Continue"'],
        { maestro: { allowNonHittableCoordinateFallback: true } },
      ],
    ],
  );
});

test('parseMaestroReplayFlow keeps retry commands for runtime evaluation', () => {
  const parsed = parseMaestroReplayFlow(
    `appId: com.callstack.agentdevicelab
---
- retry:
    maxRetries: 3
    commands:
      - openLink:
          link: \${APP_SCHEME}details
      - assertVisible: Article
`,
    { env: { APP_SCHEME: 'example://' } },
  );

  assert.equal(parsed.actions[0]?.command, 'retry');
  assert.deepEqual(parsed.actions[0]?.positionals, ['3']);
  const control = parsed.actions[0]?.replayControl;
  assert.equal(control?.kind, 'retry');
  if (control?.kind !== 'retry') throw new Error('expected retry control');
  assert.equal(control.maxRetries, 3);
  assert.deepEqual(
    control.actions.map((entry) => [entry.command, entry.positionals, entry.flags]),
    [
      ['open', ['example://details'], {}],
      [
        '__maestroAssertVisible',
        ['label="Article" || text="Article" || id="Article"', '17000'],
        {},
      ],
    ],
  );
});

test('parseMaestroReplayFlow accepts launchApp reset options', () => {
  const parsed = parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- launchApp:
    clearState: true
    arguments:
      "-EXDevMenuIsOnboardingFinished": true
    launchArguments:
      "-Example": "ignored"
    stopApp: true
`);

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals, entry.flags]),
    [
      [
        'open',
        ['com.callstack.agentdevicelab'],
        {
          clearAppState: true,
          launchArgs: ['-EXDevMenuIsOnboardingFinished', 'true', '-Example', 'ignored'],
        },
      ],
    ],
  );
});

test('parseMaestroReplayFlow rejects clearKeychain instead of ignoring it', () => {
  assert.throws(
    () =>
      parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- launchApp:
    clearKeychain: true
`),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /clearKeychain/.test(error.message),
  );
});

test('parseMaestroReplayFlow relaunches launchApp only when clearState is absent', () => {
  const withLaunchArgs = parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- launchApp:
    arguments:
      "-Example": "value"
`);
  const withStopApp = parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- launchApp:
    stopApp: true
`);

  assert.equal(withLaunchArgs.actions[0]?.flags.relaunch, true);
  assert.equal(withStopApp.actions[0]?.flags.relaunch, true);
});

test('parseMaestroReplayFlow rejects unsupported runtime-dependent flow control', () => {
  assert.throws(
    () =>
      parseMaestroReplayFlow(`appId: com.callstack.agentdevicelab
---
- repeat:
    while:
      notVisible: Done
    times: 3
    commands:
      - tapOn: Again
`),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /repeat.while/.test(error.message) &&
      /line 3/.test(error.message),
  );
});

test('parseMaestroReplayFlow parses the test-app Maestro suite fixture', () => {
  const fixturePath = path.resolve('examples/test-app/maestro/checkout-form.yaml');
  const parsed = parseMaestroReplayFlow(fs.readFileSync(fixturePath, 'utf8'), {
    sourcePath: fixturePath,
    platform: 'ios',
  });

  assert.deepEqual(
    parsed.actions.map((entry) => entry.command),
    [
      'open',
      '__maestroAssertVisible',
      '__maestroScrollUntilVisible',
      '__maestroTapOn',
      '__maestroAssertVisible',
      '__maestroTapOn',
      'type',
      '__maestroTapOn',
      'type',
      '__maestroTapOn',
      '__maestroAssertVisible',
      '__maestroAssertVisible',
      '__maestroSwipeScreen',
      '__maestroTapOn',
      '__maestroAssertVisible',
      '__maestroTapOn',
      '__maestroAssertVisible',
      '__maestroTapOn',
      '__maestroAssertVisible',
      '__maestroAssertVisible',
    ],
  );
  assert.equal(parsed.actions[0]?.flags.clearAppState, true);
});
