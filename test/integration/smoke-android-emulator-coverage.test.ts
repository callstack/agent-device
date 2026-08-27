import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PUBLIC_COMMANDS } from '../../src/command-catalog.ts';
import { ANDROID_EMULATOR_BEHAVIOR_COVERAGE } from './android-emulator-e2e/behavior-coverage.ts';
import { ANDROID_PERMISSION_PROMPT_COMMAND } from './android-emulator-e2e/live-lifecycle-scenario.ts';
import {
  ANDROID_EMULATOR_COVERAGE_CLASSIFICATION_SUMMARY,
  ANDROID_EMULATOR_E2E_COVERAGE,
  liveCommandsForScenario,
} from './android-emulator-e2e/coverage-manifest.ts';
import { assertCoverageComplete } from './android-emulator-e2e/live-coverage-report.ts';
import { scenarioIdsFromEnv } from './android-emulator-e2e/live-runner.ts';
import {
  ANDROID_EMULATOR_FIXTURE_BOOTSTRAP,
  ANDROID_EMULATOR_LIVE_SCENARIOS,
  selectAndroidEmulatorScenarios,
} from './android-emulator-e2e/scenarios.ts';

test('Android emulator coverage exhaustively classifies the public catalog', () => {
  const publicCommands = Object.values(PUBLIC_COMMANDS).sort();
  assert.deepEqual(Object.keys(ANDROID_EMULATOR_E2E_COVERAGE).sort(), publicCommands);
  for (const command of publicCommands) {
    const entry = ANDROID_EMULATOR_E2E_COVERAGE[command];
    assert.ok(entry.assertion.trim().length > 0, `${command} needs an observable assertion`);
    if (entry.level === 'live') {
      assert.ok(entry.scenario.trim().length > 0, `${command} needs a scenario owner`);
    } else if (entry.level === 'command-contract') {
      assert.ok(entry.evidence.owner.trim().length > 0, `${command} needs a contract owner`);
      assert.ok(
        entry.evidence.commands.includes(command),
        `${entry.evidence.owner} must declare ${command}`,
      );
    }
  }
});

test('Android coverage report summary accounts for every manifest classification', () => {
  const summary = ANDROID_EMULATOR_COVERAGE_CLASSIFICATION_SUMMARY;
  assert.deepEqual(summary, {
    contract: 13,
    gap: 0,
    live: 41,
    total: 54,
  });
  assert.equal(summary.live + summary.contract + summary.gap, summary.total);
});

test('Android live command ownership is structural and exhaustive', () => {
  assert.deepEqual(
    [...ANDROID_EMULATOR_FIXTURE_BOOTSTRAP.commands].sort(),
    liveCommandsForScenario(ANDROID_EMULATOR_FIXTURE_BOOTSTRAP.id).sort(),
    'fixture bootstrap command declaration must match the coverage manifest',
  );
  for (const scenario of ANDROID_EMULATOR_LIVE_SCENARIOS) {
    assert.deepEqual(
      [...scenario.commands].sort(),
      liveCommandsForScenario(scenario.id).sort(),
      `${scenario.id} command declaration must match the coverage manifest`,
    );
  }
  const claimed = [
    ...ANDROID_EMULATOR_FIXTURE_BOOTSTRAP.commands,
    ...ANDROID_EMULATOR_LIVE_SCENARIOS.flatMap((scenario) => scenario.commands),
  ];
  const liveCommands = Object.entries(ANDROID_EMULATOR_E2E_COVERAGE)
    .filter(([, entry]) => entry.level === 'live')
    .map(([command]) => command);
  assert.deepEqual([...claimed].sort(), liveCommands.sort());
  assert.equal(new Set(claimed).size, claimed.length, 'live commands need one primary owner');
});

test('Android app scenarios declare deterministic starting surfaces and IME modes', () => {
  assert.deepEqual(
    {
      id: ANDROID_EMULATOR_FIXTURE_BOOTSTRAP.id,
      start: ANDROID_EMULATOR_FIXTURE_BOOTSTRAP.start,
    },
    { id: 'smoke:fixture-bootstrap', start: undefined },
  );
  assert.deepEqual(
    ANDROID_EMULATOR_LIVE_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      start: 'start' in scenario ? scenario.start : undefined,
    })),
    [
      { id: 'smoke:inventory', start: undefined },
      {
        id: 'smoke:automation-system',
        start: {
          ime: 'system',
          landmark: 'Automation lab',
          url: 'agent-device-test-app:///automation?event=cold.start&payload=%7B%22source%22%3A%22android-deep-link%22%7D',
        },
      },
      {
        id: 'smoke:maestro-clickable-first',
        start: {
          ime: 'system',
          landmark: 'Automation lab',
          url: 'agent-device-test-app:///automation',
        },
      },
      {
        id: 'smoke:form-input',
        start: {
          ime: 'test',
          landmark: 'Checkout form',
          url: 'agent-device-test-app:///form',
        },
      },
      {
        id: 'smoke:keyboard-ime',
        start: {
          ime: 'system',
          landmark: 'Checkout form',
          url: 'agent-device-test-app:///form',
        },
      },
      {
        id: 'smoke:capture-close',
        start: {
          ime: 'system',
          landmark: 'Agent Device Tester',
          url: 'agent-device-test-app:///',
        },
      },
      { id: 'full:lifecycle-system', start: undefined },
      { id: 'full:observability-artifacts', start: undefined },
      { id: 'full:fixture-replays', start: undefined },
    ],
  );
});

