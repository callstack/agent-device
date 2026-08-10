// Reading a `run:` block into commands.

import assert from 'node:assert/strict';
import test from 'node:test';
import { context, lanesFor } from './test-context.ts';

test('an expression inside a command substitution is a value, not a dynamic command', () => {
  // `APP="$(find "${{ github.workspace }}/…")"` is an assignment. Reporting it as unresolved
  // dispatch would bury the real findings under noise from every fixture-locating step.
  const ctx = context({ packageScripts: new Map([['build', 'node scripts/build.ts']]) });
  const [lane] = lanesFor(
    {
      'ci.yml':
        'jobs:\n  gate:\n    steps:\n      - run: |\n' +
        '          APP="$(find "${{ github.workspace }}/.tmp" -name \'*.app\')"\n' +
        '          pnpm build\n',
    },
    ctx,
  );
  assert.deepEqual(lane!.unresolved, []);
  assert.deepEqual([...lane!.terminals], ['exec:scripts/build.ts']);
});

test('a substitution containing its own parentheses is removed whole', () => {
  const ctx = context({ packageScripts: new Map([['build', 'node scripts/build.ts']]) });
  const [lane] = lanesFor(
    {
      'ci.yml':
        'jobs:\n  gate:\n    steps:\n      - run: |\n' +
        '          V="$(node -p "require(\'./package.json\').version")"\n' +
        '          pnpm build\n',
    },
    ctx,
  );
  assert.deepEqual(lane!.unresolved, []);
  assert.deepEqual([...lane!.terminals], ['exec:scripts/build.ts']);
});

test('a shell comment is not read as a command, but a quoted # is left alone', () => {
  const ctx = context({ packageScripts: new Map([['build', 'node scripts/build.ts']]) });
  const [lane] = lanesFor(
    {
      'ci.yml':
        'jobs:\n  gate:\n    steps:\n      - run: |\n' +
        '          # pnpm not-a-real-script\n' +
        '          echo "# pnpm also-not-real"\n' +
        '          pnpm build\n',
    },
    ctx,
  );
  assert.deepEqual(lane!.unresolved, []);
  assert.deepEqual([...lane!.terminals], ['exec:scripts/build.ts']);
});
