import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  buildGesturePlan,
  gesturePayloadFromPositionals,
  normalizePublicGesture,
  normalizePublicSwipeMotion,
  swipePayloadFromPositionals,
} from '@agent-device/contracts/interaction';
import { PUBLIC_COMMANDS } from '../../src/command-catalog.ts';
import { isCommandSupportedOnDevice } from '../../src/core/capabilities.ts';
import { parseReplayScriptDetailed } from '@agent-device/ad-script';
import { isValidSelectorExpression } from '@agent-device/selectors';
import { IOS_SIMULATOR_BEHAVIOR_COVERAGE } from './ios-simulator-e2e/behavior-coverage.ts';
import {
  IOS_SIMULATOR_E2E_COVERAGE,
  liveCommandsForScenario,
} from './ios-simulator-e2e/coverage-manifest.ts';
import { collectPagedEventTimeline } from './live-device-e2e/event-timeline.ts';
import { findMissingFixtureIdentifiers } from './ios-simulator-e2e/fixture-identifier-coverage.ts';
import { IOS_SIMULATOR_LIVE_SCENARIOS } from './ios-simulator-e2e/scenarios.ts';

const IOS_SIMULATOR = {
  appleOs: 'ios' as const,
  id: 'ci-ios-simulator',
  kind: 'simulator' as const,
  name: 'CI iPhone',
  platform: 'apple' as const,
  target: 'mobile' as const,
};

test('iOS simulator coverage exhaustively classifies the public catalog', () => {
  const publicCommands = Object.values(PUBLIC_COMMANDS).sort();
  assert.deepEqual(Object.keys(IOS_SIMULATOR_E2E_COVERAGE).sort(), publicCommands);

  for (const command of publicCommands) {
    const entry = IOS_SIMULATOR_E2E_COVERAGE[command];
    assert.ok(entry.assertion.trim().length > 0, `${command} needs an observable assertion`);
    if (typeof entry.owner === 'string') {
      assert.ok(entry.owner.trim().length > 0, `${command} needs a concrete scenario owner`);
    } else {
      assert.ok(entry.owner.path.trim().length > 0, `${command} needs an evidence path`);
      assert.ok(entry.owner.test.trim().length > 0, `${command} needs named evidence`);
    }
  }
});

test('live command claims are owned by executable scenarios', () => {
  const scenariosById = new Map(
    IOS_SIMULATOR_LIVE_SCENARIOS.map((scenario) => [scenario.id, scenario]),
  );

  for (const [command, entry] of Object.entries(IOS_SIMULATOR_E2E_COVERAGE)) {
    if (entry.level !== 'live') continue;
    const scenario = scenariosById.get(entry.owner);
    assert.ok(scenario, `${command} references missing scenario ${entry.owner}`);
    assert.ok(
      liveCommandsForScenario(scenario.id).some((candidate) => candidate === command),
      `${entry.owner} does not execute ${command}`,
    );
  }

  const scenarioIds = IOS_SIMULATOR_LIVE_SCENARIOS.map((scenario) => scenario.id);
  assert.equal(new Set(scenarioIds).size, scenarioIds.length, 'scenario ids must be unique');
  const claimedCommands = IOS_SIMULATOR_LIVE_SCENARIOS.flatMap((scenario) =>
    liveCommandsForScenario(scenario.id),
  );
  assert.equal(
    new Set(claimedCommands).size,
    claimedCommands.length,
    'runtime command claims must have one primary scenario',
  );
});

test('mobile behavior patterns are owned by live scenarios or executable workflows', () => {
  const scenarioIds = new Set(IOS_SIMULATOR_LIVE_SCENARIOS.map((scenario) => scenario.id));
  for (const [behavior, entry] of Object.entries(IOS_SIMULATOR_BEHAVIOR_COVERAGE)) {
    assert.ok(entry.assertion.trim().length > 0, `${behavior} needs an observable assertion`);
    if (entry.level === 'live') {
      assert.ok(scenarioIds.has(entry.owner), `${behavior} references missing ${entry.owner}`);
    } else {
      const ownerPath = path.resolve(entry.owner.path);
      assert.ok(fs.existsSync(ownerPath), `${behavior} owner does not exist`);
      assert.ok(
        fs.readFileSync(ownerPath, 'utf8').includes(entry.owner.test),
        `${behavior} owner does not contain ${entry.owner.test}`,
      );
    }
  }
});

