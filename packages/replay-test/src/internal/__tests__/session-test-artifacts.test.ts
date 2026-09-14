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

// Package tests compile within their own rootDir and cannot import the root test utility.
function mkdtempForTestSync(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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

test.each([
  {
    names: ['device.log', 'device.log', 'device-2.log'],
    copied: ['device.log', 'device-2.log', 'device-2-2.log'],
  },
  {
    names: ['device.log', 'device-2.log', 'device.log'],
    copied: ['device.log', 'device-2.log', 'device-3.log'],
  },
  {
    names: ['log', 'log', 'log-2'],
    copied: ['log', 'log-2', 'log-2-2'],
  },
])('materialization preserves colliding artifacts: $names', ({ names, copied }) => {
  const root = mkdtempForTestSync('agent-device-artifact-collisions-');
  const replayPath = path.join(root, 'flow.ad');
  const attemptDir = path.join(root, 'attempt-1');
  fs.writeFileSync(replayPath, 'context platform=android\nopen demo.app\n');
  const artifactPaths = names.map((name, index) => {
    const dir = path.join(root, String(index));
    fs.mkdirSync(dir);
    const artifactPath = path.join(dir, name);
    fs.writeFileSync(artifactPath, `artifact ${index}`);
    return artifactPath;
  });

  prepareReplayTestAttemptArtifacts(replayPath, attemptDir);
  materializeReplayTestAttemptArtifacts({
    outcome: passedOutcome({ artifactPaths }),
    filePath: replayPath,
    sessionName: 'artifact-collisions',
    attempts: 1,
    maxAttempts: 1,
    attemptArtifactsDir: attemptDir,
  });

  for (const [index, name] of copied.entries()) {
    assert.equal(fs.readFileSync(path.join(attemptDir, name), 'utf8'), `artifact ${index}`);
  }
  const manifest = fs.readFileSync(path.join(attemptDir, 'result.txt'), 'utf8');
  assert.ok(manifest.includes(`copiedArtifacts: ${copied.join(', ')}\n`));
});

test('materialization preserves replay sources and diagnostics named after attempt manifests', () => {
  const root = mkdtempForTestSync('agent-device-artifact-reserved-');
  const replayPath = path.join(root, 'flow.yml');
  const attemptDir = path.join(root, 'attempt-1');
  const source = 'appId: demo.app\n---\n- assertVisible: Welcome\n';
  fs.writeFileSync(replayPath, source);
  const names = ['replay.ad', 'flow.yml', 'result.txt', 'failure.txt'];
  const artifactPaths = names.map((name) => {
    const dir = path.join(root, 'diagnostics', name);
    fs.mkdirSync(dir, { recursive: true });
    const artifactPath = path.join(dir, name);
    fs.writeFileSync(artifactPath, `diagnostic ${name}`);
    return artifactPath;
  });

  prepareReplayTestAttemptArtifacts(replayPath, attemptDir);
  materializeReplayTestAttemptArtifacts({
    outcome: {
      status: 'failed',
      error: { code: 'COMMAND_FAILED', message: 'original failure' },
      artifactPaths,
      infrastructure: false,
    },
    filePath: replayPath,
    sessionName: 'artifact-reserved',
    attempts: 1,
    maxAttempts: 1,
    attemptArtifactsDir: attemptDir,
  });

  assert.equal(fs.readFileSync(path.join(attemptDir, 'replay.ad'), 'utf8'), source);
  assert.equal(fs.readFileSync(path.join(attemptDir, 'flow.yml'), 'utf8'), source);
  for (const name of names) {
    const extension = path.extname(name);
    const copiedName = `${path.basename(name, extension)}-2${extension}`;
    assert.equal(fs.readFileSync(path.join(attemptDir, copiedName), 'utf8'), `diagnostic ${name}`);
  }
  const manifest = fs.readFileSync(path.join(attemptDir, 'result.txt'), 'utf8');
  assert.match(manifest, /status: failed\ncode: COMMAND_FAILED\nmessage: original failure/);
  assert.equal(fs.readFileSync(path.join(attemptDir, 'failure.txt'), 'utf8'), manifest);
  assert.match(
    manifest,
    /copiedArtifacts: replay-2\.ad, flow-2\.yml, result-2\.txt, failure-2\.txt/,
  );
});

test.each([false, true])(
  'materialization preserves artifacts already in the attempt directory (local first: %s)',
  (localFirst) => {
    const root = mkdtempForTestSync('agent-device-artifact-local-');
    const replayPath = path.join(root, 'flow.ad');
    const attemptDir = path.join(root, 'attempt-1');
    const externalTrace = path.join(root, 'replay-timing.ndjson');
    const localTrace = path.join(attemptDir, 'replay-timing.ndjson');
    fs.writeFileSync(replayPath, 'context platform=android\nopen demo.app\n');
    fs.writeFileSync(externalTrace, 'external trace');
    prepareReplayTestAttemptArtifacts(replayPath, attemptDir);
    fs.writeFileSync(localTrace, 'attempt trace');
    const artifactPaths = localFirst ? [localTrace, externalTrace] : [externalTrace, localTrace];

    materializeReplayTestAttemptArtifacts({
      outcome: passedOutcome({ artifactPaths: [...artifactPaths, path.join(root, 'missing.log')] }),
      filePath: replayPath,
      sessionName: 'artifact-local',
      attempts: 1,
      maxAttempts: 1,
      attemptArtifactsDir: attemptDir,
    });

    assert.equal(fs.readFileSync(localTrace, 'utf8'), 'attempt trace');
    assert.equal(
      fs.readFileSync(path.join(attemptDir, 'replay-timing-2.ndjson'), 'utf8'),
      'external trace',
    );
    assert.deepEqual(fs.readdirSync(attemptDir).sort(), [
      'replay-timing-2.ndjson',
      'replay-timing.ndjson',
      'replay.ad',
      'result.txt',
    ]);
    const manifest = fs.readFileSync(path.join(attemptDir, 'result.txt'), 'utf8');
    assert.equal(manifest.includes('missing.log'), false);
  },
);

test('materialization copies a log listed in both the outcome and error only once', () => {
  const root = mkdtempForTestSync('agent-device-artifact-log-');
  const replayPath = path.join(root, 'flow.ad');
  const logPath = path.join(root, 'daemon.log');
  const attemptDir = path.join(root, 'attempt-1');
  fs.writeFileSync(replayPath, 'context platform=android\nopen demo.app\n');
  fs.writeFileSync(logPath, 'diagnostic log');
  prepareReplayTestAttemptArtifacts(replayPath, attemptDir);

  materializeReplayTestAttemptArtifacts({
    outcome: {
      status: 'failed',
      error: { code: 'COMMAND_FAILED', message: 'failed', logPath },
      artifactPaths: [logPath, logPath],
      infrastructure: false,
    },
    filePath: replayPath,
    sessionName: 'artifact-log',
    attempts: 1,
    maxAttempts: 1,
    attemptArtifactsDir: attemptDir,
  });

  assert.equal(fs.readFileSync(path.join(attemptDir, 'daemon.log'), 'utf8'), 'diagnostic log');
  assert.equal(fs.existsSync(path.join(attemptDir, 'daemon-2.log')), false);
  assert.match(
    fs.readFileSync(path.join(attemptDir, 'result.txt'), 'utf8'),
    /copiedArtifacts: daemon\.log\n/,
  );
});

test.each(['result.txt', 'failure.txt', 'RESULT.TXT'])(
  'materialization preserves an in-place diagnostic named %s before writing manifests',
  (name) => {
    const root = mkdtempForTestSync('agent-device-artifact-in-place-manifest-');
    const replayPath = path.join(root, 'flow.ad');
    const attemptDir = path.join(root, 'attempt-1');
    fs.writeFileSync(replayPath, 'context platform=android\nopen demo.app\n');
    prepareReplayTestAttemptArtifacts(replayPath, attemptDir);
    const diagnosticPath = path.join(attemptDir, name);
    fs.writeFileSync(diagnosticPath, 'diagnostic contents');

    materializeReplayTestAttemptArtifacts({
      outcome: {
        status: 'failed',
        error: { code: 'COMMAND_FAILED', message: 'original failure' },
        artifactPaths: [diagnosticPath],
        infrastructure: false,
      },
      filePath: replayPath,
      sessionName: 'artifact-in-place-manifest',
      attempts: 1,
      maxAttempts: 1,
      attemptArtifactsDir: attemptDir,
    });

    const extension = path.extname(name);
    const copiedName = `${path.basename(name, extension)}-2${extension}`;
    assert.equal(fs.readFileSync(path.join(attemptDir, copiedName), 'utf8'), 'diagnostic contents');
    const manifest = fs.readFileSync(path.join(attemptDir, 'result.txt'), 'utf8');
    assert.ok(manifest.includes(`copiedArtifacts: ${copiedName}\n`));
    assert.match(manifest, /status: failed/);
    assert.equal(fs.readFileSync(path.join(attemptDir, 'failure.txt'), 'utf8'), manifest);
  },
);
