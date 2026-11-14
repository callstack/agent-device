import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { parseSync } from 'oxc-parser';

/**
 * `error.details.reason` is a published vocabulary: a client that branches on it treats an
 * undocumented member as an unknown value. The runner refusal reasons are the members a caller reads to
 * decide whether resending is safe, so every member of the union in `runner-contract.ts` has to appear
 * in the command docs in the same change that adds it. Nothing else connects the union to the doc: the
 * classifier publishes the reason from a code, and the doc is prose a reader follows.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contractPath = path.join(repoRoot, 'packages/apple-runner/src/runner-contract.ts');
const commandsDocPath = path.join(repoRoot, 'website/docs/docs/commands.md');

test('every runner refusal reason is documented in the command docs', () => {
  const reasons = runnerReportedErrorReasons(readFile(contractPath));
  const docs = readFile(commandsDocPath);
  for (const reason of reasons) {
    assert.ok(
      docs.includes(reason),
      `commands.md must document the ${reason} reason: runner-contract.ts publishes it as ` +
        'details.reason and a client cannot branch on a value it was never told exists.',
    );
  }
});

test('reason extraction reads every member of the union, not the ones it recognises', () => {
  assert.deepEqual(
    runnerReportedErrorReasons(`
      const UNRELATED = ['not_a_reason_member'];
      type RunnerReportedErrorReason =
        | 'runner_busy'
        | 'keyboard-2'
        | 'keyboard_dismiss_unavailable';
    `),
    ['runner_busy', 'keyboard-2', 'keyboard_dismiss_unavailable'],
  );
});

test('reason extraction rejects every unsupported member instead of dropping it', () => {
  for (const member of ['RunnerBusy | OtherReason', 'OTHER_REASONS', 'string']) {
    assert.throws(
      () => runnerReportedErrorReasons(`type RunnerReportedErrorReason = ${member};`),
      /unsupported member in RunnerReportedErrorReason/,
    );
  }
  assert.throws(
    () => runnerReportedErrorReasons(`type RunnerReportedErrorReason = 'runner_busy' | string;`),
    /unsupported member in RunnerReportedErrorReason/,
  );
});

/** Every quoted literal of the `RunnerReportedErrorReason` union, read from the typed syntax. */
function runnerReportedErrorReasons(source: string): string[] {
  const parsed = parseSync(contractPath, source);
  assert.deepEqual(parsed.errors, [], 'reason source must parse');
  const declaration = parsed.program.body.find(
    (statement) =>
      statement.type === 'TSTypeAliasDeclaration' &&
      statement.id.type === 'Identifier' &&
      statement.id.name === 'RunnerReportedErrorReason',
  );
  assert.ok(
    declaration !== undefined && declaration.type === 'TSTypeAliasDeclaration',
    'runner-contract.ts must declare the RunnerReportedErrorReason union: it is the published ' +
      'vocabulary this guard reads.',
  );
  const union = declaration.typeAnnotation;
  const members = union.type === 'TSUnionType' ? union.types : [union];
  return members.map((member) => {
    assert.ok(
      member.type === 'TSLiteralType' &&
        member.literal.type === 'Literal' &&
        typeof member.literal.value === 'string',
      `unsupported member in RunnerReportedErrorReason: ${member.type}`,
    );
    return member.literal.value;
  });
}

function readFile(target: string): string {
  return fs.readFileSync(target, 'utf8');
}
