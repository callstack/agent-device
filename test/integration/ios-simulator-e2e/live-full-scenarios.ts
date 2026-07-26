import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import {
  assertElementText,
  assertFilesDiffer,
  assertJsonContains,
  assertMp4File,
  assertNonEmptyFile,
  assertWaitText,
  capturePng,
} from './live-assertions.ts';
import { type LiveContext, runStep, verifyBehavior, verifyCommand } from './live-harness.ts';

const C = PUBLIC_COMMANDS;

export async function assertLifecycleAndSystem(context: LiveContext): Promise<void> {
  const appState = await runStep(context, 'read fixture app state', ['appstate']);
  assert.equal(appState.json?.data?.appBundleId, context.appId, JSON.stringify(appState.json));
  assert.equal(appState.json?.data?.source, 'session', JSON.stringify(appState.json));
  assert.equal(appState.json?.data?.device_udid, context.udid, JSON.stringify(appState.json));
  verifyCommand(context, C.appState, 'typed appstate retains active session and fixture identity');

  const clipboardValue = 'Zażółć gęślą 🧪';
  await runStep(context, 'write Unicode clipboard', ['clipboard', 'write', clipboardValue]);
  const clipboard = await runStep(context, 'read Unicode clipboard', ['clipboard', 'read']);
  assertJsonContains(clipboard, clipboardValue, 'clipboard should round-trip Unicode text');
  verifyCommand(context, C.clipboard, 'Unicode clipboard value round-trips exactly');

  await runStep(context, 'open automation route through app event', [
    'trigger-app-event',
    'fixture.ready',
    '{"source":"ios-e2e","count":7}',
  ]);
  await runStep(context, 'return to top-level event canaries', ['scroll', 'top']);
  await assertElementText(context, 'id="automation-event-name"', 'fixture.ready');
  await assertElementText(
    context,
    'id="automation-event-payload"',
    '{"source":"ios-e2e","count":7}',
  );
  verifyCommand(context, C.triggerAppEvent, 'deep event name and JSON payload render exactly');

  await runStep(context, 'reset microphone permission before prompt recovery', [
    'settings',
    'permission',
    'reset',
    'microphone',
  ]);
  await clickMicrophonePermission(context, 'request microphone permission for denial');
  await runStep(context, 'wait for microphone permission prompt', ['alert', 'wait', '5000']);
  await runStep(context, 'deny microphone permission prompt', ['alert', 'dismiss']);
  await assertElementText(context, 'id="automation-microphone-permission"', 'denied');

  await runStep(context, 'reset denied microphone permission', [
    'settings',
    'permission',
    'reset',
    'microphone',
  ]);
  await runStep(context, 'restore automation route after permission reset', [
    'trigger-app-event',
    'fixture.permission.recovery',
    '{"source":"permission-reset"}',
  ]);
  await assertWaitText(context, 'Automation lab');
  await clickMicrophonePermission(context, 'request microphone permission after reset');
  await runStep(context, 'wait for recovered microphone permission prompt', [
    'alert',
    'wait',
    '5000',
  ]);
  await runStep(context, 'accept recovered microphone permission prompt', ['alert', 'accept']);
  await assertElementText(context, 'id="automation-microphone-permission"', 'granted');
  await runStep(context, 'reset microphone permission after scenario', [
    'settings',
    'permission',
    'reset',
    'microphone',
  ]);
  await runStep(context, 'restore automation route after permission cleanup', [
    'trigger-app-event',
    'fixture.permission.cleanup',
    '{"source":"permission-cleanup"}',
  ]);
  await assertWaitText(context, 'Automation lab');
  verifyBehavior(
    context,
    'permission-prompt-recovery',
    'denial was observed before reset produced a second prompt whose acceptance was observed',
  );

  await runStep(context, 'return to runtime canaries', ['scroll', 'top']);

  await runStep(context, 'set dark appearance', ['settings', 'appearance', 'dark']);
  await assertElementText(context, 'id="automation-appearance"', 'dark');
  await runStep(context, 'restore light appearance', ['settings', 'appearance', 'light']);
  await assertElementText(context, 'id="automation-appearance"', 'light');
  verifyCommand(
    context,
    C.settings,
    'permission denial/reset/recovery and appearance dark/light both produce durable evidence',
  );

  await runStep(context, 'rotate landscape', ['orientation', 'landscape-left']);
  await assertElementText(context, 'id="automation-window"', 'landscape');
  await runStep(context, 'restore portrait', ['orientation', 'portrait']);
  await assertElementText(context, 'id="automation-window"', 'portrait');
  verifyCommand(context, C.orientation, 'window canary changes to landscape and restores portrait');

  const foregroundPath = path.join(context.artifactDir, 'system-foreground.png');
  await capturePng(context, 'capture foreground system baseline', foregroundPath);
  await runStep(context, 'background fixture to home', ['home']);
  const homePath = path.join(context.artifactDir, 'system-home.png');
  await capturePng(context, 'capture Home screen', homePath);
  assertFilesDiffer(foregroundPath, homePath, 'Home should replace the foreground fixture');

  await runStep(context, 'restore fixture after Home', ['open', context.appId]);
  await assertWaitText(context, 'Automation lab');
  const lastNonActive = await runStep(context, 'read persisted Home transition', [
    'get',
    'text',
    'id="automation-last-nonactive"',
  ]);
  const lastNonActiveState = lastNonActive.json?.data?.text;
  assert.ok(
    lastNonActiveState === 'inactive' || lastNonActiveState === 'background',
    `Home should produce a non-active app transition: ${JSON.stringify(lastNonActive.json)}`,
  );
  const restoredForegroundPath = path.join(context.artifactDir, 'system-restored-foreground.png');
  await capturePng(context, 'capture restored foreground fixture', restoredForegroundPath);
  verifyCommand(context, C.home, 'Home pixels replace the fixture and its transition is persisted');
  verifyBehavior(
    context,
    'background-foreground-resume',
    'Home transition persisted while the fixture was backgrounded and survived foreground restore',
  );

  await runStep(context, 'open app switcher', ['app-switcher']);
  const switcherPath = path.join(context.artifactDir, 'system-app-switcher.png');
  await capturePng(context, 'capture app switcher', switcherPath);
  assertFilesDiffer(homePath, switcherPath, 'app switcher should differ from Home');
  assertFilesDiffer(
    restoredForegroundPath,
    switcherPath,
    'app switcher should differ from the foreground fixture',
  );
  verifyCommand(
    context,
    C.appSwitcher,
    'app switcher pixels differ from both Home and the foreground fixture',
  );
  verifyBehavior(
    context,
    'interrupted-system-ui-flow',
    'Home and app switcher produced distinct system surfaces before fixture restoration',
  );

  await runStep(context, 'restore fixture after system UI', ['open', context.appId]);
  await assertWaitText(context, 'Automation lab');
}

