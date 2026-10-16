import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCmdSync } from '@agent-device/host-kit/command';

test('command cannot execute before activation and preserves the activated exit code', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-activation-'));
  const marker = path.join(directory, 'started');
  const args = [
    '--experimental-strip-types',
    path.join(import.meta.dirname, 'command.ts'),
    process.execPath,
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes'); process.exit(7);`,
  ];
  try {
    assert.equal(runCmdSync(process.execPath, args, { allowFailure: true }).exitCode, 1);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(
      runCmdSync(process.execPath, args, { allowFailure: true, stdin: 'run\n' }).exitCode,
      7,
    );
    assert.equal(fs.readFileSync(marker, 'utf8'), 'yes');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
