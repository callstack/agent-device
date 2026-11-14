import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

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

/** The members of `type RunnerReportedErrorReason`, each a quoted snake-case literal. */
function runnerReportedErrorReasons(contractText: string): string[] {
  const declaration = contractText.match(/type RunnerReportedErrorReason =([\s\S]*?);/);
  assert.ok(
    declaration !== undefined,
    'runner-contract.ts must declare the RunnerReportedErrorReason union: it is the published ' +
      'vocabulary this guard reads.',
  );
  const members: string[] = [];
  for (const [, member] of declaration[1]!.matchAll(/'([a-z_]+)'/g)) {
    if (member !== undefined) members.push(member);
  }
  assert.ok(
    members.length > 0,
    'RunnerReportedErrorReason declares no quoted reason member this reader can parse',
  );
  return members;
}

test('every runner refusal reason is documented in the command docs', () => {
  const reasons = runnerReportedErrorReasons(fs.readFileSync(contractPath, 'utf8'));
  const docs = fs.readFileSync(commandsDocPath, 'utf8');
  for (const reason of reasons) {
    assert.ok(
      docs.includes(reason),
      `commands.md must document the ${reason} reason: runner-contract.ts publishes it as ` +
        'details.reason and a client cannot branch on a value it was never told exists.',
    );
  }
});

test('reason extraction reads the union, not an arbitrary quoted literal', () => {
  assert.deepEqual(
    runnerReportedErrorReasons(`
      const UNRELATED = ['not_a_reason_member'];
      type RunnerReportedErrorReason =
        | 'runner_busy'
        | 'keyboard_dismiss_unavailable';
    `),
    ['runner_busy', 'keyboard_dismiss_unavailable'],
  );
});
