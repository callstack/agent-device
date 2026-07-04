import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';

// ADR 0011 Layer-2 guard: interaction response payloads have exactly ONE
// construction site — buildInteractionResponseData in
// interaction-touch-response.ts. A hand-rolled `responseData` branch is the
// class of bug that dropped fill @ref `evidence` (#1064 review): the branch
// compiles, ships, and silently misses a field its siblings carry. This test
// reads the touch interaction handler sources and fails when a `responseData`
// is assigned anything other than the shared builder's output, so a new
// branch cannot regress without tripping CI.

const HANDLERS_DIR = path.resolve(import.meta.dirname, '..');
const BUILDER_FILE = 'interaction-touch-response.ts';

function touchHandlerSourceFiles(): string[] {
  return fs
    .readdirSync(HANDLERS_DIR)
    .filter(
      (file) =>
        (file.startsWith('interaction-touch') || file === 'interaction-common.ts') &&
        file.endsWith('.ts') &&
        file !== BUILDER_FILE,
    );
}

// Allowed right-hand sides after `responseData:` / `responseData =`:
// - type annotations (`Record<...>`, `Promise<...>`)
// - the shared builder call
// - forwarding an already-built payload (bare identifier / member expression
//   immediately terminated, so `cond ? {...} : x` ternaries still fail)
const ALLOWED_RHS = [
  /^(?:Record|Promise)</,
  /^(?:await\s+)?buildInteractionResponseData\(/,
  /^[A-Za-z_$][\w.$]*\s*[,;})\]]/,
];

function findHandRolledResponseData(source: string): string[] {
  // Collapse whitespace so multi-line hand-rolled literals cannot hide.
  const collapsed = source.replace(/\s+/g, ' ');
  const offenders: string[] = [];
  const assignment = /\bresponseData\s*[:=]\s*/g;
  for (let match = assignment.exec(collapsed); match; match = assignment.exec(collapsed)) {
    const rhs = collapsed.slice(match.index + match[0].length, match.index + match[0].length + 160);
    if (!ALLOWED_RHS.some((pattern) => pattern.test(rhs))) {
      offenders.push(rhs.slice(0, 80));
    }
  }
  return offenders;
}

test('interaction responses are only constructed by buildInteractionResponseData', () => {
  const files = touchHandlerSourceFiles();
  assert.ok(
    files.includes('interaction-touch.ts'),
    'guard lost sight of interaction-touch.ts — update touchHandlerSourceFiles()',
  );
  const offenders: string[] = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(HANDLERS_DIR, file), 'utf8');
    for (const offender of findHandRolledResponseData(source)) {
      offenders.push(`${file}: responseData = ${offender}...`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Hand-rolled interaction responseData found. Route it through ` +
      `buildInteractionResponseData (${BUILDER_FILE}) so identity extras ` +
      `(evidence, refLabel, selectorChain, hints) cannot be dropped per-branch:\n` +
      offenders.map((offender) => `  - ${offender}`).join('\n'),
  );
});

test('the guard itself flags a hand-rolled responseData literal', () => {
  assert.equal(
    findHandRolledResponseData('const responseData = { ...backendResult, x, y };').length,
    1,
  );
  assert.equal(
    findHandRolledResponseData('const responseData = result.kind === "ref" ? { a: 1 } : built;')
      .length,
    1,
  );
  assert.equal(
    findHandRolledResponseData(
      'const responseData = buildInteractionResponseData({ source }).responseData;',
    ).length,
    0,
  );
  assert.equal(findHandRolledResponseData('finalize({ result, responseData });').length, 0);
});
