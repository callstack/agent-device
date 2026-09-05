import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseSync } from 'oxc-parser';
import { test } from 'vitest';

// ADR 0011 Layer-2 guard: interaction response payloads have exactly ONE
// construction site — buildInteractionResponseData in
// interaction-touch-response.ts. A hand-rolled `responseData` branch is the
// class of bug that dropped fill @ref `evidence` (#1064 review): the branch
// compiles, ships, and silently misses a field its siblings carry. This test
// reads the touch interaction handler sources and fails when a `responseData`
// is assigned anything other than the shared builder's output, so a new
// branch cannot regress without tripping CI.
//
// The press/click/longpress/hover/fill dispatch lives in
// handleInteractionCommands (interaction.ts). That switch is held to a
// stricter, structural rule: each touch case is exactly one `return await
// <touch handler>(...)`, so no response can be constructed there at all.

const INTERACTION_INTERNAL_DIR = path.resolve(import.meta.dirname, '..');
const BUILDER_FILE = 'interaction-touch-response.ts';
const DISPATCHER_FILE = 'interaction.ts';
const TOUCH_DISPATCH_COMMANDS = ['press', 'click', 'longpress', 'hover', 'fill'] as const;
const TOUCH_HANDLER_MODULE = /^\.\/interaction-touch[\w-]*\.ts$/;

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

type AstNode = Record<string, unknown> & { type: string };

function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';
}

function* walkAst(value: unknown): Generator<AstNode> {
  if (Array.isArray(value)) {
    for (const item of value) yield* walkAst(item);
    return;
  }
  if (!isAstNode(value)) return;
  yield value;
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'type') yield* walkAst(child);
  }
}

function touchHandlerImports(program: AstNode): Set<string> {
  const names = new Set<string>();
  for (const node of walkAst(program)) {
    if (node.type !== 'ImportDeclaration') continue;
    const source = node.source as AstNode;
    if (!TOUCH_HANDLER_MODULE.test(String(source.value))) continue;
    for (const specifier of node.specifiers as AstNode[]) {
      names.add(String((specifier.local as AstNode).name));
    }
  }
  return names;
}

function touchCommandOf(switchCase: AstNode): (typeof TOUCH_DISPATCH_COMMANDS)[number] | null {
  const literal = switchCase.test;
  if (!isAstNode(literal) || literal.type !== 'Literal') return null;
  const command = literal.value;
  return typeof command === 'string' &&
    (TOUCH_DISPATCH_COMMANDS as readonly string[]).includes(command)
    ? (command as (typeof TOUCH_DISPATCH_COMMANDS)[number])
    : null;
}

/** The callee of a case body that is exactly one `return await <callee>(...)`, else undefined. */
function awaitedCallee(switchCase: AstNode): AstNode | undefined {
  const [statement, ...rest] = switchCase.consequent as AstNode[];
  if (rest.length > 0 || statement?.type !== 'ReturnStatement') return undefined;
  const awaited = statement.argument;
  if (!isAstNode(awaited) || awaited.type !== 'AwaitExpression') return undefined;
  const call = awaited.argument;
  return isAstNode(call) && call.type === 'CallExpression' ? (call.callee as AstNode) : undefined;
}

/** The touch handler a case delegates to, or why it is not a pure delegation. */
function delegationOf(
  switchCase: AstNode,
  handlers: ReadonlySet<string>,
): { handler: string } | { violation: string } {
  const callee = awaitedCallee(switchCase);
  if (callee === undefined) {
    return { violation: 'the case body is not exactly one `return await <handler>(...)`' };
  }
  if (callee.type !== 'Identifier') {
    return { violation: 'the case calls something other than an imported touch handler' };
  }
  const handler = String(callee.name);
  return handlers.has(handler)
    ? { handler }
    : { violation: `\`${handler}\` is not imported from an interaction-touch*.ts handler` };
}

/**
 * Every touch command's case in the dispatcher must be one `return await <handler>(...)` to a
 * function imported from an interaction-touch*.ts module. Anything else — a nested switch, a
 * local `responseData`, an inline literal, a second statement — is a violation.
 */
