import assert from 'node:assert/strict';
import { parseReplayScriptDetailed } from '@agent-device/ad-script';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { mkdtempForTest } from '@agent-device/test-kit';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import {
  assertCoverageClassificationSummaryWiredToManifest,
  assertCoverageGapRowsAreOwned,
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

test('macOS coverage declarations cover exactly the public catalog with an assertion and owner', () => {
  assert.deepEqual(Object.keys(MACOS_PLATFORM_COVERAGE).sort(), publicCommands);
  assertCoverageGapRowsAreOwned('macOS', MACOS_PLATFORM_COVERAGE);

  for (const command of publicCommands) {
    const entry = MACOS_PLATFORM_COVERAGE[command];
    assert.ok(entry.assertion.trim().length > 0, `${command} needs an observable assertion`);
    if (entry.level === 'known-gap' || entry.level === 'accepted-gap') {
      continue;
    }
    assert.ok(entry.owner.path.trim().length > 0, `${command} needs an evidence path`);
    assert.ok(entry.owner.test.trim().length > 0, `${command} needs named evidence`);
    if (entry.level === 'live') {
      assert.ok(entry.scenario.trim().length > 0, `${command} needs a live scenario owner`);
    }
  }
});

test('macOS coverage classification summary is the rollup of the manifest declarations', () => {
  assertCoverageClassificationSummaryWiredToManifest(
    'macOS',
    MACOS_PLATFORM_COVERAGE,
    MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY,
    publicCommands,
  );
});

// The scenario sources name which commands macOS scenarios invoke, independent of what the manifest
// labels them. This is a source-text reading: a command in a skipped or commented-out step still
// matches, so it checks declaration integrity, not execution. Provider scenarios name commands whose
// live claim is attributed to the replay scenario, so this closes the platform's live bucket rather
// than each scenario's partition of it.
test('macOS live declarations equal the commands named in live scenario sources', () => {
  assertLiveCoverageMatchesEvidence(
    'macOS',
    MACOS_PLATFORM_COVERAGE,
    commandsNamedByMacOsLiveScenarios(),
  );
});

test('macOS live declarations name commands present in their scenario source files', () => {
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
        `${command} is not named in ${scenario.owner.path}`,
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

test('macOS non-live evidence declarations name an existing file containing the evidence test text', () => {
  for (const [command, entry] of Object.entries(MACOS_PLATFORM_COVERAGE)) {
    if (entry.level === 'live' || entry.level === 'known-gap' || entry.level === 'accepted-gap') {
      continue;
    }
    const evidencePath = path.resolve(entry.owner.path);
    assert.equal(fs.existsSync(evidencePath), true, `${command} owner does not exist`);
    assert.equal(
      fs.readFileSync(evidencePath, 'utf8').includes(entry.owner.test),
      true,
      `${command} owner file lacks the evidence test text: ${entry.owner.test}`,
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

function commandsNamedByMacOsLiveScenarios(): string[] {
  const catalogCommands: ReadonlySet<string> = new Set(publicCommands);
  const executed = new Set<string>();
  for (const scenario of MACOS_LIVE_SCENARIOS) {
    for (const command of commandsNamedInScenarioSource(
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

function commandsNamedInScenarioSource(
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
