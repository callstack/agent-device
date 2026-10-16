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

test('an alias is not a mock receiver where an enclosing scope redeclares its name', () => {
  assert.deepEqual(
    specs(
      "import { vi as mocks } from 'vitest';",
      "import * as testing from 'vitest';",
      "function parameter(mocks) { mocks.mock('a'); }",
      "const arrow = (testing) => testing.vi.mock('b');",
      "{ const mocks = other; mocks.mock('c'); }",
      "function hoisted() { if (flag) { var mocks = other; } mocks.mock('d'); }",
      "try {} catch (mocks) { mocks.mock('e'); }",
      "for (const { mocks } of list) mocks.mock('f');",
      "switch (kind) { case 1: class testing {} testing.vi.mock('g'); }",
      "const expression = function mocks() { mocks.mock('h'); };",
      "const named = class mocks { run() { mocks.mock('i'); } };",
      "namespace Fixture { const testing = other; testing.vi.mock('j'); }",
    ),
    [],
  );
  assert.deepEqual(
    specs(
      "import { vi as mocks } from 'vitest';",
      'function unrelated(mocks) { return mocks; }',
      '{ const mocks = other; }',
      "mocks.mock('outside');",
    ),
    ['outside'],
  );
});

test('a parameter initializer sees the parameters but not the body declarations', () => {
  const alias = "import { vi as mocks } from 'vitest';";
  assert.deepEqual(
    specs(
      alias,
      "function bodyVar(x = mocks.mock('a')) { var mocks; }",
      "const arrow = (x = mocks.doMock('b')) => { var mocks; };",
      "function bodyFunction(x = mocks.mock('c')) { function mocks() {} }",
      "const method = { run(x = mocks.mock('d')) { var mocks; } };",
    ),
    ['a', 'b', 'c', 'd'],
  );
  assert.deepEqual(
    specs(
      alias,
      "function earlier(mocks, x = mocks.mock('e')) {}",
      "const arrow = (mocks, x = mocks.mock('f')) => x;",
      "const expression = function mocks(x = mocks.mock('g')) {};",
      "function body(x) { var mocks = other; return mocks.mock('h'); }",
    ),
    [],
  );
});

test('a switch discriminant sees the enclosing scope, not the case declarations', () => {
  const alias = "import { vi as mocks } from 'vitest';";
  assert.deepEqual(specs(alias, "switch (mocks.mock('a')) { case 0: let mocks; }"), ['a']);
  assert.deepEqual(
    specs(alias, "switch (kind) { case 0: const mocks = other; mocks.mock('b'); }"),
    [],
  );
  assert.deepEqual(
    specs(alias, "switch (kind) { case 0: let mocks; break; default: mocks.mock('c'); }"),
    [],
  );
});

test('a static block and a namespace body are var scopes of their own', () => {
  const alias = "import { vi as mocks } from 'vitest';";
  assert.deepEqual(
    specs(
      alias,
      "function staticVar() { class C { static { var mocks; } } mocks.mock('a'); }",
      "function namespaceVar() { namespace N { var mocks = other; } mocks.mock('b'); }",
      "class D { static { var mocks = other; } } mocks.mock('c');",
    ),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    specs(
      alias,
      "class C { static { var mocks = other; mocks.mock('d'); } }",
      "class E { static { if (flag) { var mocks = other; } mocks.mock('e'); } }",
      "namespace N { var mocks = other; mocks.mock('f'); }",
      "namespace M { if (flag) { var mocks = other; } mocks.mock('g'); }",
    ),
    [],
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
