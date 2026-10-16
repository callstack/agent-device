// `specifierSites` is the one literal-site extractor every R11/R83/R85 walk shares: import edges
// plus Vitest mock-family module arguments. Compact sibling of package-boundaries.test.ts, which
// sits at its size ratchet.

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
