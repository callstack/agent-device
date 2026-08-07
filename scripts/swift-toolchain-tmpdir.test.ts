import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCmd } from '../src/utils/exec.ts';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER = path.join(REPOSITORY_ROOT, 'scripts', 'swift-toolchain-tmpdir.ts');

async function runProbe(exitCode: number): Promise<{
  childTmpDir: string;
  resultExitCode: number;
}> {
  const evidenceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'swift-toolchain-tmpdir-lifecycle-test-'),
  );
  const evidencePath = path.join(evidenceRoot, 'child-tmpdir.txt');
  let childTmpDir: string | undefined;

  try {
    const probe = `
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(${JSON.stringify(evidencePath)}, process.env.TMPDIR);
const leaked = path.join(process.env.TMPDIR, 'TemporaryDirectory.probe');
fs.mkdirSync(leaked);
fs.writeFileSync(path.join(leaked, '.keep-directory'), '');
process.exit(${exitCode});
`;
    const result = await runCmd(
      process.execPath,
      ['--experimental-strip-types', WRAPPER, process.execPath, '-e', probe],
      {
        cwd: REPOSITORY_ROOT,
        timeoutMs: 30_000,
        allowFailure: true,
      },
    );

    childTmpDir = fs.readFileSync(evidencePath, 'utf8');
    assert.match(path.basename(childTmpDir), /^agent-device-swift-toolchain-/);
    assert.equal(fs.existsSync(childTmpDir), false, `wrapper left behind: ${childTmpDir}`);
    return { childTmpDir, resultExitCode: result.exitCode };
  } finally {
    if (childTmpDir) fs.rmSync(childTmpDir, { recursive: true, force: true });
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
}

test('the Swift toolchain wrapper removes its TMPDIR after success', async () => {
  const result = await runProbe(0);
  assert.equal(result.resultExitCode, 0);
});

test('the Swift toolchain wrapper cleans up and forwards a failure', async () => {
  const result = await runProbe(17);
  assert.equal(result.resultExitCode, 17);
});

test('Apple build lanes route toolchain commands through the cleanup wrapper', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };
  const scripts = manifest.scripts ?? {};
  assert.match(scripts['build:macos-helper'] ?? '', /swift-toolchain-tmpdir\.ts.*swift build/);
  assert.match(
    scripts['build:macos-helper:clean'] ?? '',
    /swift-toolchain-tmpdir\.ts.*swift package/,
  );

  const xcodeBuildScript = fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'scripts', 'build-xcuitest-apple.sh'),
    'utf8',
  );
  assert.match(xcodeBuildScript, /swift-toolchain-tmpdir\.ts xcodebuild build-for-testing/);
});