test('non-live owners name concrete executable repository evidence', () => {
  for (const [command, entry] of Object.entries(IOS_SIMULATOR_E2E_COVERAGE)) {
    if (entry.level === 'live') continue;
    const ownerPath = path.resolve(entry.owner.path);
    assert.ok(fs.existsSync(ownerPath), `${command} owner does not exist: ${entry.owner.path}`);
    assert.ok(
      fs.readFileSync(ownerPath, 'utf8').includes(entry.owner.test),
      `${command} owner does not contain named evidence: ${entry.owner.test}`,
    );
  }
});

test('fixture identifier coverage rejects direct-selector drift', () => {
  assert.deepEqual(
    findMissingFixtureIdentifiers(
      ['<Text testID="field-name" />'],
      [
        `await runStep(context, 'read field', ['get', 'text', 'id="field-typo"']);
nodes.find((node) => node.identifier === 'field-snapshot-typo');`,
      ],
    ),
    ['field-snapshot-typo', 'field-typo'],
  );
});

test('live iOS scenarios reference fixture identifiers that exist', () => {
  const readSources = (directory: string, includes: (fileName: string) => boolean) =>
    fs
      .readdirSync(directory)
      .filter(includes)
      .map((fileName) => fs.readFileSync(path.join(directory, fileName), 'utf8'));
  const fixtureSources = readSources('examples/test-app/src/screens', (fileName) =>
    fileName.endsWith('.tsx'),
  );
  const liveScenarioSources = readSources(
    'test/integration/ios-simulator-e2e',
    (fileName) => fileName.startsWith('live-') && fileName.endsWith('.ts'),
  );

  assert.deepEqual(
    findMissingFixtureIdentifiers(fixtureSources, liveScenarioSources),
    [],
    'live iOS scenarios must use test IDs defined by the fixture app',
  );
});

test('capability classifications match executable simulator behavior', () => {
  for (const [command, entry] of Object.entries(IOS_SIMULATOR_E2E_COVERAGE)) {
    if (command === PUBLIC_COMMANDS.viewport) {
      assert.equal(
        entry.level,
        'command-contract',
        'viewport admission belongs to the exact-owner runtime fact',
      );
      continue;
    }
    const supported = isCommandSupportedOnDevice(command, IOS_SIMULATOR);
    if (command === PUBLIC_COMMANDS.audio) {
      assert.equal(
        supported,
        process.platform === 'darwin',
        'simulator audio admission follows host ScreenCaptureKit availability',
      );
      continue;
    }
    if (entry.level === 'capability-denial') {
      assert.equal(supported, false, `${command} denial must match capability admission`);
    } else {
      assert.equal(supported, true, `${command} evidence requires simulator capability admission`);
    }
  }

  assert.equal(isCommandSupportedOnDevice(PUBLIC_COMMANDS.tvRemote, IOS_SIMULATOR), false);
  assert.equal(IOS_SIMULATOR_E2E_COVERAGE[PUBLIC_COMMANDS.tvRemote].level, 'capability-denial');

  assert.equal(
    IOS_SIMULATOR_E2E_COVERAGE[PUBLIC_COMMANDS.viewport].level,
    'command-contract',
    'viewport denial is owned by exact platform runtime facts',
  );
});

type ReplayAction = ReturnType<typeof parseReplayScriptDetailed>['actions'][number];
type Viewport = { height: number; width: number; x: number; y: number };

function assertReplayActionFitsViewport(action: ReplayAction, viewport: Viewport): void {
  const positionals = action.positionals ?? [];
  if (action.command === 'swipe') {
    const payload = swipePayloadFromPositionals(positionals);
    buildGesturePlan(normalizePublicSwipeMotion(payload).gesture, viewport, 'ios');
  }
  if (action.command === 'gesture') {
    const pointerCount =
      typeof action.flags.pointerCount === 'number' ? action.flags.pointerCount : undefined;
    const payload = gesturePayloadFromPositionals(positionals, pointerCount);
    buildGesturePlan(normalizePublicGesture(payload).gesture, viewport, 'ios');
  }
}

function assertReplayFitsViewports(replayPath: string, viewports: readonly Viewport[]): void {
  const actions = parseReplayScriptDetailed(fs.readFileSync(replayPath, 'utf8')).actions;
  for (const action of actions) {
    for (const viewport of viewports) assertReplayActionFitsViewport(action, viewport);
  }
}

test('fixture replay gestures fit the smallest supported iPhone viewport', () => {
  const compactViewports = [
    { x: 0, y: 0, width: 320, height: 568 },
    { x: 0, y: 0, width: 375, height: 667 },
  ];
  const replayPaths = [
    'test/integration/replays/ios/fixture/01-navigation-scroll.ad',
    'test/integration/replays/ios/fixture/02-checkout-release.ad',
    'examples/test-app/replays/gesture-lab.ad',
  ];
  for (const replayPath of replayPaths) assertReplayFitsViewports(replayPath, compactViewports);
});

