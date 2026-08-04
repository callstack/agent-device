import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findLeakedRunDirectories } from './check-tmpdir-leaks-model.ts';

function withScratchRoot(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-tmpdir-leaks-model-test-'));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a directory owned by a still-running process is not reported as a leak', () => {
  withScratchRoot((root) => {
    fs.mkdirSync(path.join(root, 'agent-device-test-run-4242-abcdef'));
    const leaks = findLeakedRunDirectories(root, (pid) => pid === 4242);
    assert.deepEqual(leaks, []);
  });
});

test('a directory whose owning process has exited is reported as a leak', () => {
  withScratchRoot((root) => {
    fs.mkdirSync(path.join(root, 'agent-device-test-run-4242-abcdef'));
    const leaks = findLeakedRunDirectories(root, () => false);
    assert.deepEqual(leaks, ['agent-device-test-run-4242-abcdef']);
  });
});

test('a concurrent run from another worktree does not fail the check for this one', () => {
  withScratchRoot((root) => {
    // Simulates two worktrees running vitest at once: pid 1111 (this
    // invocation, still alive) and pid 2222 (a different worktree's
    // in-progress run, also alive).
    fs.mkdirSync(path.join(root, 'agent-device-test-run-1111-aaaaaa'));
    fs.mkdirSync(path.join(root, 'agent-device-test-run-2222-bbbbbb'));
    const alivePids = new Set([1111, 2222]);
    const leaks = findLeakedRunDirectories(root, (pid) => alivePids.has(pid));
    assert.deepEqual(leaks, []);
  });
});

test('a mix of active and abandoned directories reports only the abandoned one', () => {
  withScratchRoot((root) => {
    fs.mkdirSync(path.join(root, 'agent-device-test-run-1111-aaaaaa')); // alive
    fs.mkdirSync(path.join(root, 'agent-device-test-run-3333-cccccc')); // exited
    const leaks = findLeakedRunDirectories(root, (pid) => pid === 1111);
    assert.deepEqual(leaks, ['agent-device-test-run-3333-cccccc']);
  });
});

test('a directory with no parseable pid is conservatively reported as a leak', () => {
  withScratchRoot((root) => {
    fs.mkdirSync(path.join(root, 'agent-device-test-run-not-a-pid'));
    const leaks = findLeakedRunDirectories(root, () => true);
    assert.deepEqual(leaks, ['agent-device-test-run-not-a-pid']);
  });
});

test('non-matching directories and files are ignored', () => {
  withScratchRoot((root) => {
    fs.mkdirSync(path.join(root, 'unrelated-directory'));
    fs.writeFileSync(path.join(root, 'agent-device-test-run-4242-loose-file'), '');
    const leaks = findLeakedRunDirectories(root, () => false);
    assert.deepEqual(leaks, []);
  });
});
