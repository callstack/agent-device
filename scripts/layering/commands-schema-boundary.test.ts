import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCommandsSchemaBoundary } from './commands-schema-boundary.ts';
import { targetDagZone, type ResolvedImportEdge } from './model.ts';

function importEdge(
  file: string,
  target: string,
  overrides: Partial<ResolvedImportEdge> = {},
): ResolvedImportEdge {
  return {
    file,
    target,
    spec: target,
    line: 1,
    dynamic: false,
    typeOnly: false,
    symbols: [],
    fromZone: targetDagZone(file),
    toZone: targetDagZone(target),
    ...overrides,
  };
}

test('commands outside schema/ must not import commands/schema/', () => {
  const edge = importEdge('src/commands/cli-runner.ts', 'src/commands/schema/cli-help.ts');
  const violations = checkCommandsSchemaBoundary([edge]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.rule, 'R2 commands-floor');
  assert.match(violations[0]!.message, /must not import src\/commands\/schema\/cli-help\.ts/);
});

test('command-surface files outside schema/ must not import its schema/, except the entry', () => {
  const inner = importEdge(
    'packages/command-surface/src/capture/wait.ts',
    'packages/command-surface/src/schema/command-schema.ts',
  );
  const violations = checkCommandsSchemaBoundary([inner]);
  assert.equal(violations.length, 1);
  assert.match(
    violations[0]!.message,
    /must not import packages\/command-surface\/src\/schema\/command-schema\.ts/,
  );
  assert.match(violations[0]!.message, /packages\/command-surface\/src\/schema\/ renders/);
  const entry = importEdge(
    'packages/command-surface/src/index.ts',
    'packages/command-surface/src/schema/command-schema.ts',
  );
  assert.deepEqual(checkCommandsSchemaBoundary([entry]), []);
});

test('holds for value, type-only, and dynamic imports alike', () => {
  for (const overrides of [{}, { typeOnly: true }, { dynamic: true }]) {
    const edge = importEdge(
      'packages/command-surface/src/capture/wait.ts',
      'packages/command-surface/src/schema/command-schema.ts',
      overrides,
    );
    assert.equal(checkCommandsSchemaBoundary([edge]).length, 1);
  }
});

test('the declared direction — schema reading the rest of commands — stays silent', () => {
  const edge = importEdge(
    'packages/command-surface/src/schema/command-schema.ts',
    'packages/command-surface/src/command-metadata.ts',
  );
  assert.deepEqual(checkCommandsSchemaBoundary([edge]), []);
});

test('schema importing its own sibling files stays silent', () => {
  const edge = importEdge('src/commands/schema/cli-help.ts', 'src/commands/schema/usage.ts');
  assert.deepEqual(checkCommandsSchemaBoundary([edge]), []);
});

test('a non-commands zone importing commands/schema/ is not this rule’s concern', () => {
  const edge = importEdge('src/mcp/server-guide.ts', 'src/commands/schema/cli-help.ts');
  assert.deepEqual(checkCommandsSchemaBoundary([edge]), []);
});
