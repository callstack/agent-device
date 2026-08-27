import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

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

/** Every YAML GitHub reads under a `.github` tree: both extensions, local actions at any depth. */
function offenders(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((entry) => path.join(root, entry))
    .filter((file) => /\.ya?ml$/.test(file) && fs.statSync(file).isFile())
    .flatMap((file) =>
      uploadSteps(parse(fs.readFileSync(file, 'utf8')))
        .filter((step) => {
          const paths = String(step.with?.path ?? '')
            .split('\n')
            .map((entry) => entry.trim())
            .filter(Boolean);
          return paths.some(isHidden) && step.with?.['include-hidden-files'] !== true;
        })
        .map((step) => `${path.relative(root, file)}: ${step.with?.name ?? '(unnamed)'}`),
    );
}

test('every artifact upload that writes a hidden path opts into hidden files', () => {
  expect(
    offenders(path.join(repoRoot, '.github')),
    'these uploads silently discard their hidden paths',
  ).toEqual([]);
});

test('the scan reaches every shape GitHub accepts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-uploads-'));
  const plant = (file: string, name: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(
      path.join(root, file),
      `jobs:\n  j:\n    steps:\n      - uses: actions/upload-artifact@v4\n` +
        `        with:\n          name: ${name}\n          path: .tmp/out\n`,
    );
  };
  try {
    plant('workflows/dotyaml.yaml', 'yaml-extension');
    plant('actions/nested/inner/action.yaml', 'nested-action');
    plant('actions/shallow/action.yml', 'shallow-action');

    expect(offenders(root).sort()).toEqual([
      'actions/nested/inner/action.yaml: nested-action',
      'actions/shallow/action.yml: shallow-action',
      'workflows/dotyaml.yaml: yaml-extension',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
