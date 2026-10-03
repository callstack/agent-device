import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createCustomReplayTestReporter } from '../custom.ts';
import { mkdtempForTest } from '../../../../__tests__/test-utils/tmp-dir.ts';

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
  const root = await mkdtempForTest('agent-device-reporter-contract-');
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

// #1478 P3 characterization: the export spellings and hook names below are the released
// public surface a shipped custom reporter is written against. The extraction preserves them
// exactly, so they are pinned by name rather than by structural inference.
test('prefers createReporter over default and reporter when a module exports several', async () => {
  const root = await mkdtempForTest('agent-device-reporter-precedence-');
  const modulePath = path.join(root, 'reporter.mjs');
  try {
    await fs.writeFile(
      modulePath,
      [
        "export const reporter = { name: 'named' };",
        "export default { name: 'default' };",
        "export function createReporter() { return { name: 'created' }; }",
      ].join('\n'),
      'utf8',
    );
    const created = await createCustomReplayTestReporter({
      kind: 'custom',
      modulePath,
      raw: modulePath,
    });
    assert.equal(created.name, 'created');

    const fallbackPath = path.join(root, 'fallback.mjs');
    await fs.writeFile(
      fallbackPath,
      ["export const reporter = { name: 'named' };", "export default { name: 'default' };"].join(
        '\n',
      ),
      'utf8',
    );
    const fallback = await createCustomReplayTestReporter({
      kind: 'custom',
      modulePath: fallbackPath,
      raw: fallbackPath,
    });
    assert.equal(fallback.name, 'default');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test.each([
  'onSuiteStart',
  'onTestStart',
  'onTestStep',
  'onTestResult',
  'onSuiteEnd',
  'getExitCode',
])('validates the shipped optional hook name %s', async (hook) => {
  const root = await mkdtempForTest('agent-device-reporter-hook-');
  const modulePath = path.join(root, 'reporter.mjs');
  try {
    await fs.writeFile(
      modulePath,
      `export default { name: 'hooks', ${hook}: 'not-a-function' };`,
      'utf8',
    );
    await assert.rejects(
      createCustomReplayTestReporter({ kind: 'custom', modulePath, raw: modulePath }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.message.includes(`${hook} must be a function`),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects malformed reporter hooks when the module is loaded', async () => {
  const root = await mkdtempForTest('agent-device-reporter-invalid-');
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
