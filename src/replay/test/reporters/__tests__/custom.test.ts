import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '../../../../kernel/errors.ts';
import { createCustomReplayTestReporter } from '../custom.ts';

test.each([
  {
    label: 'default reporter object',
    source: "export default { name: 'default-object' };",
    expectedName: 'default-object',
  },
  {
    label: 'named reporter object',
    source: "export const reporter = { name: 'named-object' };",
    expectedName: 'named-object',
  },
  {
    label: 'async createReporter factory',
    source: [
      'export async function createReporter(context) {',
      "  return { name: context.spec === context.modulePath ? 'async-factory' : 'wrong-context' };",
      '}',
    ].join('\n'),
    expectedName: 'async-factory',
  },
])('loads the shipped $label form', async ({ source, expectedName }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-reporter-contract-'));
  const modulePath = path.join(root, 'reporter.mjs');
  try {
    await fs.writeFile(modulePath, source, 'utf8');
    const reporter = await createCustomReplayTestReporter({
      kind: 'custom',
      modulePath,
      raw: modulePath,
    });
    assert.equal(reporter.name, expectedName);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects malformed reporter hooks when the module is loaded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-reporter-invalid-'));
  const modulePath = path.join(root, 'reporter.mjs');
  try {
    await fs.writeFile(
      modulePath,
      "export default { name: 'invalid', onSuiteEnd: 'not-a-function' };",
      'utf8',
    );
    await assert.rejects(
      createCustomReplayTestReporter({
        kind: 'custom',
        modulePath,
        raw: modulePath,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        /onSuiteEnd must be a function/.test(error.message),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
