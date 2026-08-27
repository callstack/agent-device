import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseReplayScriptDetailed } from '@agent-device/ad-script';
import { PUBLIC_COMMANDS } from '../../src/command-catalog.ts';
import {
  LINUX_COVERAGE_GAP_ISSUE,
  LINUX_COMMAND_EVIDENCE,
  LINUX_PLATFORM_COVERAGE,
  LINUX_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY,
  LINUX_REPLAY_EVIDENCE,
  liveCommandsForLinuxCommandEvidence,
  liveCommandsForLinuxReplay,
} from './linux-e2e/coverage-manifest.ts';
import {
  LINUX_COMMAND_EVIDENCE_COMMANDS,
  LINUX_COMMAND_EVIDENCE_SCRIPT,
} from './linux-e2e/command-evidence.ts';

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
    // focus (#1925), click, and type remain live via the existing replay. The separate
    // command-evidence lane adds nine generic-command rows without changing that replay. Artifact
    // inventory remains a gap because local Linux screenshot paths are not daemon-downloadable.
    // Keyboard, orientation and tv-remote were already fact-owned command-contract rows rather
    // than catalog denials; R56 moves app-switcher the same way, for the same reason.
    contract: 28,
    gap: 9,
    live: 17,
    total: 54,
  });

  const { contract, gap, live, total } = LINUX_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY;
  assert.equal(contract + gap + live, total);
});

test('Linux live claims reference commands in the existing smoke replay', () => {
  const replaySource = fs.readFileSync(path.resolve(LINUX_REPLAY_EVIDENCE.path), 'utf8');
  assert.ok(replaySource.includes(LINUX_REPLAY_EVIDENCE.test));

  const replayCommands = new Set(
    parseReplayScriptDetailed(replaySource).actions.map((action) => action.command),
  );
  const liveCommands = liveCommandsForLinuxReplay();
  assert.deepEqual(liveCommands.length, 8);
  assert.deepEqual(
    [...replayCommands].sort(),
    [...liveCommands].sort(),
    'the existing replay smoke command set must remain unchanged',
  );
  for (const command of liveCommands) {
    assert.equal(
      replayCommands.has(command),
      true,
      `${command} is not invoked by ${LINUX_REPLAY_EVIDENCE.path}`,
    );
  }
});

test('Linux command-evidence claims name every executable lane command', () => {
  const runnerPath = path.resolve(LINUX_COMMAND_EVIDENCE.path);
  const runnerSource = fs.readFileSync(runnerPath, 'utf8');
  assert.ok(runnerSource.includes(LINUX_COMMAND_EVIDENCE.test));
  assert.match(
    runnerSource,
    /runSourceCliJsonSync\(args, \{ env, timeoutMs: options\?\.timeoutMs \}\)/,
    'Linux source CLI adapter must forward the shared harness timeout bound',
  );

  const scriptPath = path.resolve(LINUX_COMMAND_EVIDENCE_SCRIPT);
  const scriptSource = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(scriptSource.includes('find role "button" exists'));
  assert.deepEqual(
    new Set(liveCommandsForLinuxCommandEvidence()),
    new Set(LINUX_COMMAND_EVIDENCE_COMMANDS),
  );

  for (const command of LINUX_COMMAND_EVIDENCE_COMMANDS) {
    assert.match(
      runnerSource,
      new RegExp(`verifyCommand\\([\\s\\S]{0,220}C\\.${command}\\b`),
      `${command} must have a named command-evidence assertion`,
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

test('Linux known gaps use one grouped tracking issue', () => {
  const gapIssues = new Set(
    Object.values(LINUX_PLATFORM_COVERAGE)
      .filter((entry) => entry.level === 'known-gap')
      .map((entry) => entry.trackingIssue),
  );
  assert.deepEqual([...gapIssues], [LINUX_COVERAGE_GAP_ISSUE]);
});
