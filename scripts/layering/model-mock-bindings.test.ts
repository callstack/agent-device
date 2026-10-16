// How `parseModuleMockSpecifiers` resolves the receiver of a mock-family call: the global
// `vi`/`vitest`, or a local name an `import ... from 'vitest'` declaration binds to them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseModuleMockSpecifiers } from './model.ts';

function specs(...lines: string[]): string[] {
  return parseModuleMockSpecifiers(lines.join('\n')).map(({ spec }) => spec);
}

test('a named import aliasing vi or vitest is a mock receiver', () => {
  assert.deepEqual(
    specs(
      "import { vi as mocks, vitest as runner } from 'vitest';",
      "mocks.mock('a');",
      "runner.doMock('b');",
      "mocks['unmock']('c');",
      "await mocks.importActual('d');",
      "mocks?.importMock('e');",
      "(mocks as typeof vi).mock('f');",
      "mocks!.doUnmock('g');",
    ),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  );
});

test('a string-named import and an unaliased import resolve like a named alias', () => {
  assert.deepEqual(
    specs("import { 'vi' as quoted, vi } from 'vitest';", "quoted.mock('a');", "vi.mock('b');"),
    ['a', 'b'],
  );
});

test('a vitest namespace import reaches the mock API through vi and vitest members', () => {
  assert.deepEqual(
    specs(
      "import * as testing from 'vitest';",
      "testing.vi.mock('a');",
      "testing.vitest.doMock('b');",
      "testing['vi'].unmock('c');",
      "testing.vi['importActual']('d');",
      "testing[`vitest`].importMock('e');",
      "testing?.vi?.mock('f');",
      "(testing.vi as typeof vi).mock('g');",
    ),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  );
});

test('only a value import from vitest binds a mock receiver', () => {
  assert.deepEqual(
    specs(
      "import { vi as fromOther } from 'not-vitest';",
      "import { vi as fromRelative } from './vitest.ts';",
      "import type { vi as typeDeclaration } from 'vitest';",
      "import { type vi as typeSpecifier } from 'vitest';",
      "import { expect as notMock, describe as alsoNotMock } from 'vitest';",
      "import * as otherNamespace from 'not-vitest';",
      "import type * as typeNamespace from 'vitest';",
      "fromOther.mock('a');",
      "fromRelative.mock('b');",
      "typeDeclaration.mock('c');",
      "typeSpecifier.mock('d');",
      "notMock.mock('e');",
      "alsoNotMock.mock('f');",
      "otherNamespace.vi.mock('g');",
      "typeNamespace.vi.mock('h');",
    ),
    [],
  );
});

test('a vitest namespace member other than vi or vitest is not the mock API', () => {
  assert.deepEqual(
    specs(
      "import * as testing from 'vitest';",
      "testing.expect.mock('a');",
      "testing[member].mock('b');",
      "testing['expect'].mock('c');",
    ),
    [],
  );
});

test('an alias counts everywhere in the file, even where a local shadows its name', () => {
  assert.deepEqual(
    specs(
      "import { vi as mocks } from 'vitest';",
      "import * as testing from 'vitest';",
      "function parameter(mocks) { mocks.mock('a'); }",
      "const arrow = (testing) => testing.vi.mock('b');",
      "{ const mocks = other; mocks.mock('c'); }",
      "try {} catch (mocks) { mocks.mock('d'); }",
    ),
    ['a', 'b', 'c', 'd'],
  );
});

test('an alias call is read inside every construct that can hold a module literal', () => {
  assert.deepEqual(
    specs(
      "import { vi as mocks } from 'vitest';",
      "function initializer(x = mocks.mock('a')) { var mocks; }",
      "switch (mocks.mock('b')) { case 0: let mocks; }",
      "class C { static { mocks.doMock('c'); } }",
      "namespace N { mocks.unmock('d'); }",
    ),
    ['a', 'b', 'c', 'd'],
  );
});

test('the global vi and vitest names stay mock receivers beside import aliases', () => {
  assert.deepEqual(
    specs(
      "import { vi as mocks } from 'vitest';",
      "vi.mock('a');",
      "vitest.mock('b');",
      "async function setup() { const { vi } = await import('vitest'); vi.doMock('c'); }",
    ),
    ['a', 'b', 'c'],
  );
});

test('an alias call still ignores comments, non-literal modules and non-module methods', () => {
  assert.deepEqual(
    specs(
      "import { vi as mocks } from 'vitest';",
      "import * as testing from 'vitest';",
      "// mocks.mock('commented');",
      "/* testing.vi.doMock('block') */",
      'const text = "mocks.mock(\'in-string\')";',
      'mocks.mock(variable);',
      'mocks.mock(`interpolated-${name}`);',
      'testing.vi.mock();',
      "mocks.fn('not-a-module-api');",
      "mocks.mocked('not-a-module-api');",
      "mocks[method]('computed-member');",
      "mocks.mock.mockReset('nested');",
      "mocks('call-not-member');",
    ),
    [],
  );
});

test('only the module-path methods Vitest exposes count, through every receiver form', () => {
  assert.deepEqual(
    specs(
      "import { vi as mocks } from 'vitest';",
      "import * as testing from 'vitest';",
      "mocks.mockActual('a');",
      "testing.vi.mockActual('b');",
      "vi.mockActual('c');",
      "mocks.importActual('d');",
      "testing.vi.importActual('e');",
      "vi.importActual('f');",
    ),
    ['d', 'e', 'f'],
  );
});

test('a Vitest binding made by a dynamic import is not followed', () => {
  assert.deepEqual(
    specs(
      "const { vi: mocks } = await import('vitest');",
      "const testing = await import('vitest');",
      "mocks.mock('a');",
      "testing.vi.mock('b');",
    ),
    [],
  );
});

test('a module named by an alias call keeps its source line', () => {
  assert.deepEqual(
    parseModuleMockSpecifiers(
      "import { vi as mocks } from 'vitest';\n\nmocks.mock(\n  `multi`,\n);",
    ),
    [{ spec: 'multi', line: 3 }],
  );
});
