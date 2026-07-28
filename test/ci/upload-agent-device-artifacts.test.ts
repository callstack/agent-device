import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const actionPath = path.join(repoRoot, '.github/actions/upload-agent-device-artifacts/action.yml');
const conformanceWorkflowPath = path.join(
  repoRoot,
  '.github/workflows/conformance-differential.yml',
);

type UploadStep = { uses?: unknown; with?: Record<string, unknown> };

function uploadArtifactSteps(source: unknown): UploadStep[] {
  if (Array.isArray(source)) return source.flatMap(uploadArtifactSteps);
  if (source === null || typeof source !== 'object') return [];
  const record = source as Record<string, unknown>;
  const matches =
    typeof record.uses === 'string' && record.uses.startsWith('actions/upload-artifact@')
      ? [record as UploadStep]
      : [];
  return [...matches, ...Object.values(record).flatMap(uploadArtifactSteps)];
}

function paths(step: UploadStep): string[] {
  return String(step.with?.path)
    .trim()
    .split('\n')
    .map((entry) => entry.trim());
}

test('the shared diagnostics artifact includes hidden files only from its declared paths', () => {
  const action = parse(fs.readFileSync(actionPath, 'utf8'));
  const uploads = uploadArtifactSteps(action);

  expect(uploads, 'the action must have exactly one artifact upload step').toHaveLength(1);
  const [upload] = uploads;
  expect(
    upload?.with?.['include-hidden-files'],
    'hidden daemon, session, and runner diagnostics must be included',
  ).toBe(true);
  expect(paths(upload!)).toEqual([
    '${{ inputs.agent-home-dir }}/daemon.log',
    '~/.agent-device/logs/**',
    '${{ inputs.agent-home-dir }}/sessions/**',
    '${{ inputs.runner-derived-path }}/.agent-device-runner-cache.json',
    '${{ inputs.runner-derived-path }}/Logs/**',
    'test/artifacts/**',
    'test/screenshots/**',
  ]);
  expect(
    paths(upload!).every((entry) =>
      [
        '${{ inputs.agent-home-dir }}/',
        '${{ inputs.runner-derived-path }}/',
        '~/.agent-device/logs/',
        'test/',
      ].some((prefix) => entry.startsWith(prefix)),
    ),
  ).toBe(true);
});

test('the conformance trace artifact includes the hidden replay root', () => {
  const workflow = parse(fs.readFileSync(conformanceWorkflowPath, 'utf8'));
  const uploads = uploadArtifactSteps(workflow);

  expect(uploads, 'the workflow must have exactly one artifact upload step').toHaveLength(1);
  const [upload] = uploads;
  expect(upload?.with?.['include-hidden-files']).toBe(true);
  expect(paths(upload!)).toEqual([
    '.tmp/conformance-differential/differential-report.json',
    '.agent-device/**/replay-timing.ndjson',
  ]);
});
