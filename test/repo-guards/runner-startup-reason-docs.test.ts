import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { RUNNER_STARTUP_FAILURE_REASONS } from '../../packages/platform-apple/src/runner/runner-error-classification.ts';

/**
 * `error.details.reason` is a published vocabulary: a client that branches on it treats an
 * undocumented member as an unknown value. Nothing but this file connects the union to the two
 * surfaces that enumerate it, so a new reason added to the classifier has to be documented in the
 * same change. The reason union is the source of truth; the docs are read as text because they carry
 * the prose a reader follows, not a machine-readable list.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const classificationPath = path.join(
  repoRoot,
  'packages/platform-apple/src/runner/runner-error-classification.ts',
);
const installationDocPath = path.join(repoRoot, 'website/docs/docs/installation.md');
const cliHelpPath = path.join(repoRoot, 'src/commands/schema/cli-help.ts');

test('the runner startup reason union is documented in full at both prose surfaces', () => {
  assert.ok(
    RUNNER_STARTUP_FAILURE_REASONS.length > 0,
    'the startup reason union must not be empty',
  );

  for (const { surface, line } of [
    { surface: 'installation.md', line: startupReasonSentence(readFile(installationDocPath)) },
    { surface: 'cli-help.ts', line: startupReasonSentence(readFile(cliHelpPath)) },
  ]) {
    for (const reason of RUNNER_STARTUP_FAILURE_REASONS) {
      assert.ok(
        line.includes(reason),
        `${surface} must document the ${reason} reason: the union in ` +
          `${path.relative(repoRoot, classificationPath)} publishes it and a client cannot branch on ` +
          'a value it was never told exists.',
      );
    }
  }
});

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