test('drag replay fixtures use parseable source and destination selectors', () => {
  const replayPaths = [
    'examples/test-app/replays/drag.ad',
    'examples/test-app/replays/drag-android.ad',
  ];

  for (const replayPath of replayPaths) {
    const drag = parseReplayScriptDetailed(fs.readFileSync(replayPath, 'utf8')).actions.find(
      (action) => action.command === 'gesture' && action.positionals?.[0] === 'drag',
    );
    assert.ok(drag, `${replayPath} must contain a drag gesture`);

    const source = drag.positionals?.[1];
    const destination = drag.positionals?.[2];
    assert.ok(
      source && isValidSelectorExpression(source),
      `${replayPath} source must be a selector`,
    );
    assert.ok(
      destination && isValidSelectorExpression(destination),
      `${replayPath} destination must be a selector`,
    );
  }
});

test('fixture navigation uses edge-aware traversal without losing direct swipe evidence', () => {
  const actions = parseReplayScriptDetailed(
    fs.readFileSync('test/integration/replays/ios/fixture/01-navigation-scroll.ad', 'utf8'),
  ).actions;
  assert.equal(
    actions.filter((action) => action.command === 'swipe').length,
    2,
    'one directional swipe per edge proves replay swipe execution',
  );
  assert.deepEqual(
    actions
      .filter((action) => action.command === 'scroll')
      .map((action) => action.positionals?.[0]),
    ['bottom', 'top'],
    'edge traversal must terminate from observed scroll state rather than viewport-tuned swipes',
  );
});

test('fixture navigation establishes the home route before selecting Catalog', () => {
  const actions = parseReplayScriptDetailed(
    fs.readFileSync('test/integration/replays/ios/fixture/01-navigation-scroll.ad', 'utf8'),
  ).actions;
  const open = actions[0];
  assert.equal(open?.command, 'open');
  assert.equal(open?.flags.relaunch, true);
  assert.equal(open?.runtime?.launchUrl, 'agent-device-test-app:///');
  assert.equal(actions[2]?.command, 'click');
  assert.equal(actions[2]?.positionals?.[0], 'label="Catalog"');
});

test('event timeline coverage follows cursors beyond the first page', async () => {
  const requestedCursors: Array<string | undefined> = [];
  const timeline = await collectPagedEventTimeline(async (cursor) => {
    requestedCursors.push(cursor);
    if (cursor === undefined) {
      return {
        events: [{ command: PUBLIC_COMMANDS.open }, { command: PUBLIC_COMMANDS.snapshot }],
        nextCursor: '100',
      };
    }
    return { events: [{ command: PUBLIC_COMMANDS.press }] };
  });

  assert.deepEqual(requestedCursors, [undefined, '100']);
  assert.deepEqual(timeline.commands, [
    PUBLIC_COMMANDS.open,
    PUBLIC_COMMANDS.snapshot,
    PUBLIC_COMMANDS.press,
  ]);
  assert.deepEqual(timeline.pages, [
    { cursor: '0', eventCount: 2, nextCursor: '100' },
    { cursor: '100', eventCount: 1 },
  ]);
});

test('event timeline coverage rejects malformed and non-advancing pages', async () => {
  await assert.rejects(
    collectPagedEventTimeline(async () => ({})),
    /events page must contain an events array/,
  );
  await assert.rejects(
    collectPagedEventTimeline(async () => ({ events: [{ command: 42 }] })),
    /must name a command/,
  );
  await assert.rejects(
    collectPagedEventTimeline(async () => ({ events: [], nextCursor: { offset: 100 } })),
    /nextCursor must be a canonical non-negative integer string/,
  );
  await assert.rejects(
    collectPagedEventTimeline(async () => ({ events: [], nextCursor: '1e2' })),
    /nextCursor must be a canonical non-negative integer string/,
  );
  await assert.rejects(
    collectPagedEventTimeline(async () => ({ events: [], nextCursor: '100' })),
    /did not advance beyond cursor 100/,
  );
  let page = 0;
  await assert.rejects(
    collectPagedEventTimeline(async () => ({
      events: [],
      nextCursor: page++ === 0 ? '100' : '50',
    })),
    /did not advance beyond cursor 100/,
  );
});

test('event timeline coverage fails fast on runaway pagination', async () => {
  let nextCursor = 0;
  await assert.rejects(
    collectPagedEventTimeline(async () => ({
      events: [],
      nextCursor: String(++nextCursor),
    })),
    /events pagination exceeded 100 pages/,
  );
});
