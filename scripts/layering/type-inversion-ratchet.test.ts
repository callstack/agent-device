import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveImportEdges, typeInversionCounts } from './model.ts';
import { checkTypeInversions } from './type-inversion-ratchet.ts';

/** `commandsFiles` commands files type-importing the client, plus one value import R6 ignores. */
function inversionEdges(commandsFiles: number) {
  const sources = new Map<string, string>([
    ['src/client/client.ts', 'export type AgentDeviceClient = { run(): void };'],
    ['src/commands/value-user.ts', "import { run } from '../client/client.ts';"],
  ]);
  for (let index = 0; index < commandsFiles; index++) {
    sources.set(
      `src/commands/typed-${index}.ts`,
      "import type { AgentDeviceClient } from '../client/client.ts';",
    );
  }
  return resolveImportEdges(sources);
}

test('typeInversionCounts keys distinct type-only inversions by zone pair, sorted', () => {
  assert.deepEqual(typeInversionCounts(inversionEdges(2)), { 'commands -> client': 2 });
  assert.deepEqual(typeInversionCounts([]), {});
});

test('R6 is quiet at the merge-base count, and banks a shrink with no edit', () => {
  assert.deepEqual(checkTypeInversions(inversionEdges(2), { 'commands -> client': 2 }), []);
  assert.deepEqual(checkTypeInversions(inversionEdges(1), { 'commands -> client': 2 }), []);
  assert.deepEqual(checkTypeInversions(inversionEdges(0), { 'commands -> client': 2 }), []);
});

test('R6 rejects a pair that grew past the merge-base and names the first edge', () => {
  const violations = checkTypeInversions(inversionEdges(3), { 'commands -> client': 2 });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.rule, 'R6 type-spine-inversion');
  assert.equal(violations[0]!.file, 'src/commands/typed-0.ts');
  assert.match(
    violations[0]!.message,
    /type-only commands -> client inversions grew to 3 \(baseline 2 at the merge-base\)/,
  );
});

test('R6 rejects a pair the merge-base does not have at all', () => {
  const violations = checkTypeInversions(inversionEdges(1), {});
  assert.equal(violations.length, 1);
  assert.match(
    violations[0]!.message,
    /new type-only commands -> client inversion \(1 edge\(s\), e\.g\. src\/commands\/typed-0\.ts -> src\/client\/client\.ts\); the merge-base has none/,
  );
});
