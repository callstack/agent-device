import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceExecutionCompatibilityViolations } from './source-execution-policy.ts';

test('source-executed syntax rejects using declarations but ignores prose', () => {
  const violations = sourceExecutionCompatibilityViolations(
    new Map([
      [
        'packages/platform-apple/src/logs/planted.ts',
        `
          // await using oldHandle = acquire();
          const migrationNote = 'using replacement = acquire()';
          async function run() { await using handle = acquire(); }
          function runSync() { using cleanup = acquireSync(); }
        `,
      ],
    ]),
  );
  assert.deepEqual(
    violations.map(({ message }) => message),
    [
      'source-executed TypeScript uses unsupported await using declaration',
      'source-executed TypeScript uses unsupported using declaration',
    ],
  );
});
