import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { INTERACTOR_OPERATIONS } from './interactor-operation-catalog.ts';

const sourceDir = dirname(fileURLToPath(import.meta.url));
const conformanceImport = "from './interactor-operation-conformance.fixtures.ts'";
const conformanceRow = /\boperation: '(\w+)'/g;

/** Every `[test file, operation]` pair a module's conformance table names. */
const conformed: readonly (readonly [file: string, operation: string])[] = readdirSync(sourceDir)
  .filter((name) => name.endsWith('-runtime.test.ts'))
  .flatMap((file) => {
    const source = readFileSync(join(sourceDir, file), 'utf8');
    if (!source.includes(conformanceImport)) return [];
    return [...source.matchAll(conformanceRow)].map((match) => [file, match[1] as string] as const);
  });
const registered: readonly string[] = INTERACTOR_OPERATIONS.map(({ operation }) => operation);

test('every interactor catalog operation has exactly one conformance table naming it', () => {
  const claimants = (operation: string) =>
    conformed.filter(([, claimed]) => claimed === operation).map(([file]) => file);

  expect(
    registered.filter((operation) => claimants(operation).length === 0),
    'catalog operations with no conformance row',
  ).toEqual([]);
  expect(
    registered
      .filter((operation) => claimants(operation).length > 1)
      .map((operation) => `${operation}: ${claimants(operation).join(', ')}`),
    'catalog operations conformed by more than one module',
  ).toEqual([]);
});

test('every operation a conformance table names is registered in the interactor catalog', () => {
  expect(
    conformed
      .filter(([, operation]) => !registered.includes(operation))
      .map(([file, operation]) => `${file}: ${operation}`),
    'conformance rows the catalog does not register',
  ).toEqual([]);
});
