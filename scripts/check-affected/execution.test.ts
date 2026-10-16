import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, run } from './execution.fixtures.ts';

test(
  'execution JSON contains exact checkout, command, failure exit, and bounded terminal output',
  { skip: process.platform === 'win32' },
  () => {
    const { cwd, sha } = fixture();
    try {
      const result = run(
        cwd,
        sha,
        `return execute([process.execPath, '-e', "console.log('x'.repeat(20000)); process.exit(7)"], ${JSON.stringify(cwd)}, 'fixture');`,
      );
      assert.equal(result.exitCode, 7);
      assert.equal(result.receipt.status, 'failed');
      assert.equal(result.receipt.exactCommit, true);
      assert.equal(result.receipt.initial?.head, sha);
      assert.equal(result.receipt.final?.head, sha);
      assert.equal(result.receipt.results[0]?.exitCode, 7);
      assert.ok(result.stderr.length < 10000);
      assert.ok(
        result.stderr.split('\n').every((line) => line.length <= 512),
        'failure excerpt lines stay bounded',
      );
      assert.ok(fs.readFileSync(result.receipt.results[0]!.logPath!, 'utf8').length > 20000);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test(
  'dirty local feedback cannot certify a commit; explicit head refuses dirty checkout',
  { skip: process.platform === 'win32' },
  () => {
    const { cwd, sha } = fixture();
    try {
      fs.writeFileSync(path.join(cwd, 'source.txt'), 'dirty');
      const local = run(cwd, 'HEAD', 'return 0;');
      assert.equal(local.exitCode, 0);
      assert.equal(local.receipt.exactCommit, false);
      const exact = run(cwd, sha, 'throw new Error("must not run");');
      assert.equal(exact.exitCode, 1);
      assert.match(exact.receipt.error!, /clean checkout/);
      assert.deepEqual(exact.receipt.results, []);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test(
  'mismatched head is rejected and checkout drift invalidates successful checks',
  { skip: process.platform === 'win32' },
  () => {
    const { cwd, sha, git } = fixture();
    try {
      fs.writeFileSync(path.join(cwd, 'source.txt'), 'new commit');
      git('add', '.');
      git('commit', '-qm', 'head');
      const mismatch = run(cwd, sha, 'return 0;');
      assert.equal(mismatch.exitCode, 1);
      const drift = run(
        cwd,
        'HEAD',
        `const fs = await import('node:fs'); fs.writeFileSync('source.txt', 'drift'); return 0;`,
      );
      assert.equal(drift.exitCode, 1);
      assert.equal(drift.receipt.checkoutChanged, true);
      assert.equal(drift.receipt.exactCommit, false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);
