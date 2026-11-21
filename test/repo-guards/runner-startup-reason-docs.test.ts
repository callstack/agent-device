import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { collectReasonTables } from '../../scripts/reasons/collect.ts';

/**
 * `error.details.reason` is a published vocabulary: a client that branches on it treats an
 * undocumented member as an unknown value. Nothing but this file connects the union to the two
 * surfaces that enumerate it, so a new reason added to the classifier has to be documented in the
 * same change. The reason table is the source of truth; the docs are read as text because they carry
 * the prose a reader follows, not a machine-readable list.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const classificationPath = path.join(
  repoRoot,
  'packages/apple-runner/src/runner-error-classification.ts',
);
const installationDocPath = path.join(repoRoot, 'website/docs/docs/installation.md');
const cliHelpPath = path.join(repoRoot, 'src/commands/schema/cli-help.ts');

test('the runner startup reason union is documented in full at both prose surfaces', () => {
  const reasons = startupFailureReasons(readFile(classificationPath));

  for (const { surface, line } of [
    { surface: 'installation.md', line: startupReasonSentence(readFile(installationDocPath)) },
    { surface: 'cli-help.ts', line: startupReasonSentence(readFile(cliHelpPath)) },
  ]) {
    for (const reason of reasons) {
      assert.ok(
        line.includes(reason),
        `${surface} must document the ${reason} reason: the union in ` +
          `${path.relative(repoRoot, classificationPath)} publishes it and a client cannot branch on ` +
          'a value it was never told exists.',
      );
    }
  }
});

/** The rows of the RUNNER_STARTUP_FAILURE_REASONS reason table, read as the reasons page reads them. */
function startupFailureReasons(source: string): string[] {
  const file = path.relative(repoRoot, classificationPath);
  const table = collectReasonTables(new Map([[file, source]])).find(
    ({ name }) => name === 'RUNNER_STARTUP_FAILURE_REASONS',
  );
  assert.ok(table, `${file} must declare the RUNNER_STARTUP_FAILURE_REASONS reason table`);
  assert.ok(table.rows.length > 0, 'the startup reason table must not be empty');
  return table.rows.map(({ reason }) => reason);
}

/** The sentence that enumerates the startup reasons, found on the same line at both surfaces. */
function startupReasonSentence(text: string): string {
  const line = text
    .split('\n')
    .find((candidate) => /error details\.reason|`error\.details\.reason`/.test(candidate));
  assert.ok(line, 'no sentence enumerating error.details.reason was found');
  return line;
}

function readFile(absolutePath: string): string {
  return fs.readFileSync(absolutePath, 'utf8');
}
