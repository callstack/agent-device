import fs from 'node:fs/promises';
import path from 'node:path';
import { runRealHostCommand } from '@agent-device/test-kit';
import { expect, onTestFinished, test } from 'vitest';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import { appleRunnerHost } from '../runner-host.ts';

test.each([1, 257])(
  'the Apple runner archive host enforces the entry limit (%i files)',
  async (count) => {
    const root = await mkdtempForTest('agent-device-apple-runner-archive-');
    onTestFinished(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });
    const entries = Array.from({ length: count }, (_, index) => `runner-${index}`);
    await Promise.all(entries.map((entry) => fs.writeFile(path.join(root, entry), 'runner')));
    const archivePath = path.join(root, 'runner.tgz');
    const result = await runRealHostCommand('tar', ['-czf', archivePath, '-C', root, ...entries]);
    expect(result.exitCode).toBe(0);

    const outputRoot = path.join(root, 'products');
    const extraction = appleRunnerHost.extractRunnerReleaseArchive({ archivePath, outputRoot });
    if (count === 1) {
      await extraction;
      await expect(fs.readFile(path.join(outputRoot, 'runner-0'), 'utf8')).resolves.toBe('runner');
    } else {
      await expect(extraction).rejects.toMatchObject({
        details: { reason: 'ARCHIVE_ENTRY_LIMIT' },
      });
      await expect(fs.stat(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  },
);
