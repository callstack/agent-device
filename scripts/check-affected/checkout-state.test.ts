import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCmdSync } from '@agent-device/host-kit/command';
import { readCheckoutState } from './checkout-state.ts';

test('checkout fingerprint distinguishes edits with identical porcelain status and includes untracked contents', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-state-'));
  const git = (...args: string[]) => runCmdSync('git', args, { cwd });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(cwd, 'source.ts'), 'base');
    git('add', '.');
    git('commit', '-qm', 'base');
    const clean = readCheckoutState(cwd);
    assert.equal(clean.status, '');
    fs.writeFileSync(path.join(cwd, 'source.ts'), 'first');
    const first = readCheckoutState(cwd);
    fs.writeFileSync(path.join(cwd, 'source.ts'), 'second');
    const second = readCheckoutState(cwd);
    assert.equal(first.status, second.status);
    assert.notEqual(first.fingerprint, second.fingerprint);
    fs.writeFileSync(path.join(cwd, 'new.ts'), 'one');
    const untracked = readCheckoutState(cwd);
    fs.writeFileSync(path.join(cwd, 'new.ts'), 'two');
    assert.notEqual(untracked.fingerprint, readCheckoutState(cwd).fingerprint);
    const beforeChmod = readCheckoutState(cwd);
    fs.chmodSync(path.join(cwd, 'new.ts'), 0o755);
    if (process.platform !== 'win32')
      assert.notEqual(beforeChmod.fingerprint, readCheckoutState(cwd).fingerprint);
    git('add', '.');
    assert.notEqual(second.fingerprint, readCheckoutState(cwd).fingerprint);
    // Both status and ls-files must tolerate more than spawnSync's default 1 MiB.
    git('config', 'core.longpaths', 'true');
    const wide = path.join(cwd, ...Array<string>(3).fill('d'.repeat(220)));
    fs.mkdirSync(wide, { recursive: true });
    for (let index = 0; index < 1200; index++)
      fs.writeFileSync(path.join(wide, `${index}-${'x'.repeat(220)}`), '');
    assert.ok(readCheckoutState(cwd).status.length > 1024 * 1024);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkout fingerprint handles an untracked nested repository and detects its source edits', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-nested-'));
  const git = (directory: string, ...args: string[]) => runCmdSync('git', args, { cwd: directory });
  try {
    git(cwd, 'init', '-q');
    git(cwd, 'config', 'user.email', 'test@example.com');
    git(cwd, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(cwd, 'source.ts'), 'base');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'base');
    const nested = path.join(cwd, 'scratch');
    fs.mkdirSync(nested);
    git(nested, 'init', '-q');
    fs.writeFileSync(path.join(nested, 'source.ts'), 'one');
    fs.writeFileSync(path.join(nested, '.gitignore'), 'ignored/\n');
    const first = readCheckoutState(cwd);
    assert.match(first.status, /\?\? scratch\//);
    fs.writeFileSync(path.join(nested, 'source.ts'), 'two');
    const second = readCheckoutState(cwd);
    assert.equal(first.status, second.status);
    assert.notEqual(first.fingerprint, second.fingerprint);
    fs.mkdirSync(path.join(nested, 'ignored'));
    fs.writeFileSync(path.join(nested, 'ignored', 'artifact'), 'ignored');
    assert.equal(second.fingerprint, readCheckoutState(cwd).fingerprint);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