function touchDispatchViolations(source: string): string[] {
  const program = parseSync(DISPATCHER_FILE, source).program as unknown as AstNode;
  const handlers = touchHandlerImports(program);
  const seen = new Map<string, number>();
  const violations: string[] = [];
  for (const node of walkAst(program)) {
    if (node.type !== 'SwitchCase') continue;
    const command = touchCommandOf(node);
    if (command === null) continue;
    seen.set(command, (seen.get(command) ?? 0) + 1);
    const delegation = delegationOf(node, handlers);
    if ('violation' in delegation) {
      violations.push(`case '${command}': ${delegation.violation}`);
    }
  }
  for (const command of TOUCH_DISPATCH_COMMANDS) {
    const count = seen.get(command) ?? 0;
    if (count !== 1)
      violations.push(`case '${command}': expected exactly one case, found ${count}`);
  }
  return violations;
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

test('every touch command case in the dispatcher only delegates to a touch handler', () => {
  const source = fs.readFileSync(path.join(INTERACTION_INTERNAL_DIR, DISPATCHER_FILE), 'utf8');
  const violations = touchDispatchViolations(source);
  assert.deepEqual(
    violations,
    [],
    `The touch dispatch switch in ${DISPATCHER_FILE} must only delegate. Move the logic into ` +
      `an interaction-touch-*.ts handler, which the responseData guard above scans:\n` +
      violations.map((violation) => `  - ${violation}`).join('\n'),
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

const DISPATCHER_PREAMBLE = `
import { dispatchFillViaRuntime } from './interaction-touch-fill.ts';
import { dispatchTargetedTouchViaRuntime } from './interaction-touch-press.ts';
import { dispatchGetViaRuntime } from '../../selector-runtime.ts';
`;

function dispatcher(cases: string): string {
  return `${DISPATCHER_PREAMBLE}
export async function handleInteractionCommands(params: any): Promise<unknown> {
  switch (params.req.command) {
    ${cases}
    case 'get':
      return await dispatchGetViaRuntime(params);
    default:
      return null;
  }
}
`;
}

const DELEGATING_CASES = `
    case 'press':
      return await dispatchTargetedTouchViaRuntime(params, 'press');
    case 'click':
      return await dispatchTargetedTouchViaRuntime(params, 'click');
    case 'longpress':
      return await dispatchTargetedTouchViaRuntime(params, 'longpress');
    case 'hover':
      return await dispatchTargetedTouchViaRuntime(params, 'hover');
    case 'fill':
      return await dispatchFillViaRuntime(params);
`;

test('the dispatcher guard accepts a switch whose touch cases only delegate', () => {
  assert.deepEqual(touchDispatchViolations(dispatcher(DELEGATING_CASES)), []);
});

test('the dispatcher guard rejects a hand-rolled responseData hidden behind a nested switch', () => {
  const source = dispatcher(
    DELEGATING_CASES.replace(
      `case 'press':\n      return await dispatchTargetedTouchViaRuntime(params, 'press');`,
      `case 'press': {
      switch (params.req.flags.mode) {
        case 'direct':
          break;
        default:
          break;
      }
      const responseData = { ...params.result, x: 1 };
      return await dispatchTargetedTouchViaRuntime({ ...params, responseData }, 'press');
    }`,
    ),
  );
  assert.deepEqual(touchDispatchViolations(source), [
    "case 'press': the case body is not exactly one `return await <handler>(...)`",
  ]);
});

test('the dispatcher guard rejects a touch case that returns something other than a handler call', () => {
  const inline = dispatcher(
    DELEGATING_CASES.replace(
      `return await dispatchFillViaRuntime(params);`,
      `return { ok: true, data: { responseData: {} } };`,
    ),
  );
  assert.deepEqual(touchDispatchViolations(inline), [
    "case 'fill': the case body is not exactly one `return await <handler>(...)`",
  ]);

  const foreign = dispatcher(
    DELEGATING_CASES.replace(
      `return await dispatchTargetedTouchViaRuntime(params, 'hover');`,
      `return await dispatchGetViaRuntime(params);`,
    ),
  );
  assert.deepEqual(touchDispatchViolations(foreign), [
    "case 'hover': `dispatchGetViaRuntime` is not imported from an interaction-touch*.ts handler",
  ]);
});

test('the dispatcher guard notices a touch command that left the switch', () => {
  const source = dispatcher(
    DELEGATING_CASES.replace(
      `case 'longpress':\n      return await dispatchTargetedTouchViaRuntime(params, 'longpress');`,
      '',
    ),
  );
  assert.deepEqual(touchDispatchViolations(source), [
    "case 'longpress': expected exactly one case, found 0",
  ]);
});
