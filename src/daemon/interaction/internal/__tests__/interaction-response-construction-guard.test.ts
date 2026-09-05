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

const INTERACTION_INTERNAL_DIR = path.resolve(import.meta.dirname, '..');
const BUILDER_FILE = 'interaction-touch-response.ts';

// The press/click/longpress/hover/fill switch lives inline in
// handleInteractionCommands (interaction.ts) rather than in a
// interaction-touch*.ts-named file, so the name-prefix scan below cannot see
// it. interaction.ts also hosts unrelated commands (e.g. `type`) that
// legitimately hand-roll their own responseData outside this guard's scope,
// so the whole file cannot simply be added to touchHandlerSourceFiles() —
// instead the touch dispatch switch's case bodies are extracted and scanned
// on their own, below.
const DISPATCHER_FILE = 'interaction.ts';
const TOUCH_DISPATCH_COMMANDS = ['press', 'click', 'longpress', 'hover', 'fill'];

function touchHandlerSourceFiles(): string[] {
  return fs
    .readdirSync(INTERACTION_INTERNAL_DIR)
    .filter(
      (file) =>
        (file.startsWith('interaction-touch') || file === 'interaction-common.ts') &&
        file.endsWith('.ts') &&
        file !== BUILDER_FILE,
    );
}

function touchDispatchCaseBodies(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const command of TOUCH_DISPATCH_COMMANDS) {
    const caseMatch = new RegExp(
      `case '${command}':([\\s\\S]*?)(?=\\n\\s*(?:case |default:))`,
    ).exec(source);
    const body = caseMatch?.[1];
    if (body !== undefined) {
      bodies.set(command, body);
    }
  }
  return bodies;
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
  const collapsed = source.replaceAll(/\s+/g, ' ');
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
    files.includes('interaction-touch-press.ts'),
    'guard lost sight of interaction-touch-press.ts — update touchHandlerSourceFiles()',
  );
  const offenders: string[] = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(INTERACTION_INTERNAL_DIR, file), 'utf8');
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

test('the touch dispatch switch in interaction.ts only delegates (no local responseData)', () => {
  const source = fs.readFileSync(path.join(INTERACTION_INTERNAL_DIR, DISPATCHER_FILE), 'utf8');
  const bodies = touchDispatchCaseBodies(source);
  assert.deepEqual(
    [...bodies.keys()].sort(),
    [...TOUCH_DISPATCH_COMMANDS].sort(),
    `guard lost sight of one or more touch commands in ${DISPATCHER_FILE}'s switch — ` +
      `update touchDispatchCaseBodies()/TOUCH_DISPATCH_COMMANDS`,
  );
  const offenders: string[] = [];
  for (const [command, body] of bodies) {
    for (const offender of findHandRolledResponseData(body)) {
      offenders.push(`${DISPATCHER_FILE} (case '${command}'): responseData = ${offender}...`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Hand-rolled interaction responseData found in the touch dispatch switch. Route it ` +
      `through buildInteractionResponseData (${BUILDER_FILE}) instead, or move the logic ` +
      `into a dedicated interaction-touch-*.ts handler so the whole-file guard above can ` +
      `scan it:\n` +
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
