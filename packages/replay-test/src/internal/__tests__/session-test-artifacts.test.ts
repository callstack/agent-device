import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_TEST_ARTIFACTS_ROOT,
  materializeReplayTestAttemptArtifacts,
  prepareReplayTestAttemptArtifacts,
  resolveReplayTestArtifactsDir,
} from '../session-test-artifacts.ts';
import type { ReplayTestAttemptOutcome } from '../session-test-types.ts';

test('resolveReplayTestArtifactsDir falls back to the default root when artifactsDir is omitted', () => {
  const dir = resolveReplayTestArtifactsDir({ cwd: '/repo', suiteInvocationId: 'abc123' });
  assert.equal(dir, path.resolve('/repo', DEFAULT_TEST_ARTIFACTS_ROOT, 'abc123'));
});

test('resolveReplayTestArtifactsDir resolves an explicit relative artifactsDir against cwd', () => {
  const dir = resolveReplayTestArtifactsDir({
    artifactsDir: 'remote-device-artifacts/ad-test',
    cwd: '/repo',
    suiteInvocationId: 'abc123',
  });
  assert.equal(dir, path.resolve('/repo', 'remote-device-artifacts/ad-test', 'abc123'));
});

// Building outcomes from a DaemonResponse is the adapter's job and is pinned on that side; a
// package test states the neutral outcome directly (#1478 P3b).
const passedOutcome = (
  overrides: Partial<Extract<ReplayTestAttemptOutcome, { status: 'passed' }>> = {},
): ReplayTestAttemptOutcome => ({
  status: 'passed',
  replayed: 1,
  healed: 0,
  warnings: [],
  artifactPaths: [],
  ...overrides,
});

test('materializeReplayTestAttemptArtifacts writes replay and result manifests for passing attempts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-artifacts-pass-'));
  const replayPath = path.join(root, 'flow.ad');
  const screenshotPath = path.join(root, 'capture.png');
  const attemptDir = path.join(root, 'attempt-1');
  fs.writeFileSync(replayPath, 'context platform=ios\nopen "Demo"\n');
  fs.writeFileSync(screenshotPath, 'png');

  prepareReplayTestAttemptArtifacts(replayPath, attemptDir);
  materializeReplayTestAttemptArtifacts({
    outcome: passedOutcome({ replayed: 4, healed: 1, artifactPaths: [screenshotPath] }),
    filePath: replayPath,
    sessionName: 'default:test:suite:1',
    attempts: 1,
    maxAttempts: 1,
    attemptArtifactsDir: attemptDir,
  });

  assert.equal(fs.existsSync(path.join(attemptDir, 'replay.ad')), true);
  assert.equal(fs.existsSync(path.join(attemptDir, 'flow.ad')), false);
  assert.equal(fs.existsSync(path.join(attemptDir, 'capture.png')), true);
  assert.equal(fs.existsSync(path.join(attemptDir, 'result.txt')), true);
  assert.equal(fs.existsSync(path.join(attemptDir, 'failure.txt')), false);
  const resultText = fs.readFileSync(path.join(attemptDir, 'result.txt'), 'utf8');
  assert.match(resultText, /status: passed/);
  assert.match(resultText, /replayed: 4/);
  assert.match(resultText, /healed: 1/);
});

test('prepareReplayTestAttemptArtifacts preserves original Maestro flow filename', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-artifacts-maestro-'));
  const replayPath = path.join(root, 'auth-flow.yml');
  const attemptDir = path.join(root, 'attempt-1');
  fs.writeFileSync(replayPath, 'appId: demo.app\n---\n- assertVisible: Welcome\n');

  prepareReplayTestAttemptArtifacts(replayPath, attemptDir);

  assert.equal(fs.existsSync(path.join(attemptDir, 'replay.ad')), true);
  assert.equal(fs.existsSync(path.join(attemptDir, 'auth-flow.yml')), true);
});

test('materializeReplayTestAttemptArtifacts writes failure manifest and copies log artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-artifacts-fail-'));
  const replayPath = path.join(root, 'flow.ad');
  const screenshotPath = path.join(root, 'capture.png');
  const logPath = path.join(root, 'daemon.log');
  const attemptDir = path.join(root, 'attempt-2');
  fs.writeFileSync(replayPath, 'context platform=android\nopen "Demo"\n');
  fs.writeFileSync(screenshotPath, 'png');
  fs.writeFileSync(logPath, 'log');

  prepareReplayTestAttemptArtifacts(replayPath, attemptDir);
  materializeReplayTestAttemptArtifacts({
    outcome: {
      status: 'failed',
      error: {
        code: 'COMMAND_FAILED',
        message: 'Replay test timed out',
        hint: 'Replay test timeouts are cooperative.',
        logPath,
        details: { reason: 'timeout', artifactPaths: [screenshotPath] },
      },
      artifactPaths: [screenshotPath],
      infrastructure: false,
    },
    filePath: replayPath,
    sessionName: 'default:test:suite:2',
    attempts: 2,
    maxAttempts: 3,
    attemptArtifactsDir: attemptDir,
  });

  assert.equal(fs.existsSync(path.join(attemptDir, 'capture.png')), true);
  assert.equal(fs.existsSync(path.join(attemptDir, 'daemon.log')), true);
  assert.equal(fs.existsSync(path.join(attemptDir, 'result.txt')), true);
  assert.equal(fs.existsSync(path.join(attemptDir, 'failure.txt')), true);
  const resultText = fs.readFileSync(path.join(attemptDir, 'result.txt'), 'utf8');
  assert.match(resultText, /status: failed/);
  assert.match(resultText, /timeoutMode: cooperative/);
  assert.match(resultText, /copiedArtifacts: capture\.png, daemon\.log/);
});
