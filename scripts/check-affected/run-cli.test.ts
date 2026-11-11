import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCmdSync } from '@agent-device/host-kit/command';
import type { ExecutionReceipt } from './execution.ts';

const root = path.resolve(import.meta.dirname, '../..');
const runner = path.join(import.meta.dirname, 'run.ts');

function fixture(failingScript?: string) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-cli-'));
  const git = (...args: string[]) => runCmdSync('git', args, { cwd }).stdout.trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const pkg = { name: 'validation-fixture', private: true, scripts };
  for (const script of Object.keys(pkg.scripts)) pkg.scripts[script] = 'node -e "process.exit(0)"';
  if (failingScript) pkg.scripts[failingScript] = 'node -e "process.exit(7)"';
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(
    path.join(cwd, 'pnpm-workspace.yaml'),
    'packages: []\npmOnFail: warn\nverifyDepsBeforeRun: warn\n',
  );
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.tmp\n.cache\n');
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'base');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'head');
  git('add', '.');
  git('commit', '-qm', 'head');
  return { cwd, base };
}

function invoke(cwd: string, args: string[]) {
  const result = runCmdSync(
    process.execPath,
    ['--experimental-strip-types', runner, '--run', '--json', ...args],
    {
      cwd,
      allowFailure: true,
      env: {
        ...process.env,
        HOME: path.join(cwd, '.tmp', 'home'),
        USERPROFILE: path.join(cwd, '.tmp', 'home'),
        AGENT_DEVICE_VALIDATION_PARENT: '',
      },
    },
  );
  return { ...result, receipt: JSON.parse(result.stdout) as ExecutionReceipt };
}

test(
  'CLI JSON contains execution plan and preserves the failing command exit code',
  { skip: process.platform === 'win32' },
  () => {
    const { cwd, base } = fixture('check:agent-guidance');
    try {
      const result = invoke(cwd, ['--base', base]);
      assert.equal(result.exitCode, 7, result.stderr);
      assert.equal(result.receipt.status, 'failed');
      assert.equal(result.receipt.exactCommit, true);
      assert.deepEqual(result.receipt.changedFiles, ['AGENTS.md']);
      assert.deepEqual(result.receipt.plan?.checks, ['agent-guidance']);
      assert.equal(result.receipt.results[0]?.exitCode, 7);
      assert.equal(result.receipt.results[0]?.status, 'failed');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test(
  'full CLI works without origin/main and still blocks a missing install',
  { skip: process.platform === 'win32' },
  () => {
    const { cwd } = fixture();
    try {
      const full = invoke(cwd, ['--full']);
      assert.equal(full.exitCode, 0, full.stderr);
      const ran = full.receipt.results
        .filter((result) => result.status === 'passed')
        .map((result) => result.id);
      assert.ok(ran.includes('di-seams'), ran.join(', '));
      assert.ok(ran.includes('unit'), ran.join(', '));
      assert.ok(!ran.includes('vitest-related'), ran.join(', '));
      assert.ok(!full.receipt.results.some((result) => result.id === 'android-helpers'));
      fs.writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
      const stale = invoke(cwd, ['--full']);
      assert.equal(stale.exitCode, 1);
      assert.match(stale.stderr, /node_modules does not match/);
      assert.deepEqual(stale.receipt.results, []);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);
