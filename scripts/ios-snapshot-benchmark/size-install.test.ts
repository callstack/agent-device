import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { mkdtempForTest } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { measureDirectory } from '../size-report-install.mjs';

test('measures the clean-installed package tree without counting the consumer', async () => {
  const root = await mkdtempForTest('agent-device-size-tree-');
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'index.js'), '1234');
  await writeFile(join(root, 'nested', 'data.json'), '{}');
  assert.deepEqual(measureDirectory(root), { packageBytes: 6, files: 2 });
});
