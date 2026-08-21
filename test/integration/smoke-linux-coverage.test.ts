import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseReplayScriptDetailed } from '@agent-device/ad-script';
import { LINUX_DEVICE } from '../../src/__tests__/test-utils/device-fixtures.ts';
import { PUBLIC_COMMANDS } from '../../src/command-catalog.ts';
import { isCommandSupportedOnDevice } from '../../src/core/capabilities.ts';
import {
  LINUX_COVERAGE_GAP_ISSUE,
  LINUX_PLATFORM_COVERAGE,
  LINUX_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY,
  LINUX_REPLAY_EVIDENCE,
  liveCommandsForLinuxReplay,
} from './linux-e2e/coverage-manifest.ts';

const publicCommands = Object.values(PUBLIC_COMMANDS).sort();

test('Linux coverage exhaustively classifies the public catalog', () => {
  assert.deepEqual(Object.keys(LINUX_PLATFORM_COVERAGE).sort(), publicCommands);

  for (const command of publicCommands) {
    const entry = LINUX_PLATFORM_COVERAGE[command];
    assert.ok(entry.assertion.trim().length > 0, `${command} needs an observable assertion`);
    if (entry.level === 'live' || entry.level === 'command-contract') {
      assert.ok(entry.owner.path.trim().length > 0, `${command} needs an evidence path`);
      assert.ok(entry.owner.test.trim().length > 0, `${command} needs named evidence`);
    }
    if (entry.level === 'known-gap') {
      assert.equal(
        entry.trackingIssue,
        LINUX_COVERAGE_GAP_ISSUE,
        `${command} has the wrong Linux gap issue`,
      );
    }
  }
});

test('Linux coverage report has the expected classification counts', () => {
  assert.deepEqual(LINUX_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY, {
    capabilityDenial: 11,
    // focus (#1925), click, and type are live via the replay: click resolves and lands on a
    // digit button, and the typed calculation's result is now selectable (see the manifest
    // entries for the platform defects this fixed).
    contract: 17,
    gap: 18,
    live: 8,
    total: 54,
  });

  const { capabilityDenial, contract, gap, live, total } =
    LINUX_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY;
  assert.equal(capabilityDenial + contract + gap + live, total);
});

test('Linux live claims reference commands in the existing smoke replay', () => {
  const replaySource = fs.readFileSync(path.resolve(LINUX_REPLAY_EVIDENCE.path), 'utf8');
  assert.ok(replaySource.includes(LINUX_REPLAY_EVIDENCE.test));

  const replayCommands = new Set(
    parseReplayScriptDetailed(replaySource).actions.map((action) => action.command),
  );
  const liveCommands = liveCommandsForLinuxReplay();
  assert.deepEqual(liveCommands.length, 8);
  for (const command of liveCommands) {
    assert.equal(
      replayCommands.has(command),
      true,
      `${command} is not invoked by ${LINUX_REPLAY_EVIDENCE.path}`,
    );
  }
});

test('Linux contract claims name existing executable evidence', () => {
  for (const [command, entry] of Object.entries(LINUX_PLATFORM_COVERAGE)) {
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

test('Linux capability denials match the owning descriptor matrix', () => {
  const deniedByCapabilities = publicCommands.filter(
    (command) => !isCommandSupportedOnDevice(command, LINUX_DEVICE),
  );
  const deniedByManifest = Object.entries(LINUX_PLATFORM_COVERAGE)
    .filter(([, entry]) => entry.level === 'capability-denial')
    .map(([command]) => command)
    .sort();

  assert.deepEqual(deniedByManifest, deniedByCapabilities);

  for (const [command, entry] of Object.entries(LINUX_PLATFORM_COVERAGE)) {
    if (entry.level !== 'capability-denial') continue;
    const declarationPath = path.resolve(entry.owner.path);
    const declarationSource = fs.readFileSync(declarationPath, 'utf8');
    assert.equal(
      declarationSource.includes(entry.owner.test),
      true,
      `${command} capability owner does not name its descriptor`,
    );
    assert.equal(
      declarationSource.includes(entry.owner.declaration),
      true,
      `${command} capability owner does not cite its Linux declaration`,
    );
  }
});

test('Linux known gaps use one grouped tracking issue', () => {
  const gapIssues = new Set(
    Object.values(LINUX_PLATFORM_COVERAGE)
      .filter((entry) => entry.level === 'known-gap')
      .map((entry) => entry.trackingIssue),
  );
  assert.deepEqual([...gapIssues], [LINUX_COVERAGE_GAP_ISSUE]);
});
