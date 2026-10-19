// `specifierSites` is the one literal-site extractor every R11/R83/R85 walk shares: import edges
// plus Vitest mock-family module arguments.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { specifierSites } from './package-boundaries.ts';

function sites(source: string): string[] {
  return specifierSites('src/a.test.ts', source).map(
    ({ line, specifier }) => `${line}:${specifier}`,
  );
}

test('specifier sites carry mock-family module arguments with their lines', () => {
  assert.deepEqual(
    sites(
      [
        "vi.mock('a');",
        'vi.mock(`b`);',
        "vi['doMock']('c');",
        "await vi.importMock('d');",
        'vi.doUnmock(`e`);',
        "import { x } from './f.ts';",
      ].join('\n'),
    ),
    ['1:a', '2:b', '3:c', '4:d', '5:e', '6:./f.ts'],
  );
});

test('specifier sites report a module once when an import edge and a mock call share its line', () => {
  assert.deepEqual(sites("vi.mock(import('a'), () => ({}));"), ['1:a']);
  assert.deepEqual(sites("const a = await vi.importActual<typeof import('a')>('a');"), ['1:a']);
});

test('specifier sites skip comments, interpolated templates and unrelated objects', () => {
  assert.deepEqual(
    sites(
      [
        "// vi.mock('commented');",
        'vi.mock(`interpolated-${name}`);',
        "other.mock('unrelated');",
        "vi[method]('computed');",
      ].join('\n'),
    ),
    [],
  );
});

test('specifier sites carry mock-family arguments called through an imported Vitest alias or namespace', () => {
  assert.deepEqual(
    sites(
      [
        "import { vi as mocks, vitest as runner } from 'vitest';",
        "import * as testing from 'vitest';",
        "mocks.mock('a');",
        "runner['doMock']('b');",
        "testing.vi.mock('c');",
        "testing['vitest'].unmock('d');",
      ].join('\n'),
    ),
    ['1:vitest', '2:vitest', '3:a', '4:b', '5:c', '6:d'],
  );
});

test('specifier sites skip alias calls on other modules, other exports and type-only imports', () => {
  assert.deepEqual(
    sites(
      [
        "import { vi as fromOther } from 'not-vitest';",
        "import { expect as notMock } from 'vitest';",
        "import type { vi as typeOnly } from 'vitest';",
        "fromOther.mock('a');",
        "notMock.mock('b');",
        "typeOnly.mock('c');",
        "function shadow(notMock) { notMock.mock('d'); }",
      ].join('\n'),
    ),
    ['1:not-vitest', '2:vitest', '3:vitest'],
  );
});
