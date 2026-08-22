import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { mkdtempForTest } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { PUBLIC_COMMANDS } from '../../src/command-catalog.ts';
import { isCommandSupportedOnDevice } from '../../src/core/capabilities.ts';
import {
  MACOS_COVERAGE_GAP_ISSUE,
  MACOS_LIVE_SCENARIOS,
  MACOS_PLATFORM_COVERAGE,
  MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY,
  liveCommandsForScenario,
} from './macos-e2e/coverage-manifest.ts';
import { writeCoverageReport } from './macos-e2e/coverage-report.ts';

const MACOS_DEVICE = {
  appleOs: 'macos' as const,
  id: 'coverage-macos-host',
  kind: 'device' as const,
  name: 'Coverage Mac',
  platform: 'apple' as const,
  target: 'desktop' as const,
};

test('macOS coverage exhaustively classifies the public catalog', () => {
  const publicCommands = Object.values(PUBLIC_COMMANDS).sort();
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
  assert.deepEqual(MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY, {
    capabilityDenial: 2,
    contract: 19,
    gap: 15,
    live: 18,
    total: 54,
  });
  assert.equal(
    MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY.live +
      MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY.contract +
      MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY.capabilityDenial +
      MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY.gap,
    MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY.total,
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

test('macOS capability-denial rows match the owning capability matrix', () => {
  const deniedByCapabilities = Object.values(PUBLIC_COMMANDS)
    .filter((command) => {
      if (command === PUBLIC_COMMANDS.audio) {
        assert.equal(
          isCommandSupportedOnDevice(command, MACOS_DEVICE),
          process.platform === 'darwin',
          'macOS audio admission follows host ScreenCaptureKit availability',
        );
        return false;
      }
      return !isCommandSupportedOnDevice(command, MACOS_DEVICE);
    })
    .sort();
  const deniedByManifest = Object.entries(MACOS_PLATFORM_COVERAGE)
    .filter(([, entry]) => entry.level === 'capability-denial')
    .map(([command]) => command)
    .sort();

  assert.deepEqual(deniedByManifest, deniedByCapabilities);
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
