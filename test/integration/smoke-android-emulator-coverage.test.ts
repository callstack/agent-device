import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PUBLIC_COMMANDS } from '../../src/command-catalog.ts';
import { isCommandSupportedOnDevice } from '../../src/core/capabilities.ts';
import { ANDROID_EMULATOR_BEHAVIOR_COVERAGE } from './android-emulator-e2e/behavior-coverage.ts';
import {
  ANDROID_EMULATOR_E2E_COVERAGE,
  liveCommandsForScenario,
} from './android-emulator-e2e/coverage-manifest.ts';
import { ANDROID_EMULATOR_LIVE_SCENARIOS } from './android-emulator-e2e/scenarios.ts';

const ANDROID_EMULATOR = {
  id: 'ci-android-emulator',
  kind: 'emulator' as const,
  name: 'CI Android Emulator',
  platform: 'android' as const,
  target: 'mobile' as const,
};

test('Android emulator coverage exhaustively classifies the public catalog', () => {
  const publicCommands = Object.values(PUBLIC_COMMANDS).sort();
  assert.deepEqual(Object.keys(ANDROID_EMULATOR_E2E_COVERAGE).sort(), publicCommands);
  for (const command of publicCommands) {
    const entry = ANDROID_EMULATOR_E2E_COVERAGE[command];
    assert.ok(entry.assertion.trim().length > 0, `${command} needs an observable assertion`);
    if (typeof entry.owner === 'string') {
      assert.ok(entry.owner.trim().length > 0, `${command} needs a scenario owner`);
    } else {
      assert.ok(entry.owner.path.trim().length > 0, `${command} needs an evidence path`);
      assert.ok(entry.owner.test.trim().length > 0, `${command} needs named evidence`);
    }
    if (entry.level === 'known-gap') {
      assert.match(entry.trackingIssue, /^#\d+$/, `${command} gap needs a tracking issue`);
    }
  }
});

test('Android live claims execute in exactly one scenario with command-specific evidence', () => {
  const scenarios = new Map(
    ANDROID_EMULATOR_LIVE_SCENARIOS.map((scenario) => [scenario.id, scenario]),
  );
  for (const [command, entry] of Object.entries(ANDROID_EMULATOR_E2E_COVERAGE)) {
    if (entry.level !== 'live' && entry.level !== 'known-gap') continue;
    assert.ok(scenarios.has(entry.owner), `${command} references missing scenario ${entry.owner}`);
    assert.ok(
      liveCommandsForScenario(entry.owner).includes(
        command as (typeof PUBLIC_COMMANDS)[keyof typeof PUBLIC_COMMANDS],
      ),
      `${entry.owner} does not execute ${command}`,
    );
    const source = [
      fs.readFileSync(scenarios.get(entry.owner)?.source ?? '', 'utf8'),
      fs.readFileSync('test/integration/android-emulator-e2e/live-assertions.ts', 'utf8'),
    ].join('\n');
    const commandKey = Object.entries(PUBLIC_COMMANDS).find(([, value]) => value === command)?.[0];
    assert.ok(commandKey, `public command key missing for ${command}`);
    assert.match(
      source,
      new RegExp(`verifyCommand\\(\\s*context,\\s*(?:C\\.${commandKey}|['"]${command}['"])`),
      `${entry.owner} has no runtime command-specific evidence assertion for ${command}`,
    );
  }
  const claimed = ANDROID_EMULATOR_LIVE_SCENARIOS.flatMap((scenario) =>
    liveCommandsForScenario(scenario.id),
  );
  assert.equal(
    new Set(claimed).size,
    claimed.length,
    'live commands need exactly one primary owner',
  );
});

test('Android emulator non-live owners name executable repository evidence', () => {
  for (const [command, entry] of Object.entries(ANDROID_EMULATOR_E2E_COVERAGE)) {
    if (entry.level === 'live' || entry.level === 'known-gap') continue;
    const ownerPath = path.resolve(entry.owner.path);
    assert.ok(fs.existsSync(ownerPath), `${command} owner does not exist: ${entry.owner.path}`);
    assert.ok(
      fs.readFileSync(ownerPath, 'utf8').includes(entry.owner.test),
      `${command} owner does not contain named evidence: ${entry.owner.test}`,
    );
  }
});

test('Android behavior patterns are owned by live fixture journeys', () => {
  const scenarioIds = new Set(ANDROID_EMULATOR_LIVE_SCENARIOS.map((scenario) => scenario.id));
  for (const [behavior, entry] of Object.entries(ANDROID_EMULATOR_BEHAVIOR_COVERAGE)) {
    assert.ok(entry.assertion.trim().length > 0, `${behavior} needs observable assertion`);
    assert.equal(entry.level, 'live');
    assert.ok(
      scenarioIds.has(entry.owner),
      `${behavior} references missing scenario ${entry.owner}`,
    );
    const source = fs.readFileSync(
      ANDROID_EMULATOR_LIVE_SCENARIOS.find((scenario) => scenario.id === entry.owner)?.source ?? '',
      'utf8',
    );
    assert.match(
      source,
      new RegExp(`verifyBehavior\\(\\s*context,\\s*['"]${behavior}['"]`),
      `${entry.owner} has no runtime behavior assertion for ${behavior}`,
    );
  }
});

test('Android emulator capability denial matches the public catalog', () => {
  for (const [command, entry] of Object.entries(ANDROID_EMULATOR_E2E_COVERAGE)) {
    const supported = isCommandSupportedOnDevice(command, ANDROID_EMULATOR);
    if (command === PUBLIC_COMMANDS.audio) {
      assert.equal(
        supported,
        process.platform === 'darwin',
        'Android emulator audio admission follows host audio-probe availability',
      );
      continue;
    }
    assert.equal(
      supported,
      entry.level !== 'capability-denial',
      `${command} ownership must match Android emulator capability admission`,
    );
  }
  for (const command of [
    PUBLIC_COMMANDS.prepare,
    PUBLIC_COMMANDS.tvRemote,
    PUBLIC_COMMANDS.viewport,
  ]) {
    assert.equal(isCommandSupportedOnDevice(command, ANDROID_EMULATOR), false, command);
    assert.equal(ANDROID_EMULATOR_E2E_COVERAGE[command].level, 'capability-denial', command);
  }
});