test('Android permission recovery waits for the asynchronous native prompt', () => {
  assert.deepEqual(ANDROID_PERMISSION_PROMPT_COMMAND, ['alert', 'wait', '10000']);
});

test('Android emulator scenarios can be selected as an ordered subset', () => {
  assert.deepEqual(
    selectAndroidEmulatorScenarios(['smoke:keyboard-ime', 'smoke:automation-system']).map(
      ({ id }) => id,
    ),
    ['smoke:keyboard-ime', 'smoke:automation-system'],
  );
  assert.deepEqual(
    selectAndroidEmulatorScenarios().map(({ id }) => id),
    ANDROID_EMULATOR_LIVE_SCENARIOS.map(({ id }) => id),
  );
  assert.throws(
    () => selectAndroidEmulatorScenarios(['smoke:keyboard-ime', 'smoke:keyboard-ime']),
    /duplicate Android emulator E2E scenario: smoke:keyboard-ime/,
  );
  assert.throws(
    () => selectAndroidEmulatorScenarios(['smoke:not-real']),
    /unknown Android emulator E2E scenario: smoke:not-real/,
  );
  assert.throws(
    () => selectAndroidEmulatorScenarios([]),
    /select at least one Android emulator E2E scenario/,
  );
  assert.deepEqual(scenarioIdsFromEnv(' smoke:capture-close,smoke:inventory '), [
    'smoke:capture-close',
    'smoke:inventory',
  ]);
  assert.throws(() => scenarioIdsFromEnv(''), /contains no Android emulator E2E scenario ids/);
  assert.equal(scenarioIdsFromEnv(undefined), undefined);
});

test('Android emulator coverage completeness is scoped to the executed subset', () => {
  const captureScenario = selectAndroidEmulatorScenarios(['smoke:capture-close'])[0];
  assert.ok(captureScenario);
  const selected = [ANDROID_EMULATOR_FIXTURE_BOOTSTRAP, captureScenario];
  const context = {
    appId: 'com.example.fixture',
    appPath: '/fixture.apk',
    artifactDir: '/tmp/not-written',
    behaviorEvidence: {},
    commandEvidence: {
      [PUBLIC_COMMANDS.close]: ['session released'],
      [PUBLIC_COMMANDS.install]: ['fixture installed'],
      [PUBLIC_COMMANDS.screenshot]: ['PNG captured'],
    },
    completedScenarios: selected.map(({ id }) => id),
    currentScenario: captureScenario.id,
    env: {},
    serial: 'emulator-5554',
    session: 'scoped-coverage',
    sessionOpen: false,
    startedAtMs: Date.now(),
    stepHistory: [],
    tier: 'smoke' as const,
    timings: [],
  };

  assert.doesNotThrow(() => assertCoverageComplete(context, selected));
  const incomplete = {
    ...context,
    commandEvidence: {
      [PUBLIC_COMMANDS.close]: ['session released'],
      [PUBLIC_COMMANDS.install]: ['fixture installed'],
    },
  };
  assert.throws(
    () => assertCoverageComplete(incomplete, selected),
    /Android emulator E2E coverage is incomplete/,
  );
});

test('Android command-contract declarations are unique and exhaustive', () => {
  const contractEntries = Object.entries(ANDROID_EMULATOR_E2E_COVERAGE).filter(
    (
      entry,
    ): entry is [
      string,
      Extract<
        (typeof ANDROID_EMULATOR_E2E_COVERAGE)[keyof typeof ANDROID_EMULATOR_E2E_COVERAGE],
        { level: 'command-contract' }
      >,
    ] => entry[1].level === 'command-contract',
  );
  const declarations = new Map<string, (typeof contractEntries)[number][1]['evidence']>();
  for (const [command, entry] of contractEntries) {
    const { evidence } = entry;
    assert.ok(evidence.testName.trim().length > 0, `${evidence.owner} needs an executable test`);
    if (evidence.owner.endsWith('.ts')) {
      const evidencePath = path.resolve(evidence.owner);
      assert.equal(fs.existsSync(evidencePath), true, `${command} owner does not exist`);
      assert.equal(
        fs.readFileSync(evidencePath, 'utf8').includes(evidence.testName),
        true,
        `${command} evidence is not named in ${evidence.owner}`,
      );
    }
    const declarationKey = `${evidence.owner}:${evidence.testName}`;
    const existing = declarations.get(declarationKey);
    if (existing) {
      assert.deepEqual(existing, evidence, `${command} contract evidence is inconsistent`);
    } else {
      declarations.set(declarationKey, evidence);
    }
  }
  assert.ok(declarations.size > 0, 'Android command contracts need executable evidence');
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

test('Android fact-owned denials carry runtime contract evidence', () => {
  assert.equal(
    ANDROID_EMULATOR_E2E_COVERAGE[PUBLIC_COMMANDS.tvRemote].level,
    'command-contract',
    'tv-remote support is controlled by its platform runtime facts, not the capability catalog',
  );
  assert.equal(
    ANDROID_EMULATOR_E2E_COVERAGE[PUBLIC_COMMANDS.viewport].level,
    'command-contract',
    'viewport support is controlled by its platform runtime facts, not the capability catalog',
  );
  assert.equal(
    ANDROID_EMULATOR_E2E_COVERAGE[PUBLIC_COMMANDS.prepare].level,
    'command-contract',
    'prepare support is controlled by its platform runtime facts, not the capability catalog',
  );
  assert.equal(ANDROID_EMULATOR_E2E_COVERAGE[PUBLIC_COMMANDS.hover].level, 'command-contract');
});
