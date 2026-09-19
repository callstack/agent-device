// A six-file corpus with three families, built through the layering gate's real import
// resolver so the evidence tests exercise the same edge kinds the report sees: a type-only
// import that must not count, a dynamic import that must not count, an external specifier, a
// same-dir test, a sibling `__tests__` test, a family-root test, a `(root)` file whose test sits
// in `src/__tests__/`, and a same-basename test in another family that is NOT a mirror.

import { resolveImportEdges, targetDagZone } from '../../layering/model.ts';
import type { FirstTouch } from '../../repo-history/records.ts';
import { buildCorpus, type Corpus } from '../corpus.ts';

const MINI_CORPUS_SOURCES: ReadonlyMap<string, string> = new Map([
  [
    'packages/alpha/src/a.ts',
    "import { b } from './b.ts';\nimport type { X } from '../../../src/beta/x.ts';\nimport fs from 'node:fs';\nexport const a = b + fs.constants.R_OK;\nexport type A = X;\n",
  ],
  ['packages/alpha/src/b.ts', 'export const b = 1;\n'],
  [
    'src/beta/x.ts',
    "import { b } from '../../packages/alpha/src/b.ts';\nimport { y } from './y.ts';\nimport { z } from './z.ts';\nexport const x = b + y + z;\nexport type X = number;\n",
  ],
  [
    'src/beta/y.ts',
    "import { b } from '../../packages/alpha/src/b.ts';\nimport { z } from './z.ts';\nexport const y = b + z;\n",
  ],
  [
    'src/beta/z.ts',
    "import { b } from '../../packages/alpha/src/b.ts';\nexport const z = b;\nexport const lazy = () => import('./y.ts');\n",
  ],
  [
    'src/gamma.ts',
    "import { x } from './beta/x.ts';\nimport { z } from 'zod';\nexport const gamma = x + z.string.length;\n",
  ],
]);

export const MINI_CORPUS_TESTS: readonly string[] = [
  'packages/alpha/src/a.test.ts',
  'packages/alpha/src/z.test.ts',
  'src/beta/__tests__/x.test.ts',
  'src/beta/test/deep/y.test.ts',
  'src/__tests__/gamma.test.ts',
];

function touch(id: string, sha: string, subject: string, path = id): FirstTouch {
  return { id, sha, date: '2026-01-01T00:00:00+00:00', subject, status: 'A', path };
}

const MINI_CORPUS_FIRST_TOUCH: ReadonlyMap<string, FirstTouch> = new Map([
  [
    'packages/alpha/src/a.ts',
    touch('packages/alpha/src/a.ts', 'c1', 'feat(alpha): add alpha module (#1)'),
  ],
  [
    'packages/alpha/src/b.ts',
    touch('packages/alpha/src/b.ts', 'c1', 'feat(alpha): add alpha module (#1)'),
  ],
  ['src/beta/x.ts', touch('src/beta/x.ts', 'c2', 'feat: add x to beta')],
  ['src/beta/z.ts', touch('src/beta/z.ts', 'c3', 'refactor: move z', 'src/old/z.ts')],
  ['src/gamma.ts', touch('src/gamma.ts', 'c4', 'feat: gamma at the repo root')],
]);

export function miniCorpus(): Corpus {
  return buildCorpus({
    sources: MINI_CORPUS_SOURCES,
    edges: resolveImportEdges(MINI_CORPUS_SOURCES),
    testFiles: MINI_CORPUS_TESTS,
    firstTouch: MINI_CORPUS_FIRST_TOUCH,
    familyOf: targetDagZone,
  });
}

/** Names the scrubber removes per family, as `load.ts` derives them on the live tree. */
export const MINI_CORPUS_NAMES: ReadonlyMap<string, string[]> = new Map([
  ['alpha', ['alpha']],
  ['beta', ['beta']],
  ['(root)', ['(root)']],
]);
