import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmdSync } from '../../src/utils/exec.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'clean-xcuitest-derived.mjs');

test('clean-xcuitest ios removes only transient root entries and reports preserved cache entries', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-clean-xcuitest-ios-'));
  try {
    const derivedRoot = path.join(homeDir, '.agent-device', 'apple-runner', 'derived');
    fs.mkdirSync(path.join(derivedRoot, 'Build'), { recursive: true });
    fs.mkdirSync(path.join(derivedRoot, 'Logs'), { recursive: true });
    fs.mkdirSync(path.join(derivedRoot, 'cache-warm-runner'), { recursive: true });
    fs.mkdirSync(path.join(derivedRoot, 'macos'), { recursive: true });

    const result = runCleanXcuitest(homeDir, 'ios');
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      `Removed iOS XCTest transient entries under ${derivedRoot}: Build, Logs; kept cache-warm-runner, macos`,
    );
    assert.equal(fs.existsSync(path.join(derivedRoot, 'Build')), false);
    assert.equal(fs.existsSync(path.join(derivedRoot, 'Logs')), false);
    assert.equal(fs.existsSync(path.join(derivedRoot, 'cache-warm-runner')), true);
    assert.equal(fs.existsSync(path.join(derivedRoot, 'macos')), true);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('clean-xcuitest ios reports a no-op when only preserved entries remain', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-clean-xcuitest-ios-noop-'));
  try {
    const derivedRoot = path.join(homeDir, '.agent-device', 'apple-runner', 'derived');
    fs.mkdirSync(path.join(derivedRoot, 'cache-warm-runner'), { recursive: true });
    fs.mkdirSync(path.join(derivedRoot, 'tvos'), { recursive: true });

    const result = runCleanXcuitest(homeDir, 'ios');
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      `Skipped iOS XCTest cleanup under ${derivedRoot}: no transient entries found; kept cache-warm-runner, tvos`,
    );
    assert.equal(fs.existsSync(path.join(derivedRoot, 'cache-warm-runner')), true);
    assert.equal(fs.existsSync(path.join(derivedRoot, 'tvos')), true);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('clean-xcuitest macos skips a missing derived directory', () => {
  const homeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-clean-xcuitest-macos-missing-'),
  );
  try {
    const derivedPath = path.join(homeDir, '.agent-device', 'apple-runner', 'derived', 'macos');

    const result = runCleanXcuitest(homeDir, 'macos');
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), `Skipped macOS XCTest cleanup: ${derivedPath} not found`);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('clean-xcuitest macos removes the entire platform directory when present', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-clean-xcuitest-macos-'));
  try {
    const derivedPath = path.join(homeDir, '.agent-device', 'apple-runner', 'derived', 'macos');
    fs.mkdirSync(derivedPath, { recursive: true });
    fs.writeFileSync(path.join(derivedPath, 'marker.txt'), 'ok', 'utf8');

    const result = runCleanXcuitest(homeDir, 'macos');
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), `Removed macOS XCTest derived data: ${derivedPath}`);
    assert.equal(fs.existsSync(derivedPath), false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('clean-xcuitest reports cleanup failures directly', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-clean-xcuitest-failure-'));
  const derivedRoot = path.join(homeDir, '.agent-device', 'apple-runner', 'derived');
  try {
    fs.mkdirSync(path.join(derivedRoot, 'Build'), { recursive: true });
    fs.chmodSync(derivedRoot, 0o500);

    const result = runCleanXcuitest(homeDir, 'ios', { allowFailure: true });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr.trim(),
      new RegExp(`^Failed to clean iOS XCTest derived data under ${escapeRegExp(derivedRoot)}: `),
    );
  } finally {
    fs.chmodSync(derivedRoot, 0o700);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

function runCleanXcuitest(homeDir: string, ...args: Array<string | { allowFailure?: boolean }>) {
  const lastArg = args.at(-1);
  const options = typeof lastArg === 'object' ? lastArg : {};
  const platforms = (options === lastArg ? args.slice(0, -1) : args) as string[];
  return runCmdSync(process.execPath, [scriptPath, ...platforms], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: homeDir,
    },
    allowFailure: options?.allowFailure,
    timeoutMs: 30_000,
  });
}

function escapeRegExp(value: string) {
  return value.replaceAll(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
