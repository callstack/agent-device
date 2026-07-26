import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PUBLIC_COMMANDS } from '../../src/command-catalog.ts';
import {
  gesturePayloadFromPositionals,
  normalizePublicGesture,
  normalizePublicSwipeMotion,
  swipePayloadFromPositionals,
} from '../../src/contracts/gesture-normalization.ts';
import { buildGesturePlan } from '../../src/contracts/gesture-plan.ts';
import { isCommandSupportedOnDevice } from '../../src/core/capabilities.ts';
import { parseReplayScriptDetailed } from '../../src/replay/script.ts';
import { IOS_SIMULATOR_BEHAVIOR_COVERAGE } from './ios-simulator-e2e/behavior-coverage.ts';
import { IOS_SIMULATOR_E2E_COVERAGE } from './ios-simulator-e2e/coverage-manifest.ts';
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
    if (entry.level === 'known-gap') {
      assert.match(entry.trackingIssue, /^#\d+$/, `${command} gap needs a tracking issue`);
    }
  }
});

test('live command claims are owned by executable scenarios', () => {
  const scenariosById = new Map(
    IOS_SIMULATOR_LIVE_SCENARIOS.map((scenario) => [scenario.id, scenario]),
  );

  for (const [command, entry] of Object.entries(IOS_SIMULATOR_E2E_COVERAGE)) {
    if (entry.level !== 'live' && entry.level !== 'known-gap') continue;
    const scenario = scenariosById.get(entry.owner);
    assert.ok(scenario, `${command} references missing scenario ${entry.owner}`);
    assert.ok(scenario.commands.includes(command), `${entry.owner} does not execute ${command}`);
  }

  const scenarioIds = IOS_SIMULATOR_LIVE_SCENARIOS.map((scenario) => scenario.id);
  assert.equal(new Set(scenarioIds).size, scenarioIds.length, 'scenario ids must be unique');
  const claimedCommands = IOS_SIMULATOR_LIVE_SCENARIOS.flatMap((scenario) => scenario.commands);
  assert.equal(
    new Set(claimedCommands).size,
    claimedCommands.length,
    'runtime command claims must have one primary scenario',
  );
  for (const scenario of IOS_SIMULATOR_LIVE_SCENARIOS) {
    assert.equal(
      new Set(scenario.commands).size,
      scenario.commands.length,
      `${scenario.id} has duplicate command claims`,
    );
  }
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
    if (entry.level === 'live' || entry.level === 'known-gap') continue;
    const ownerPath = path.resolve(entry.owner.path);
    assert.ok(fs.existsSync(ownerPath), `${command} owner does not exist: ${entry.owner.path}`);
    assert.ok(
      fs.readFileSync(ownerPath, 'utf8').includes(entry.owner.test),
      `${command} owner does not contain named evidence: ${entry.owner.test}`,
    );
  }
});

test('capability classifications match executable simulator behavior', () => {
  for (const [command, entry] of Object.entries(IOS_SIMULATOR_E2E_COVERAGE)) {
    const supported = isCommandSupportedOnDevice(command, IOS_SIMULATOR);
    if (entry.level === 'capability-denial') {
      assert.equal(supported, false, `${command} denial must match capability admission`);
    } else {
      assert.equal(supported, true, `${command} evidence requires simulator capability admission`);
    }
  }

  assert.equal(isCommandSupportedOnDevice(PUBLIC_COMMANDS.tvRemote, IOS_SIMULATOR), false);
  assert.equal(IOS_SIMULATOR_E2E_COVERAGE[PUBLIC_COMMANDS.tvRemote].level, 'capability-denial');

  assert.equal(isCommandSupportedOnDevice(PUBLIC_COMMANDS.viewport, IOS_SIMULATOR), true);
  assert.equal(IOS_SIMULATOR_E2E_COVERAGE[PUBLIC_COMMANDS.viewport].level, 'known-gap');
  const viewportScenario = IOS_SIMULATOR_LIVE_SCENARIOS.find(
    (scenario) => scenario.id === IOS_SIMULATOR_E2E_COVERAGE[PUBLIC_COMMANDS.viewport].owner,
  );
  assert.ok(viewportScenario?.commands.includes(PUBLIC_COMMANDS.viewport));
});

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

  for (const replayPath of replayPaths) {
    const actions = parseReplayScriptDetailed(fs.readFileSync(replayPath, 'utf8')).actions;
    for (const action of actions) {
      const positionals = action.positionals ?? [];
      for (const viewport of compactViewports) {
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
    }
  }
});
