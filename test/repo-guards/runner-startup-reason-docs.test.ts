import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

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

/** The two reasons the device reports about itself, spread into the startup union. */
const DEVICE_READINESS_MEMBERS = 'RUNNER_DEVICE_READINESS_FAILURE_REASONS';

test('the runner startup reason union is documented in full at both prose surfaces', () => {
  const reasons = startupFailureReasons();

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

/**
 * Every member of `RUNNER_STARTUP_FAILURE_REASONS`, including the ones spread in from the
 * device-readiness list. Anything the two lists no longer read as fails rather than silently
 * shrinking the set the guard checks.
 */
function startupFailureReasons(): string[] {
  const source = readFile(classificationPath);
  const reasons: string[] = [];
  for (const member of literalMembers(source, 'RUNNER_STARTUP_FAILURE_REASONS')) {
    if (!member.startsWith('...')) {
      reasons.push(member);
      continue;
    }
    assert.equal(
      member,
      `...${DEVICE_READINESS_MEMBERS}`,
      `unknown spread in RUNNER_STARTUP_FAILURE_REASONS: ${member}`,
    );
    reasons.push(...literalMembers(source, DEVICE_READINESS_MEMBERS));
  }
  assert.ok(reasons.length > 0, 'the startup reason union must not read as empty');
  return reasons;
}

/** The members of one `export const X = [...] as const;` literal, in source order. */
function literalMembers(source: string, name: string): string[] {
  const declaration = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(source);
  assert.ok(declaration, `${name} no longer reads as a string-literal union`);
  return [...declaration[1]!.matchAll(/'([a-z_]+)'|\.\.\.([A-Z_]+)/g)].map((match) =>
    match[1] === undefined ? `...${match[2]}` : match[1]!,
  );
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
