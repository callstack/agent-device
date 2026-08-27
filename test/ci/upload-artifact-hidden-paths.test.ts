import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

// `actions/upload-artifact` excludes hidden files and directories unless `include-hidden-files` is
// set (default since v4.4); this repository writes most of its diagnostics under `.tmp`.

const repoRoot = path.resolve(import.meta.dirname, '../..');

type Step = { uses?: unknown; with?: Record<string, unknown> };

function uploadSteps(node: unknown): Step[] {
  if (Array.isArray(node)) return node.flatMap(uploadSteps);
  if (node === null || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const self =
    typeof record.uses === 'string' && record.uses.startsWith('actions/upload-artifact@')
      ? [record as Step]
      : [];
  return [...self, ...Object.values(record).flatMap(uploadSteps)];
}

function isHidden(entry: string): boolean {
  return entry
    .split('/')
    .some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
}

function configuredFiles(): string[] {
  const workflows = path.join(repoRoot, '.github/workflows');
  const actions = path.join(repoRoot, '.github/actions');
  return [
    ...fs.readdirSync(workflows).map((name) => `.github/workflows/${name}`),
    ...fs.readdirSync(actions).map((name) => `.github/actions/${name}/action.yml`),
  ].filter((file) => file.endsWith('.yml') && fs.existsSync(path.join(repoRoot, file)));
}

test('every artifact upload that writes a hidden path opts into hidden files', () => {
  const offenders = configuredFiles().flatMap((file) =>
    uploadSteps(parse(fs.readFileSync(path.join(repoRoot, file), 'utf8')))
      .filter((step) => {
        const paths = String(step.with?.path ?? '')
          .split('\n')
          .map((entry) => entry.trim())
          .filter(Boolean);
        return paths.some(isHidden) && step.with?.['include-hidden-files'] !== true;
      })
      .map((step) => `${file}: ${step.with?.name ?? '(unnamed)'}`),
  );

  expect(offenders, 'these uploads silently discard their hidden paths').toEqual([]);
});
