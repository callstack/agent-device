import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import {
  assertElementText,
  assertElementTextAfterScrolling,
  assertFilesDiffer,
  assertJsonContains,
  assertMp4File,
  assertNonEmptyFile,
  assertWaitText,
  capturePng,
} from './live-assertions.ts';
import {
  collectPagedEventTimeline,
  type EventTimelinePage,
} from '../live-device-e2e/event-timeline.ts';
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

  const bottomEdge = await runStep(context, 'scroll automation route to the bottom edge', [
    'scroll',
    'bottom',
    '0.75',
  ]);
  assert.equal(bottomEdge.json?.data?.edge, 'bottom', JSON.stringify(bottomEdge.json));
  assert.ok(
    Number(bottomEdge.json?.data?.passes) > 0,
    `bottom edge traversal must execute a live scroll: ${JSON.stringify(bottomEdge.json)}`,
  );
  verifyCommand(
    context,
    C.scroll,
    'bottom-edge traversal executes at least one live scroll pass and reports the reached edge',
  );

  await setMicrophonePermissionAndRestart(context, 'initial', 'reset', 'undetermined');
  await setMicrophonePermissionAndRestart(context, 'grant', 'grant', 'granted');
  await setMicrophonePermissionAndRestart(context, 'denial', 'deny', 'denied');
  await setMicrophonePermissionAndRestart(context, 'recovery', 'reset', 'undetermined');
  await runStep(context, 'reset microphone permission after scenario', [
    'settings',
    'permission',
    'reset',
    'microphone',
  ]);
  await runStep(context, 'clear fixture state after permission scenario', [
    'settings',
    'clear-app-state',
    context.appId,
  ]);
  await runStep(context, 'open fixture after permission cleanup', ['open', context.appId]);
  await runStep(context, 'restore automation route after permission cleanup', [
    'trigger-app-event',
    'fixture.permission.cleanup',
    '{"source":"permission-cleanup"}',
  ]);
  await assertWaitText(context, 'Automation lab');
  verifyBehavior(
    context,
    'permission-state-recovery',
    'reset, grant, denial, and a second reset were all observed through the fixture permission API',
  );
  await runStep(context, 'set dark appearance', ['settings', 'appearance', 'dark']);
  await assertElementText(context, 'id="automation-appearance"', 'dark');
  await runStep(context, 'restore light appearance', ['settings', 'appearance', 'light']);
  await assertElementText(context, 'id="automation-appearance"', 'light');
  verifyCommand(
    context,
    C.settings,
    'permission reset/deny/grant and appearance dark/light all produce durable evidence',
  );

  // XCUIDevice models physical device orientation, which is intentionally not
  // coupled to an app's interface orientation. Assert the exact typed states
  // accepted by the native runner instead of overclaiming a window resize.
  const landscape = await runStep(context, 'rotate landscape', ['orientation', 'landscape-left']);
  assert.equal(landscape.json?.data?.orientation, 'landscape-left', JSON.stringify(landscape.json));
  const portrait = await runStep(context, 'restore portrait', ['orientation', 'portrait']);
  assert.equal(portrait.json?.data?.orientation, 'portrait', JSON.stringify(portrait.json));
  verifyCommand(
    context,
    C.orientation,
    'native runner reads back exact landscape-left and portrait device states',
  );

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
  const switcherSurface = await runStep(context, 'inspect covered fixture in app switcher', [
    'snapshot',
    '-i',
  ]);
  const switcherNodes = Array.isArray(switcherSurface.json?.data?.nodes)
    ? switcherSurface.json.data.nodes
    : [];
  const fixtureControl = switcherNodes.find(
    (node: { identifier?: unknown }) => node.identifier === 'automation-press',
  );
  assert.ok(fixtureControl, JSON.stringify(switcherSurface.json));
  // The system app switcher is outside the app accessibility tree. Its screenshot proves the
  // visual cover, while this tree must retain geometric actionability and must not invent a
  // structured daemon occlusion reason for an overlay the runner never captured.
  assert.equal(fixtureControl.hittable, true, JSON.stringify(fixtureControl));
  assert.equal(fixtureControl.interactionBlocked, undefined, JSON.stringify(fixtureControl));
  assert.equal(
    switcherNodes.some(
      (node: { hittable?: unknown; type?: unknown }) =>
        node.type === 'Button' && node.hittable === true,
    ),
    true,
    'app switcher must not turn geometric actionability into runner-side occlusion',
  );
  const rawSwitcherSurface = await runStep(context, 'inspect raw fixture in app switcher', [
    'snapshot',
    '--raw',
  ]);
  const rawSwitcherNodes = Array.isArray(rawSwitcherSurface.json?.data?.nodes)
    ? rawSwitcherSurface.json.data.nodes
    : [];
  const rawFixtureControl = rawSwitcherNodes.find(
    (node: { identifier?: unknown }) => node.identifier === 'automation-press',
  );
  assert.ok(rawFixtureControl, JSON.stringify(rawSwitcherSurface.json));
  assert.equal(rawFixtureControl.hittable, true, JSON.stringify(rawFixtureControl));
  assert.equal(rawFixtureControl.interactionBlocked, undefined, JSON.stringify(rawFixtureControl));
  assert.equal(rawSwitcherSurface.json?.data?.snapshotQuality?.backend, 'tree');
  assert.ok(
    Number(rawSwitcherSurface.json?.data?.snapshotDiagnostics?.stats?.backends?.xctest) > 0,
    JSON.stringify(rawSwitcherSurface.json),
  );
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
    'app switcher visibly covers the app while regular/raw trees retain geometric actionability',
  );
  verifyBehavior(
    context,
    'interrupted-system-ui-flow',
    'Home and app switcher produced distinct system surfaces before fixture restoration',
  );

  await runStep(context, 'restore fixture after system UI', ['open', context.appId]);
  await assertWaitText(context, 'Automation lab');
}

