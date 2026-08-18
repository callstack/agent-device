// Regression pin for #1781 A9: the six root-level docs files
// (AGENTS.md, CHANGELOG.md, CONTEXT.md, CONTRIBUTING.md, LICENSE, SECURITY.md)
// must stay in the `pull_request` `paths-ignore` list of every workflow that
// also ignores `docs/**`/`website/**`/`README.md` — the four device lanes plus
// `ci.yml` and `size.yml`. Nothing else derives this: `check:gate-manifest`
// only asks whether a *registered check* is reachable, generic Markdown
// coverage does not look at workflow trigger config at all, and `actionlint`
// only validates YAML shape, not policy — so a PR that quietly drops one entry
// (e.g. re-adds `LICENSE` to a device workflow while missing it in `size.yml`)
// would pass every other gate and put a full 9-15 min device run back on
// prose-only PRs. This test reads the real workflow files and asserts the
// behavior directly, via the same glob matcher the gate-manifest model uses
// to decide whether a lane triggers for a given path.

import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { matchesGlob } from '../../scripts/gate/workflows.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

const WORKFLOWS = ['ios.yml', 'android.yml', 'linux.yml', 'macos.yml', 'ci.yml', 'size.yml'];

const ROOT_DOCS = [
  'AGENTS.md',
  'CHANGELOG.md',
  'CONTEXT.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'SECURITY.md',
];

type WorkflowDoc = {
  // A bare `on:` key can parse as the boolean key `true` under YAML 1.1
  // semantics; scripts/gate/workflows.ts already guards against this, so this
  // test mirrors that fallback rather than trusting `on` alone.
  on?: Record<string, { 'paths-ignore'?: string[] }>;
  true?: Record<string, { 'paths-ignore'?: string[] }>;
};

function pathsIgnore(file: string): string[] {
  const doc = parse(
    fs.readFileSync(path.join(repoRoot, '.github/workflows', file), 'utf8'),
  ) as WorkflowDoc;
  const on = doc.on ?? doc.true ?? {};
  return on.pull_request?.['paths-ignore'] ?? [];
}

test.each(WORKFLOWS)('%s skips a pull_request triggered by only a root doc', (file) => {
  const ignored = pathsIgnore(file);
  for (const rootDoc of ROOT_DOCS) {
    expect(
      ignored.some((pattern) => matchesGlob(pattern, rootDoc)),
      `${file}'s paths-ignore must match ${rootDoc} (got ${JSON.stringify(ignored)})`,
    ).toBe(true);
  }
});