async function clickMicrophonePermission(context: LiveContext, step: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const clicked = await runStep(
      context,
      `${step} (attempt ${attempt + 1})`,
      ['click', 'id="automation-request-microphone"'],
      { allowFailure: true },
    );
    if (clicked.status === 0) return;
    const reason = clicked.json?.error?.details?.reason;
    const code = clicked.json?.error?.code;
    assert.ok(
      reason === 'selector_not_found' ||
        reason === 'offscreen_selector' ||
        (reason === undefined && code === 'COMMAND_FAILED'),
      `unexpected permission click failure: ${JSON.stringify(clicked.json)}`,
    );
    if (attempt < 3) {
      await runStep(context, 'scroll toward microphone permission', [
        'scroll',
        'down',
        '--pixels',
        '280',
      ]);
    }
  }
  assert.fail('microphone permission canary did not become safely clickable');
}

export async function assertObservabilityAndArtifacts(context: LiveContext): Promise<void> {
  const perf = await runStep(context, 'read fixture performance metrics', ['perf', 'metrics']);
  const metrics = perf.json?.data?.metrics;
  assert.equal(metrics?.startup?.available, true, JSON.stringify(perf.json));
  assert.ok(Number(metrics?.startup?.lastDurationMs) > 0, JSON.stringify(perf.json));
  assert.equal(metrics?.memory?.available, true, JSON.stringify(perf.json));
  assert.ok(Number(metrics?.memory?.residentMemoryKb) > 0, JSON.stringify(perf.json));
  assert.equal(metrics?.cpu?.available, true, JSON.stringify(perf.json));
  assert.ok(Number.isFinite(Number(metrics?.cpu?.usagePercent)), JSON.stringify(perf.json));
  verifyCommand(context, C.perf, 'startup, memory, and CPU process metrics are typed and numeric');

  const logsStart = await runStep(context, 'start fixture log stream', ['logs', 'start']);
  assert.equal(logsStart.json?.data?.started, true, JSON.stringify(logsStart.json));
  assert.ok(fs.existsSync(String(logsStart.json?.data?.path)), JSON.stringify(logsStart.json));
  const logsPath = await runStep(context, 'inspect fixture log stream', ['logs', 'path']);
  assert.equal(logsPath.json?.data?.active, true, JSON.stringify(logsPath.json));
  assert.equal(logsPath.json?.data?.backend, 'ios-simulator', JSON.stringify(logsPath.json));
  assert.ok(fs.existsSync(String(logsPath.json?.data?.path)), JSON.stringify(logsPath.json));
  const logsStop = await runStep(context, 'stop fixture log stream', ['logs', 'stop']);
  assert.equal(logsStop.json?.data?.stopped, true, JSON.stringify(logsStop.json));
  verifyCommand(context, C.logs, 'iOS simulator log stream starts, exposes app.log, and stops');

  const tracePath = path.join(context.artifactDir, 'fixture.adtrace');
  const traceStart = await runStep(context, 'start interaction trace', [
    'trace',
    'start',
    tracePath,
  ]);
  assertJsonContains(traceStart, 'started', 'trace start should return typed started state');
  assertJsonContains(traceStart, tracePath, 'trace start should retain the requested output path');
  await runStep(context, 'trace a visible mutation', ['press', 'id="automation-press"']);
  const traceStop = await runStep(context, 'stop interaction trace', ['trace', 'stop', tracePath]);
  assertJsonContains(traceStop, 'stopped', 'trace stop should return typed stopped state');
  assertJsonContains(traceStop, tracePath, 'trace stop should retain the requested output path');
  assertNonEmptyFile(tracePath, 'trace');
  verifyCommand(context, C.trace, 'traced press produces a non-empty trace at the requested path');

  const recordingPath = path.join(context.artifactDir, 'fixture.mp4');
  await runStep(context, 'start screen recording', [
    'record',
    'start',
    recordingPath,
    '--hide-touches',
  ]);
  await runStep(context, 'record a visible mutation', ['press', 'id="automation-press"']);
  await runStep(context, 'stop screen recording', ['record', 'stop']);
  assertMp4File(recordingPath);
  verifyCommand(context, C.record, 'visible mutation produces a non-empty playable MP4');

  const batch = await runStep(context, 'run semantic read batch', [
    'batch',
    '--steps',
    JSON.stringify([
      {
        command: 'get',
        input: {
          format: 'text',
          target: { kind: 'selector', selector: 'id="automation-press"' },
        },
      },
      {
        command: 'is',
        input: { predicate: 'visible', selector: 'id="automation-press"' },
      },
    ]),
  ]);
  assertJsonContains(batch, 'Press canary', 'batch should contain nested get result');
  assertJsonContains(batch, '"pass":true', 'batch should contain passing nested is result');
  verifyCommand(context, C.batch, 'batch returns semantic nested get and is results');

  const events = await runStep(context, 'read session event timeline', ['events', '100']);
  const eventCommands = Array.isArray(events.json?.data?.events)
    ? events.json.data.events.map((event: { command?: unknown }) => event.command)
    : [];
  for (const command of [C.open, C.press, C.snapshot]) {
    assert.ok(
      eventCommands.includes(command),
      `events missing ${command}: ${JSON.stringify(events.json)}`,
    );
  }
  verifyCommand(context, C.events, 'typed event entries name open, press, and snapshot');

  const reactNative = await runStep(context, 'inspect Release overlay state', [
    'react-native',
    'dismiss-overlay',
  ]);
  assert.equal(reactNative.json?.data?.detected, false, JSON.stringify(reactNative.json));
  assert.equal(reactNative.json?.data?.dismissed, false, JSON.stringify(reactNative.json));
  verifyCommand(context, C.reactNative, 'Release fixture returns a typed no-overlay verdict');
}
