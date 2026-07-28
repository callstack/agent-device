import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const actionPath = path.join(repoRoot, '.github/actions/upload-agent-device-artifacts/action.yml');

test('the diagnostics artifact includes hidden files only from its declared inputs', () => {
  const action = parse(fs.readFileSync(actionPath, 'utf8')) as {
    runs: { steps: Array<{ uses?: string; with?: Record<string, unknown> }> };
  };
  const upload = action.runs.steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );

  expect(upload, 'the artifact action must include an upload-artifact step').toBeDefined();
  expect(
    upload?.with?.['include-hidden-files'],
    'hidden daemon, session, and runner diagnostics must be included',
  ).toBe(true);
  expect(
    String(upload?.with?.path)
      .trim()
      .split('\n')
      .map((entry) => entry.trim()),
  ).toEqual([
    '${{ inputs.agent-home-dir }}/daemon.log',
    '${{ inputs.agent-home-dir }}/logs/**',
    '${{ inputs.agent-home-dir }}/sessions/**',
    '${{ inputs.runner-derived-path }}/.agent-device-runner-cache.json',
    '${{ inputs.runner-derived-path }}/Logs/**',
    'test/artifacts/**',
    'test/screenshots/**',
  ]);
});
