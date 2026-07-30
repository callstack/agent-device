import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { PUBLIC_COMMANDS } from '../../src/command-catalog.ts';
import { isCommandSupportedOnDevice } from '../../src/core/capabilities.ts';
import { ANDROID_EMULATOR_BEHAVIOR_COVERAGE } from './android-emulator-e2e/behavior-coverage.ts';
import {
  ANDROID_EMULATOR_COVERAGE_CLASSIFICATION_SUMMARY,
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
    if (entry.level === 'live') {
      assert.ok(entry.scenario.trim().length > 0, `${command} needs a scenario owner`);
    } else {
      assert.ok(entry.evidence.path.trim().length > 0, `${command} needs an evidence path`);
    }
  }
});

test('Android coverage report summary accounts for every manifest classification', () => {
  const summary = ANDROID_EMULATOR_COVERAGE_CLASSIFICATION_SUMMARY;
  assert.deepEqual(summary, {
    capabilityDenial: 3,
    contract: 22,
    gap: 0,
    live: 28,
    total: 53,
  });
  assert.equal(
    summary.live + summary.contract + summary.gap + summary.capabilityDenial,
    summary.total,
  );
});

test('Android live command ownership is structural and exhaustive', () => {
  for (const scenario of ANDROID_EMULATOR_LIVE_SCENARIOS) {
    assert.deepEqual(
      [...scenario.commands].sort(),
      liveCommandsForScenario(scenario.id).sort(),
      `${scenario.id} command declaration must match the coverage manifest`,
    );
  }
  const claimed = ANDROID_EMULATOR_LIVE_SCENARIOS.flatMap((scenario) => scenario.commands);
  const liveCommands = Object.entries(ANDROID_EMULATOR_E2E_COVERAGE)
    .filter(([, entry]) => entry.level === 'live')
    .map(([command]) => command);
  assert.deepEqual([...claimed].sort(), liveCommands.sort());
  assert.equal(new Set(claimed).size, claimed.length, 'live commands need one primary owner');
});

test('Android app scenarios declare deterministic starting surfaces and IME modes', () => {
  assert.deepEqual(
    ANDROID_EMULATOR_LIVE_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      start: scenario.start,
    })),
    [
      { id: 'smoke:inventory-install', start: undefined },
      { id: 'smoke:automation-system', start: { ime: 'system', route: 'home' } },
      { id: 'smoke:form-input', start: { ime: 'test', route: 'form' } },
      { id: 'smoke:keyboard-ime', start: { ime: 'system', route: 'form' } },
      { id: 'smoke:capture-close', start: { ime: 'system', route: 'home' } },
    ],
  );
});

test('Android emulator non-live owners name executable repository modules', () => {
  for (const [command, entry] of Object.entries(ANDROID_EMULATOR_E2E_COVERAGE)) {
    if (entry.level === 'live') continue;
    assert.ok(
      fs.existsSync(entry.evidence.path),
      `${command} evidence does not exist: ${entry.evidence.path}`,
    );
  }
});

test('Android behavior patterns are owned by live fixture journeys', () => {
  const claimedBehaviors = ANDROID_EMULATOR_LIVE_SCENARIOS.flatMap(
    (scenario) => scenario.behaviors,
  );
  for (const [behavior, entry] of Object.entries(ANDROID_EMULATOR_BEHAVIOR_COVERAGE)) {
    assert.ok(entry.assertion.trim().length > 0, `${behavior} needs observable assertion`);
    const scenario = ANDROID_EMULATOR_LIVE_SCENARIOS.find(
      (candidate) => candidate.id === entry.owner,
    );
    assert.ok(scenario, `${behavior} references missing scenario ${entry.owner}`);
    assert.ok(
      scenario.behaviors.some((claimed) => claimed === behavior),
      `${scenario.id} must declare ${behavior}`,
    );
  }
  assert.deepEqual(
    [...claimedBehaviors].sort(),
    Object.keys(ANDROID_EMULATOR_BEHAVIOR_COVERAGE).sort(),
  );
  assert.equal(
    new Set(claimedBehaviors).size,
    claimedBehaviors.length,
    'live behaviors need one primary owner',
  );
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
