import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCmd, runCmdBackground } from '../src/utils/exec.ts';

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

test('the Swift toolchain wrapper keeps TMPDIR until a signaled child exits', async () => {
  const evidenceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'swift-toolchain-tmpdir-signal-test-'),
  );
  const readyPath = path.join(evidenceRoot, 'ready.json');
  const shutdownPath = path.join(evidenceRoot, 'shutdown.json');
  let childTmpDir: string | undefined;

  try {
    const probe = `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ tmpdir: process.env.TMPDIR }));
process.on('SIGTERM', () => {
  setTimeout(() => {
    fs.writeFileSync(
      ${JSON.stringify(shutdownPath)},
      JSON.stringify({ tmpdirExisted: fs.existsSync(process.env.TMPDIR) }),
    );
    process.exit(0);
  }, 200);
});
setInterval(() => {}, 1_000);
`;
    const background = runCmdBackground(
      process.execPath,
      ['--experimental-strip-types', WRAPPER, process.execPath, '-e', probe],
      {
        cwd: REPOSITORY_ROOT,
        allowFailure: true,
      },
    );

    await waitForFile(readyPath);
    childTmpDir = (JSON.parse(fs.readFileSync(readyPath, 'utf8')) as { tmpdir: string }).tmpdir;
    background.child.kill('SIGTERM');

    const result = await background.wait;
    assert.equal(result.exitCode, 143);
    assert.equal(
      (JSON.parse(fs.readFileSync(shutdownPath, 'utf8')) as { tmpdirExisted: boolean })
        .tmpdirExisted,
      true,
      'the child must retain TMPDIR until its delayed shutdown completes',
    );
    assert.equal(fs.existsSync(childTmpDir), false, `wrapper left behind: ${childTmpDir}`);
  } finally {
    if (childTmpDir) fs.rmSync(childTmpDir, { recursive: true, force: true });
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test(
  'the Swift toolchain wrapper keeps TMPDIR until signaled descendants exit',
  { skip: process.platform === 'win32' },
  async () => {
    const evidenceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'swift-toolchain-tmpdir-descendant-test-'),
    );
    const readyPath = path.join(evidenceRoot, 'ready.json');
    const shutdownPath = path.join(evidenceRoot, 'shutdown.json');
    let childTmpDir: string | undefined;
    let descendantPid: number | undefined;

    try {
      const descendantProbe = `
const fs = require('node:fs');
fs.writeFileSync(
  ${JSON.stringify(readyPath)},
  JSON.stringify({ pid: process.pid, tmpdir: process.env.TMPDIR }),
);
process.on('SIGTERM', () => {
  setTimeout(() => {
    fs.writeFileSync(
      ${JSON.stringify(shutdownPath)},
      JSON.stringify({ tmpdirExisted: fs.existsSync(process.env.TMPDIR) }),
    );
    process.exit(0);
  }, 200);
});
setInterval(() => {}, 1_000);
`;
      const directChildProbe = `
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => process.exit(0));
const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantProbe)}], {
  env: process.env,
  stdio: 'ignore',
});
descendant.unref();
setInterval(() => {}, 1_000);
`;
      const background = runCmdBackground(
        process.execPath,
        ['--experimental-strip-types', WRAPPER, process.execPath, '-e', directChildProbe],
        {
          cwd: REPOSITORY_ROOT,
          allowFailure: true,
        },
      );

      await waitForFile(readyPath);
      const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8')) as {
        pid: number;
        tmpdir: string;
      };
      descendantPid = ready.pid;
      childTmpDir = ready.tmpdir;
      background.child.kill('SIGTERM');

      const result = await background.wait;
      assert.equal(result.exitCode, 143);
      if (!fs.existsSync(shutdownPath)) process.kill(descendantPid, 'SIGTERM');
      await waitForFile(shutdownPath);
      assert.equal(
        (JSON.parse(fs.readFileSync(shutdownPath, 'utf8')) as { tmpdirExisted: boolean })
          .tmpdirExisted,
        true,
        'a delayed descendant must retain TMPDIR until its shutdown completes',
      );
      assert.equal(fs.existsSync(childTmpDir), false, `wrapper left behind: ${childTmpDir}`);
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {}
      }
      if (childTmpDir) fs.rmSync(childTmpDir, { recursive: true, force: true });
      fs.rmSync(evidenceRoot, { recursive: true, force: true });
    }
  },
);

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

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}
