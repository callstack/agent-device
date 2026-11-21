import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  exportedConstObject,
  parseTs,
  readRepoFile,
  unwrapAssertion,
} from './runner-source-assertions.ts';

/**
 * `error.details.reason` is a published vocabulary: a client that branches on it treats an
 * undocumented member as an unknown value. Every exported typed published-reason table must have
 * each reason documented at the surfaces that enumerate it, in the same change that adds it.
 * Tables are read as typed syntax (oxc), so an unreadable member fails here instead of being dropped.
 */

type Surface = Readonly<{ name: string; relativePath: string }>;
type Kind = 'rows' | 'object' | 'union';
const commandsDoc: Surface = { name: 'commands.md', relativePath: 'website/docs/docs/commands.md' };
const cliHelpWorkflows: Surface = {
  name: 'cli-help-workflows.ts',
  relativePath: 'src/commands/schema/cli-help-workflows.ts',
};

const reasonTable = (
  name: string,
  relativePath: string,
  kind: Kind,
  surfaces: readonly Surface[] = [commandsDoc],
) => ({ name, relativePath, kind, surfaces });

const REASON_TABLES = [
  reasonTable('RUNNER_ERROR_CODES', 'packages/apple-runner/src/runner-contract.ts', 'rows'),
  reasonTable('PRE_DISPATCH_REFUSAL_REASONS', 'packages/kernel/src/errors.ts', 'rows'),
  reasonTable('SCROLL_REASONS', 'packages/contracts/src/scroll-reasons.ts', 'rows'),
  reasonTable(
    'ANDROID_SCREEN_RECORDING_REASONS',
    'packages/contracts/src/screen-recording-runtime-host.ts',
    'rows',
  ),
  reasonTable('WAIT_REASONS', 'packages/contracts/src/wait.ts', 'rows', [
    commandsDoc,
    cliHelpWorkflows,
  ]),
  reasonTable('DeviceClaimConflictReason', 'packages/contracts/src/device-inventory.ts', 'union'),
];

test('every reason of every exported published-reason table is documented at its surfaces', () => {
  for (const table of REASON_TABLES) {
    const reasons = readReasons(
      readRepoFile(table.relativePath),
      table.relativePath,
      table.name,
      table.kind,
    );
    assert.ok(reasons.length > 0, `${table.name} must declare at least one reason`);
    for (const surface of table.surfaces) {
      const docs = readRepoFile(surface.relativePath);
      for (const reason of reasons) {
        assert.ok(
          documentsReason(docs, reason),
          `${surface.name} must document the ${reason} reason: ${table.name} in ${table.relativePath} publishes it as details.reason.`,
        );
      }
    }
  }
});

test('a documented reason does not stand in for a longer undocumented one', () => {
  assert.ok(documentsReason('reports `back_swipe_no_change` here', 'back_swipe_no_change'));
  assert.ok(documentsReason('reason: DEVICE_CLAIM_LIVE_OWNER.', 'DEVICE_CLAIM_LIVE_OWNER'));
  assert.ok(!documentsReason('reports `back_swipe_no_change_extra`', 'back_swipe_no_change'));
  assert.ok(!documentsReason('reports `pre_back_swipe_no_change`', 'back_swipe_no_change'));
  assert.ok(!documentsReason('reports back-swipe_no_change-x', 'swipe_no_change'));
  assert.ok(!documentsReason('reports `DEVICE_CLAIM_LIVE_OWNER_EXTRA`', 'DEVICE_CLAIM_LIVE_OWNER'));
});

test('the extractors read every member and reject unsupported ones instead of dropping them', () => {
  const read = (source: string, name: string, kind: Kind) =>
    readReasons(source, 'fixture.ts', name, kind);
  const expectRead = (source: string, name: string, kind: Kind, expected: string[]) =>
    assert.deepEqual(read(source, name, kind), expected);
  const expectReject = (source: string, name: string, kind: Kind, pattern: RegExp) =>
    assert.throws(() => read(source, name, kind), pattern);

  expectRead(
    `export const RUNNER_ERROR_CODES = {
      RUNNER_BUSY: { dispatched: 'no', reason: 'runner_busy' },
      RUNNER_WEDGED: { dispatched: 'no' },
    } as const satisfies Record<string, RunnerErrorCodeRow>;`,
    'RUNNER_ERROR_CODES',
    'rows',
    ['runner_busy'],
  );
  expectReject(
    `export const RUNNER_ERROR_CODES = { RUNNER_BUSY: { dispatched: 'no', reason: R.busy } } as const satisfies Record<string, RunnerErrorCodeRow>;`,
    'RUNNER_ERROR_CODES',
    'rows',
    /unsupported reason in RUNNER_ERROR_CODES row RUNNER_BUSY/,
  );
  expectRead(
    `export const R = { busy: { reason: 'runner_busy' } } as const satisfies ReasonTable<'r'>;
    export const RUNNER_ERROR_CODES = { RUNNER_BUSY: { dispatched: 'no', reason: R.busy.reason } } as const satisfies Record<string, RunnerErrorCodeRow>;`,
    'RUNNER_ERROR_CODES',
    'rows',
    ['runner_busy'],
  );
  expectRead(
    `export const WAIT_REASONS = { captureStalled: 'wait_capture_stalled', deadlineExceeded: "wait_deadline_exceeded" } as const;`,
    'WAIT_REASONS',
    'object',
    ['wait_capture_stalled', 'wait_deadline_exceeded'],
  );
  for (const member of ['computeReason()']) {
    expectReject(
      `export const WAIT_REASONS = { a: ${member} } as const;`,
      'WAIT_REASONS',
      'object',
      /unsupported member in WAIT_REASONS/,
    );
  }
  expectRead(
    `export type DeviceClaimConflictReason = 'DEVICE_CLAIM_LIVE_OWNER' | 'DEVICE_CLAIM_OWNER_UNCERTAIN';`,
    'DeviceClaimConflictReason',
    'union',
    ['DEVICE_CLAIM_LIVE_OWNER', 'DEVICE_CLAIM_OWNER_UNCERTAIN'],
  );
  for (const member of ['string']) {
    expectReject(
      `export type DeviceClaimConflictReason = ${member};`,
      'DeviceClaimConflictReason',
      'union',
      /unsupported member in DeviceClaimConflictReason/,
    );
  }
});

