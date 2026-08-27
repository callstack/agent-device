import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { TVOS_SIMULATOR } from '../../src/__tests__/test-utils/device-fixtures.ts';
import { PUBLIC_COMMANDS } from '../../src/command-catalog.ts';
import { createPlatformRuntimeGateway } from '../../src/platform-runtime.ts';
import { gestureRefusalMessage } from '@agent-device/contracts/gesture-admission';
import {
  TVOS_COVERAGE_GAP_ISSUE,
  TVOS_PLATFORM_COVERAGE,
  TVOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY,
  TVOS_REMOTE_EVIDENCE,
  TVOS_REMOTE_SCENARIO_COMMANDS,
  TVOS_REMOTE_TEST_NAME,
} from './tvos-e2e/coverage-manifest.ts';

const publicCommands = Object.values(PUBLIC_COMMANDS).sort();

test('tvOS coverage exhaustively classifies the public catalog', () => {
  assert.deepEqual(Object.keys(TVOS_PLATFORM_COVERAGE).sort(), publicCommands);

  for (const command of publicCommands) {
    const entry = TVOS_PLATFORM_COVERAGE[command];
    assert.ok(entry.assertion.trim().length > 0, `${command} needs an observable assertion`);
    if (entry.level === 'live' || entry.level === 'command-contract') {
      assert.ok(entry.owner.path.trim().length > 0, `${command} needs an evidence path`);
      assert.ok(entry.owner.test.trim().length > 0, `${command} needs named evidence`);
    }
    if (entry.level === 'known-gap') {
      assert.equal(
        entry.trackingIssue,
        TVOS_COVERAGE_GAP_ISSUE,
        `${command} has the wrong gap issue`,
      );
    }
  }
});

test('tvOS coverage report has the expected classification counts', () => {
  assert.deepEqual(TVOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY, {
    contract: 16,
    gap: 38,
    live: 0,
    total: 54,
  });
});

test('tvOS contract claims name existing executable evidence', () => {
  for (const [command, entry] of Object.entries(TVOS_PLATFORM_COVERAGE)) {
    if (entry.level !== 'command-contract') continue;
    const evidencePath = path.resolve(entry.owner.path);
    assert.equal(fs.existsSync(evidencePath), true, `${command} owner does not exist`);
    assert.equal(
      fs.readFileSync(evidencePath, 'utf8').includes(entry.owner.test),
      true,
      `${command} owner does not contain named evidence`,
    );
  }
});

test('tvOS provider contract claims only commands executed by the existing scenario', () => {
  const scenarioSource = fs.readFileSync(path.resolve(TVOS_REMOTE_EVIDENCE.path), 'utf8');
  assert.equal(scenarioSource.includes(TVOS_REMOTE_TEST_NAME), true);

  for (const command of TVOS_REMOTE_SCENARIO_COMMANDS) {
    assert.equal(
      scenarioSource.includes(`callCommand('${command}'`),
      true,
      `${command} is not invoked by ${TVOS_REMOTE_EVIDENCE.path}`,
    );
    assert.equal(TVOS_PLATFORM_COVERAGE[command].level, 'command-contract');
  }
});

test('tvOS host-dependent audio admission remains explicit', () => {
  const audio = TVOS_PLATFORM_COVERAGE[PUBLIC_COMMANDS.audio];
  assert.equal(audio.level, 'command-contract');
  assert.equal('admission' in audio ? audio.admission : undefined, 'host-dependent');
});

test('tvOS gesture contract preserves the typed multi-touch denial', async () => {
  assert.equal(TVOS_PLATFORM_COVERAGE[PUBLIC_COMMANDS.gesture].level, 'command-contract');
  // R42: the denial is now the Apple owner's own fact for the tvOS leaf, and the refusal a
  // gesture reports is that fact's hint under the shared wording.
  const facts = await createPlatformRuntimeGateway({
    resolveSessionArtifacts: () => ({
      outputPath: '/sessions/tvos/app.log',
      pidPath: '/sessions/tvos/app-log.pid',
    }),
    sessionsDir: '/sessions',
  }).inspectFacts(TVOS_SIMULATOR);
  const multiTouch = facts.operations.performMultiTouchGesturePlan;
  assert.equal(multiTouch.available, false);
  assert.match(
    String(multiTouch.available === false ? multiTouch.hint : ''),
    /tvOS has no touch input/,
  );
  assert.equal(
    gestureRefusalMessage(TVOS_SIMULATOR, 'multi-touch', 'pan'),
    'gesture pan is not supported on tvOS',
  );
});

test('tvOS known gaps use one grouped tracking issue', () => {
  const gapIssues = new Set(
    Object.values(TVOS_PLATFORM_COVERAGE)
      .filter((entry) => entry.level === 'known-gap')
      .map((entry) => entry.trackingIssue),
  );
  assert.deepEqual([...gapIssues], [TVOS_COVERAGE_GAP_ISSUE]);
});
