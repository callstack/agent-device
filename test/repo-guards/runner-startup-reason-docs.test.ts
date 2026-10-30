import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { parseSync } from 'oxc-parser';

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

test('startup reason extraction includes alternate quotes, digits, hyphens and readiness spreads', () => {
  assert.deepEqual(
    startupFailureReasons(`
      export const RUNNER_DEVICE_READINESS_FAILURE_REASONS = ["ready-3"] as const;
      export const RUNNER_STARTUP_FAILURE_REASONS = [
        "phase-2", ...RUNNER_DEVICE_READINESS_FAILURE_REASONS,
      ] as const;
    `),
    ['phase-2', 'ready-3'],
  );
});

test('startup reason extraction rejects every unsupported member instead of dropping it', () => {
  for (const member of ['...UNKNOWN_REASONS', 'computeReason()', '42', ',']) {
    assert.throws(
      () =>
        startupFailureReasons(
          `export const RUNNER_STARTUP_FAILURE_REASONS = [${member}] as const;`,
        ),
      /unsupported member in RUNNER_STARTUP_FAILURE_REASONS/,
    );
  }
  assert.throws(
    () =>
      startupFailureReasons(`
      export const RUNNER_DEVICE_READINESS_FAILURE_REASONS = [...UNKNOWN_REASONS] as const;
      export const RUNNER_STARTUP_FAILURE_REASONS = [...RUNNER_DEVICE_READINESS_FAILURE_REASONS] as const;
    `),
    /unsupported member in RUNNER_DEVICE_READINESS_FAILURE_REASONS/,
  );
});

function startupFailureReasons(source: string): string[] {
  const parsed = parseSync(classificationPath, source);
  assert.deepEqual(parsed.errors, [], 'startup reason source must parse');
  const declarations = parsed.program.body.flatMap((statement) =>
    statement.type === 'ExportNamedDeclaration' &&
    statement.declaration?.type === 'VariableDeclaration'
      ? statement.declaration.declarations
      : [],
  );
  const startup = 'RUNNER_STARTUP_FAILURE_REASONS';
  const readiness = 'RUNNER_DEVICE_READINESS_FAILURE_REASONS';
  function members(name: string): string[] {
    const declaration = declarations.find(({ id }) => id.type === 'Identifier' && id.name === name);
    assert.ok(declaration, `missing exported declaration ${name}`);
    const initializer =
      declaration.init?.type === 'TSAsExpression' ? declaration.init.expression : declaration.init;
    assert.ok(initializer?.type === 'ArrayExpression', `${name} must be an array literal`);
    return initializer.elements.flatMap((member) => {
      if (member?.type === 'Literal' && typeof member.value === 'string') return [member.value];
      if (
        name === startup &&
        member?.type === 'SpreadElement' &&
        member.argument.type === 'Identifier' &&
        member.argument.name === readiness
      )
        return members(readiness);
      assert.fail(`unsupported member in ${name}: ${member?.type ?? 'array hole'}`);
    });
  }
  const reasons = members(startup);
  assert.ok(reasons.length > 0, 'the startup reason union must not be empty');
  return reasons;
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