/** Whether `docs` names `reason` as a whole token, so a longer reason that extends it does not count. */
function documentsReason(docs: string, reason: string): boolean {
  assert.match(reason, /^[A-Za-z0-9_-]+$/, 'a reason is a token, so it needs no escaping');
  return new RegExp(`(?<![A-Za-z0-9_-])${reason}(?![A-Za-z0-9_-])`).test(docs);
}

/** Reads a published-reason table's members from the typed syntax, failing on anything unreadable. */
function readReasons(
  source: string,
  filename: string,
  name: string,
  kind: 'rows' | 'object' | 'union',
): string[] {
  const parsed = parseTs(filename, source);
  if (kind === 'union') return readUnionReasons(parsed, filename, name);
  return readTableReasons(parsed, name, kind);
}

/** The string members of an exported `type Name = 'a' | 'b'` union. */
function readUnionReasons(
  parsed: ReturnType<typeof parseTs>,
  filename: string,
  name: string,
): string[] {
  const aliases = parsed.program.body.flatMap((statement) =>
    statement.type === 'ExportNamedDeclaration' &&
    statement.declaration?.type === 'TSTypeAliasDeclaration'
      ? [statement.declaration]
      : [],
  );
  const alias = aliases.find(
    (candidate) => candidate.id.type === 'Identifier' && candidate.id.name === name,
  );
  assert.ok(alias !== undefined, `${filename} must export the ${name} union.`);
  const annotation = alias.typeAnnotation;
  const members = annotation.type === 'TSUnionType' ? annotation.types : [annotation];
  return members.map((member) => {
    assert.ok(
      member.type === 'TSLiteralType' &&
        member.literal.type === 'Literal' &&
        typeof member.literal.value === 'string',
      `unsupported member in ${name}: ${member.type}`,
    );
    return member.literal.value;
  });
}

/**
 * The reasons of an exported const table: each row's `reason`, or each member's literal. A row may
 * read its reason from a reason table in the same file as `TABLE.member.reason`.
 */
function readTableReasons(
  parsed: ReturnType<typeof parseTs>,
  name: string,
  kind: 'rows' | 'object',
): string[] {
  return exportedConstObject(parsed, name).properties.flatMap((property: any) => {
    assert.ok(
      property.type === 'Property' && property.key.type === 'Identifier',
      `unsupported member in ${name}: ${property.type}`,
    );
    return kind === 'object'
      ? [objectMemberReason(property, name)]
      : rowReasons(parsed, property, name);
  });
}

/** A member whose value is the reason literal itself. */
function objectMemberReason(property: any, name: string): string {
  assert.ok(
    property.value.type === 'Literal' && typeof property.value.value === 'string',
    `unsupported member in ${name}: ${property.value.type}`,
  );
  return property.value.value;
}

/** The `reason` of a row object: a literal, or `TABLE.member.reason` from a table in the same file. */
function rowReasons(parsed: ReturnType<typeof parseTs>, property: any, name: string): string[] {
  const row = unwrapAssertion(property.value);
  assert.ok(
    row?.type === 'ObjectExpression',
    `unsupported row in ${name} for ${property.key.name}: ${row?.type ?? 'none'}`,
  );
  return row.properties
    .filter(
      (member: any) =>
        member.type === 'Property' &&
        member.key.type === 'Identifier' &&
        member.key.name === 'reason',
    )
    .map((member: any) => {
      const reason =
        member.value.type === 'Literal' && typeof member.value.value === 'string'
          ? member.value.value
          : readReferencedReason(parsed, member.value);
      assert.ok(
        reason !== undefined,
        `unsupported reason in ${name} row ${property.key.name}: ${member.value.type}`,
      );
      return reason;
    });
}

/** The reason `TABLE.member.reason` names, read from the row of an exported table in `parsed`. */
function readReferencedReason(parsed: ReturnType<typeof parseTs>, node: any): string | undefined {
  const row = node?.type === 'MemberExpression' && !node.computed ? node.object : undefined;
  const table = row?.type === 'MemberExpression' && !row.computed ? row.object : undefined;
  if (node?.property?.name !== 'reason' || table?.type !== 'Identifier') return undefined;
  const named = exportedConstObject(parsed, table.name).properties.find(
    (property: any) => property.key?.name === row.property.name,
  );
  const field = unwrapAssertion(named?.value)?.properties?.find(
    (property: any) => property.key?.name === 'reason',
  );
  return field?.value?.type === 'Literal' && typeof field.value.value === 'string'
    ? field.value.value
    : undefined;
}
