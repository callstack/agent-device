import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { REPO_ROOT } from '@agent-device/test-kit';
import { listTrackedRepoFiles } from '../../scripts/layering/tracked-sources.ts';

/**
 * An ADR states the current truth (docs/adr/FORMAT.md), so every repository file it cites must
 * exist. A citation is a backticked token with a source or config extension:
 *
 * 1. a repository path (it contains `/`) must name a tracked file;
 * 2. a bare test file name (`*.test.ts` and similar) must match a tracked file's name.
 *
 * Absolute and home paths (device or host files), globs, and bare non-test names (runtime state
 * files such as `daemon.json`) are not repository citations.
 */

const ADR_DIR = 'docs/adr';
const CITED_EXTENSIONS = 'ts|mts|cts|mjs|cjs|js|swift|kt|java|json|sh|yml|yaml|py';
const CITATION = new RegExp(`\`([A-Za-z0-9_./@{}*-]+\\.(?:${CITED_EXTENSIONS}))\``, 'g');
const TEST_FILE = /\.test\.[a-z]+$/;

type Citation = Readonly<{ adr: string; token: string }>;

function findStaleAdrCitations(
  adrs: ReadonlyArray<Readonly<{ name: string; text: string }>>,
  trackedFiles: readonly string[],
): Citation[] {
  const tracked = new Set(trackedFiles);
  const trackedNames = new Set(trackedFiles.map((file) => path.posix.basename(file)));
  const stale: Citation[] = [];
  for (const adr of adrs) {
    for (const [, token] of adr.text.matchAll(CITATION)) {
      if (!token || isNotRepositoryCitation(token)) continue;
      const exists = token.includes('/') ? tracked.has(token) : trackedNames.has(token);
      if (!exists) stale.push({ adr: adr.name, token });
    }
  }
  return stale;
}

function isNotRepositoryCitation(token: string): boolean {
  if (token.startsWith('/') || token.startsWith('~')) return true;
  if (/[*{}]/.test(token)) return true;
  return !token.includes('/') && !TEST_FILE.test(token);
}

function readAdrs(): Array<{ name: string; text: string }> {
  const dir = path.join(REPO_ROOT, ADR_DIR);
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

test('every repository file an ADR cites exists', () => {
  const stale = findStaleAdrCitations(readAdrs(), listTrackedRepoFiles(REPO_ROOT));
  assert.deepEqual(
    stale.map(({ adr, token }) => `${adr}: ${token}`),
    [],
    'Fix or remove each stale citation; see docs/adr/FORMAT.md "The record stays current".',
  );
});

test('the citation scan rejects missing paths and test names, and skips non-repository tokens', () => {
  const stale = findStaleAdrCitations(
    [
      {
        name: '0001-example.md',
        text: [
          '`packages/a/src/kept.ts`',
          '`packages/a/src/gone.ts`',
          '`commands/runtime-types.ts`',
          '`kept.test.ts`',
          '`gone.test.ts`',
          '`daemon.json`',
          '`/sdcard/marker.json`',
          '`src/platform-runtime-*.ts`',
        ].join('\n'),
      },
    ],
    ['packages/a/src/kept.ts', 'packages/a/src/__tests__/kept.test.ts'],
  );
  assert.deepEqual(
    stale.map(({ token }) => token),
    ['packages/a/src/gone.ts', 'commands/runtime-types.ts', 'gone.test.ts'],
  );
});
