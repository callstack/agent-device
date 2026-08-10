import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contractsImplementationAuthorityViolations } from './contracts-implementation-policy.ts';

function messages(source: string, path = 'packages/contracts/src/planted.ts'): string[] {
  return contractsImplementationAuthorityViolations([{ path, source }]).map(
    (violation) => violation.message,
  );
}

test('contracts rejects host process and timer mechanics', () => {
  for (const source of [
    "import fs from 'node:fs';",
    "import { readFile } from 'fs/promises';",
    "import { spawn } from 'node:child_process';",
    "import { setTimeout as sleep } from 'node:timers/promises';",
    'setTimeout(work, 10);',
    'globalThis.setImmediate(work);',
    'clearInterval(timer);',
  ]) {
    assert.equal(messages(source).length, 1, source);
  }
});

test('contracts policy ignores type vocabulary, prose, tests, and capture-kit mechanics', () => {
  assert.deepEqual(
    messages(
      [
        'export type Timeout = { setTimeout: number };',
        'const prose = "import fs from \'node:fs\'; setTimeout(work, 10)";',
        '// clearInterval(timer);',
      ].join('\n'),
    ),
    [],
  );
  assert.deepEqual(messages("import fs from 'node:fs';", 'packages/contracts/src/a.test.ts'), []);
  assert.deepEqual(
    messages("import fs from 'node:fs';", 'packages/capture-kit/src/app-log-output.ts'),
    [],
  );
});
