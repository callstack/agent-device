import assert from 'node:assert/strict';
import { test } from 'node:test';
import { substrateDomainShapeViolations } from './substrate-domain-shape.ts';

function messages(path: string, source: string): string[] {
  return substrateDomainShapeViolations([{ path, source }]).map((violation) => violation.message);
}

test('capture-kit rejects request-scoped async_hooks dispatch', () => {
  assert.match(
    messages(
      'packages/capture-kit/src/device-inventory-context.ts',
      "import { AsyncLocalStorage } from 'node:async_hooks';\n",
    )[0]!,
    /request-scoped AsyncLocalStorage dispatch belongs in src\/request/,
  );
  assert.match(
    messages(
      'packages/capture-kit/src/device-inventory-context.ts',
      'const store = new AsyncLocalStorage();\n',
    )[0]!,
    /request-scoped dispatch belongs in src\/request/,
  );
});

test('capture-kit policy ignores types, prose, tests, and root-runtime ALS', () => {
  assert.deepEqual(
    messages(
      'packages/capture-kit/src/app-log-live-handle.ts',
      [
        'export type Store = { AsyncLocalStorage: number };',
        'const prose = "import { AsyncLocalStorage } from \'node:async_hooks\'";',
        '// new AsyncLocalStorage();',
      ].join('\n'),
    ),
    [],
  );
  assert.deepEqual(
    messages(
      'packages/capture-kit/src/device-inventory-context.test.ts',
      "import { AsyncLocalStorage } from 'node:async_hooks';",
    ),
    [],
  );
  assert.deepEqual(
    messages(
      'src/request/device-inventory-context.ts',
      "import { AsyncLocalStorage } from 'node:async_hooks';\nconst store = new AsyncLocalStorage();\n",
    ),
    [],
  );
});

test('retired src/contracts/ production files fail closed', () => {
  assert.match(
    messages('src/contracts/interaction-outcome.ts', 'export const x = 1;\n')[0]!,
    /src\/contracts\/ is retired/,
  );
  assert.deepEqual(messages('packages/contracts/src/interaction.ts', 'export type X = 1;\n'), []);
});
