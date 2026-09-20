import assert from 'node:assert/strict';
import { parseReplayScriptDetailed } from '@agent-device/ad-script';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { mkdtempForTest } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import {
  assertCoverageClassificationSummaryWiredToManifest,
  assertLiveCoverageMatchesEvidence,
} from './support/coverage-classification.ts';
import type { MacOsLiveScenario } from './macos-e2e/live-scenarios.ts';
import {
  MACOS_COVERAGE_GAP_ISSUE,
  MACOS_LIVE_SCENARIOS,
  MACOS_PLATFORM_COVERAGE,
  MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY,
  liveCommandsForScenario,
} from './macos-e2e/coverage.ts';
import { writeCoverageReport } from './macos-e2e/coverage-report.ts';

const publicCommands = Object.values(PUBLIC_COMMANDS).sort();

test('macOS coverage exhaustively classifies the public catalog', () => {
  assert.deepEqual(Object.keys(MACOS_PLATFORM_COVERAGE).sort(), publicCommands);

  for (const command of publicCommands) {
    const entry = MACOS_PLATFORM_COVERAGE[command];
    assert.ok(entry.assertion.trim().length > 0, `${command} needs an observable assertion`);
    if (entry.level === 'known-gap') {
      assert.equal(
        entry.trackingIssue,
        MACOS_COVERAGE_GAP_ISSUE,
        `${command} has the wrong gap issue`,
      );
      continue;
    }
    assert.ok(entry.owner.path.trim().length > 0, `${command} needs an evidence path`);
    assert.ok(entry.owner.test.trim().length > 0, `${command} needs named evidence`);
    if (entry.level === 'live') {
      assert.ok(entry.scenario.trim().length > 0, `${command} needs a live scenario owner`);
    }
  }
});

test('macOS coverage report counts every manifest classification', () => {
  assertCoverageClassificationSummaryWiredToManifest(
    'macOS',
    MACOS_PLATFORM_COVERAGE,
    MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY,
    publicCommands,
  );
});

// The scenario sources say which commands macOS actually runs, independent of what the manifest
// labels them. Provider scenarios run commands whose live claim is attributed to the replay
// scenario, so this closes the platform's live bucket rather than each scenario's partition of it.
test('macOS live claims are exactly the commands its live scenarios execute', () => {
  assertLiveCoverageMatchesEvidence(
    'macOS',
    MACOS_PLATFORM_COVERAGE,
    commandsExecutedByMacOsLiveScenarios(),
  );
});

test('macOS live claims reference commands in existing executable scenarios', () => {
  const scenariosById = new Map(MACOS_LIVE_SCENARIOS.map((scenario) => [scenario.id, scenario]));
  const claimedCommands: string[] = [];

  for (const scenario of MACOS_LIVE_SCENARIOS) {
    const source = readEvidence(scenario.owner);
    for (const command of liveCommandsForScenario(scenario.id)) {
      const entry = MACOS_PLATFORM_COVERAGE[command];
      assert.equal(entry.level, 'live');
      assert.deepEqual(entry.owner, scenario.owner, `${command} owner drifted from its scenario`);
      assert.equal(
        sourceContainsCommand(source, scenario.syntax, command),
        true,
        `${command} is not executed by ${scenario.owner.path}`,
      );
      claimedCommands.push(command);
    }
  }

  assert.equal(new Set(scenariosById.keys()).size, MACOS_LIVE_SCENARIOS.length);
  assert.equal(new Set(claimedCommands).size, claimedCommands.length);
  assert.equal(
    claimedCommands.length,
    Object.values(MACOS_PLATFORM_COVERAGE).filter((entry) => entry.level === 'live').length,
  );
});

test('macOS non-live evidence owners name existing executable repository evidence', () => {
  for (const [command, entry] of Object.entries(MACOS_PLATFORM_COVERAGE)) {
    if (entry.level === 'live' || entry.level === 'known-gap') continue;
    const evidencePath = path.resolve(entry.owner.path);
    assert.equal(fs.existsSync(evidencePath), true, `${command} owner does not exist`);
    assert.equal(
      fs.readFileSync(evidencePath, 'utf8').includes(entry.owner.test),
      true,
      `${command} owner does not contain named evidence: ${entry.owner.test}`,
    );
  }
});

test('macOS known gaps use one grouped tracking issue', () => {
  const gapIssues = new Set(
    Object.values(MACOS_PLATFORM_COVERAGE)
      .filter((entry) => entry.level === 'known-gap')
      .map((entry) => entry.trackingIssue),
  );
  assert.deepEqual([...gapIssues], [MACOS_COVERAGE_GAP_ISSUE]);
});

test('macOS coverage report persists the manifest rollup and live command list', async () => {
  const artifactDir = await mkdtempForTest('agent-device-macos-coverage-');
  const report = JSON.parse(fs.readFileSync(writeCoverageReport(artifactDir), 'utf8')) as {
    classificationSummary: typeof MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY;
    liveCommands: string[];
    liveScenarios: string[];
  };

  assert.deepEqual(report.classificationSummary, MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY);
  assert.deepEqual(
    report.liveCommands.sort(),
    Object.entries(MACOS_PLATFORM_COVERAGE)
      .filter(([, entry]) => entry.level === 'live')
      .map(([command]) => command)
      .sort(),
  );
  assert.deepEqual(
    report.liveScenarios,
    MACOS_LIVE_SCENARIOS.map(({ id }) => id),
  );
});

function commandsExecutedByMacOsLiveScenarios(): string[] {
  const catalogCommands: ReadonlySet<string> = new Set(publicCommands);
  const executed = new Set<string>();
  for (const scenario of MACOS_LIVE_SCENARIOS) {
    for (const command of commandsExecutedInScenarioSource(
      readEvidence(scenario.owner),
      scenario.syntax,
    )) {
      if (catalogCommands.has(command)) {
        executed.add(command);
      }
    }
  }
  return [...executed];
}

function commandsExecutedInScenarioSource(
  source: string,
  syntax: MacOsLiveScenario['syntax'],
): string[] {
  const group = (pattern: RegExp): string[] =>
    [...source.matchAll(pattern)]
      .map((match) => match[1])
      .filter((command): command is string => command !== undefined);
  switch (syntax) {
    case 'replay':
      return parseReplayScriptDetailed(source).actions.map((action) => action.command);
    case 'provider-command':
      return group(/command:\s*'([a-z][a-z-]*)'/g);
    case 'provider-call-command':
      return group(/callCommand\(\s*'([a-z][a-z-]*)'/g);
  }
}

function readEvidence(owner: { path: string; test: string }): string {
  const evidencePath = path.resolve(owner.path);
  assert.equal(fs.existsSync(evidencePath), true, `${owner.path} does not exist`);
  const source = fs.readFileSync(evidencePath, 'utf8');
  assert.equal(source.includes(owner.test), true, `${owner.path} lacks ${owner.test}`);
  return source;
}

function sourceContainsCommand(
  source: string,
  syntax: (typeof MACOS_LIVE_SCENARIOS)[number]['syntax'],
  command: string,
): boolean {
  switch (syntax) {
    case 'replay':
      return source.split(/\r?\n/).some((line) => {
        const trimmed = line.trim();
        return trimmed === command || trimmed.startsWith(`${command} `);
      });
    case 'provider-command':
      return source.includes(`command: '${command}'`);
    case 'provider-call-command':
      return source.includes(`callCommand('${command}'`);
  }
}
