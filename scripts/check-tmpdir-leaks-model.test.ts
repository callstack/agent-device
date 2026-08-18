import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  findLeakedRunDirectories,
  pruneAbandonedRunDirectories,
  runDirectoryNameOf,
} from './check-tmpdir-leaks-model.ts';

const NONE: ReadonlySet<string> = new Set();

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
    const leaks = findLeakedRunDirectories(root, {
      isAlive: (pid) => pid === 4242,
      consumers: NONE,
    });
    assert.deepEqual(leaks, []);
  });
});

test('a directory whose owning process has exited is reported as a leak', () => {
  withScratchRoot((root) => {
    fs.mkdirSync(path.join(root, 'agent-device-test-run-4242-abcdef'));
    const leaks = findLeakedRunDirectories(root, { isAlive: () => false, consumers: NONE });
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
    const leaks = findLeakedRunDirectories(root, {
      isAlive: (pid) => alivePids.has(pid),
      consumers: NONE,
    });
    assert.deepEqual(leaks, []);
  });
});

test('a mix of active and abandoned directories reports only the abandoned one', () => {
  withScratchRoot((root) => {
    fs.mkdirSync(path.join(root, 'agent-device-test-run-1111-aaaaaa')); // alive
    fs.mkdirSync(path.join(root, 'agent-device-test-run-3333-cccccc')); // exited
    const leaks = findLeakedRunDirectories(root, {
      isAlive: (pid) => pid === 1111,
      consumers: NONE,
    });
    assert.deepEqual(leaks, ['agent-device-test-run-3333-cccccc']);
  });
});

test('a directory with no parseable pid is conservatively reported as a leak', () => {
  withScratchRoot((root) => {
    fs.mkdirSync(path.join(root, 'agent-device-test-run-not-a-pid'));
    const leaks = findLeakedRunDirectories(root, { isAlive: () => true, consumers: NONE });
    assert.deepEqual(leaks, ['agent-device-test-run-not-a-pid']);
  });
});

test('non-matching directories and files are ignored', () => {
  withScratchRoot((root) => {
    fs.mkdirSync(path.join(root, 'unrelated-directory'));
    fs.writeFileSync(path.join(root, 'agent-device-test-run-4242-loose-file'), '');
    const leaks = findLeakedRunDirectories(root, { isAlive: () => false, consumers: NONE });
    assert.deepEqual(leaks, []);
  });
});

test('pruning removes only abandoned directories and returns their names', () => {
  withScratchRoot((root) => {
    fs.mkdirSync(path.join(root, 'agent-device-test-run-1111-aaaaaa')); // alive
    fs.mkdirSync(path.join(root, 'agent-device-test-run-3333-cccccc', 'nested'), {
      recursive: true,
    }); // exited, non-empty
    fs.mkdirSync(path.join(root, 'agent-device-test-run-not-a-pid')); // no owner
    fs.mkdirSync(path.join(root, 'unrelated-directory'));
    const pruned = pruneAbandonedRunDirectories(root, {
      isAlive: (pid) => pid === 1111,
      consumers: NONE,
    });
    assert.deepEqual(pruned.sort(), [
      'agent-device-test-run-3333-cccccc',
      'agent-device-test-run-not-a-pid',
    ]);
    assert.deepEqual(fs.readdirSync(root).sort(), [
      'agent-device-test-run-1111-aaaaaa',
      'unrelated-directory',
    ]);
    // Once pruned, the post-run check has nothing historical left to report.
    assert.deepEqual(
      findLeakedRunDirectories(root, { isAlive: (pid) => pid === 1111, consumers: NONE }),
      [],
    );
  });
});

test('pruning nothing is a no-op that reports nothing', () => {
  withScratchRoot((root) => {
    fs.mkdirSync(path.join(root, 'agent-device-test-run-1111-aaaaaa'));
    assert.deepEqual(
      pruneAbandonedRunDirectories(root, { isAlive: () => true, consumers: NONE }),
      [],
    );
    assert.deepEqual(fs.readdirSync(root), ['agent-device-test-run-1111-aaaaaa']);
  });
});

test('a directory whose owner is dead but which some live process still holds as TMPDIR is not a leak', () => {
  withScratchRoot((root) => {
    // The motivating case: the wrapper/vitest owner was SIGKILLed, its node --test chain or
    // forked workers (or a daemon a test spawned) are still running with TMPDIR inside the
    // directory. Nobody may prune it until the last of them exits.
    fs.mkdirSync(path.join(root, 'agent-device-test-run-4242-orphaned'));
    fs.mkdirSync(path.join(root, 'agent-device-test-run-5555-finished'));
    const consumers = new Set(['agent-device-test-run-4242-orphaned']);
    assert.deepEqual(findLeakedRunDirectories(root, { isAlive: () => false, consumers }), [
      'agent-device-test-run-5555-finished',
    ]);
    assert.deepEqual(pruneAbandonedRunDirectories(root, { isAlive: () => false, consumers }), [
      'agent-device-test-run-5555-finished',
    ]);
    assert.deepEqual(fs.readdirSync(root), ['agent-device-test-run-4242-orphaned']);
    // Once the consumers are gone it is an ordinary abandoned directory.
    assert.deepEqual(
      pruneAbandonedRunDirectories(root, { isAlive: () => false, consumers: NONE }),
      ['agent-device-test-run-4242-orphaned'],
    );
    assert.deepEqual(fs.readdirSync(root), []);
  });
});

test('a consumer is identified by the run directory its TMPDIR sits inside, at any depth', () => {
  assert.equal(
    runDirectoryNameOf('/tmp/agent-device-test-run-123-abc'),
    'agent-device-test-run-123-abc',
  );
  assert.equal(
    runDirectoryNameOf('/tmp/agent-device-test-run-123-abc/nested/deeper'),
    'agent-device-test-run-123-abc',
  );
  assert.equal(runDirectoryNameOf('/tmp/other-123-abc'), undefined);
  assert.equal(runDirectoryNameOf('/var/folders/x/T/agent-device-test-run-1-a'), undefined);
});
