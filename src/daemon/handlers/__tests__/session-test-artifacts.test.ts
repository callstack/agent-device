import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  materializeReplayTestAttemptArtifacts,
  prepareReplayTestAttemptArtifacts,
} from '../session-test-artifacts.ts';
import { toReplayTestAttemptOutcome } from '../session-test-outcome.ts';
import type { DaemonResponse } from '../../types.ts';

test('materializeReplayTestAttemptArtifacts writes replay and result manifests for passing attempts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-artifacts-pass-'));
  const replayPath = path.join(root, 'flow.ad');
  const screenshotPath = path.join(root, 'capture.png');
  const attemptDir = path.join(root, 'attempt-1');
  fs.writeFileSync(replayPath, 'context platform=ios\nopen "Demo"\n');
  fs.writeFileSync(screenshotPath, 'png');

  prepareReplayTestAttemptArtifacts(replayPath, attemptDir);
  const response: DaemonResponse = {
    ok: true,
    data: {
      replayed: 4,
      healed: 1,
      artifactPaths: [screenshotPath],
    },
  };
  materializeReplayTestAttemptArtifacts({
    outcome: toReplayTestAttemptOutcome(response),
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
  const response: DaemonResponse = {
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'TIMEOUT after 5000ms',
      hint: 'Replay test timeouts are cooperative.',
      logPath,
      details: {
        reason: 'timeout',
        artifactPaths: [screenshotPath],
      },
    },
  };
  materializeReplayTestAttemptArtifacts({
    outcome: toReplayTestAttemptOutcome(response),
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