async function setMicrophonePermissionAndRestart(
  context: LiveContext,
  phase: 'initial' | 'denial' | 'recovery' | 'grant',
  action: 'deny' | 'grant' | 'reset',
  expected: 'denied' | 'granted' | 'undetermined',
): Promise<void> {
  // Terminate the app before changing TCC so its live permission requester
  // cannot retain the previous state. Clearing data preserves the installed
  // cached binary and exercises settings permission without depending on a
  // transient system prompt racing XCTest reconnection on hosted simulators.
  await runStep(context, `clear fixture state before ${phase} permission ${action}`, [
    'settings',
    'clear-app-state',
    context.appId,
  ]);
  await runStep(context, `${action} microphone permission for ${phase} state`, [
    'settings',
    'permission',
    action,
    'microphone',
  ]);
  await runStep(context, `open fixture after ${phase} permission ${action}`, [
    'open',
    context.appId,
  ]);
  await runStep(context, `restore automation route after ${phase} permission ${action}`, [
    'trigger-app-event',
    `fixture.permission.${phase}`,
    `{"source":"permission-${phase}"}`,
  ]);
  await assertWaitText(context, 'Automation lab');
  await assertElementTextAfterScrolling(context, 'id="automation-microphone-permission"', expected);
}

export async function assertObservabilityAndArtifacts(context: LiveContext): Promise<void> {
  const perf = await runStep(context, 'read fixture memory metrics', ['perf', 'memory', 'sample']);
  const metrics = perf.json?.data?.metrics;
  assert.equal(metrics?.memory?.available, true, JSON.stringify(perf.json));
  assert.ok(Number(metrics?.memory?.residentMemoryKb) > 0, JSON.stringify(perf.json));
  assert.deepEqual(Object.keys(metrics ?? {}), ['memory']);
  verifyCommand(context, C.perf, 'iOS process memory metrics are typed and numeric');

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
  await assertMp4File(recordingPath);
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

  const eventTimeline = await collectPagedEventTimeline(async (cursor) => {
    const events = await runStep(
      context,
      cursor === undefined
        ? 'read session event timeline'
        : `read session event timeline from cursor ${cursor}`,
      cursor === undefined ? ['events', '100'] : ['events', '100', cursor],
    );
    return (events.json?.data ?? {}) as EventTimelinePage;
  });
  assert.ok(
    eventTimeline.pages.length > 1,
    `live events coverage must traverse multiple pages: ${JSON.stringify(eventTimeline.pages)}`,
  );

  for (const command of [C.open, C.press, C.snapshot]) {
    assert.ok(
      eventTimeline.commands.includes(command),
      `events missing ${command}: ${JSON.stringify(eventTimeline)}`,
    );
  }
  verifyCommand(
    context,
    C.events,
    'paged typed event entries name open, press, and snapshot across the full timeline',
  );

  const reactNative = await runStep(context, 'inspect Release overlay state', [
    'react-native',
    'dismiss-overlay',
  ]);
  assert.equal(reactNative.json?.data?.detected, false, JSON.stringify(reactNative.json));
  assert.equal(reactNative.json?.data?.dismissed, false, JSON.stringify(reactNative.json));
  verifyCommand(context, C.reactNative, 'Release fixture returns a typed no-overlay verdict');
}
