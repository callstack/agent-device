import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mkdtempForTestSync } from '../../src/__tests__/test-utils/tmp-dir.ts';

test(
  'macOS sandbox process evidence preserves ownership, zombies, and protected-file denial',
  { skip: process.platform !== 'darwin' },
  () => {
    const temporary = realpathSync(mkdtempForTestSync('agent-device-process-sandbox-'));
    const checker = join(temporary, 'check');
    execFileSync(
      '/usr/bin/clang',
      [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        fileURLToPath(new URL('./fixtures/macos-process-check.c', import.meta.url)),
        '-o',
        checker,
      ],
      { timeout: 10_000 },
    );
    assert.match(
      execFileSync(checker, { encoding: 'utf8' }),
      /identity and argument bounds passed/,
    );
    const sentinel = join(temporary, 'secret');
    writeFileSync(sentinel, 'must stay unreadable');
    const expectedStart = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
      encoding: 'utf8',
    }).trim();
    for (const mode of ['allowed', 'denied']) {
      const policy = `(version 1)(allow default)(deny file-read-data (literal ${JSON.stringify(sentinel)}))${mode === 'denied' ? '(deny process-info*)' : ''}`;
      const output = execFileSync(
        '/usr/bin/sandbox-exec',
        [
          '-p',
          policy,
          process.execPath,
          fileURLToPath(new URL('./fixtures/macos-process-smoke.mjs', import.meta.url)),
          mode,
          sentinel,
          checker,
          expectedStart,
        ],
        { timeout: 30_000, encoding: 'utf8' },
      );
      assert.match(output, new RegExp(`sandbox process ${mode} passed`));
    }
  },
);
