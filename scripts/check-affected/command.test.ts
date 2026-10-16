import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCmdSync, runCmdStreaming } from '@agent-device/host-kit/command';

test('command cannot execute before activation and preserves the activated exit code', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-activation-'));
  const marker = path.join(directory, 'started');
  const args = [
    '--experimental-strip-types',
    path.join(import.meta.dirname, 'command.ts'),
    process.execPath,
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes'); process.stdout.write('o'.repeat(2000000)); process.stderr.write('e'.repeat(2000000)); process.exitCode = 7;`,
  ];
  try {
    assert.equal(runCmdSync(process.execPath, args, { allowFailure: true }).exitCode, 1);
    assert.equal(fs.existsSync(marker), false);
    const activated = await runCmdStreaming(process.execPath, args, {
      allowFailure: true,
      stdin: 'run\n',
      onSpawn: (child) => {
        child.stdout!.pause();
        child.stderr!.pause();
        setTimeout(() => {
          child.stdout!.resume();
          child.stderr!.resume();
        }, 500);
      },
    });
    assert.equal(activated.exitCode, 7);
    assert.equal(activated.stdout, 'o'.repeat(2000000));
    assert.equal(activated.stderr, 'e'.repeat(2000000));
    assert.equal(fs.readFileSync(marker, 'utf8'), 'yes');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
